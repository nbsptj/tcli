import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { displayPath, resolveUserPath } from "../utils/paths.ts";
import { statSafe } from "../utils/fs.ts";
import { filterEnv } from "../utils/env.ts";
import { runCommand } from "../utils/process.ts";
import { redactSecrets } from "../utils/redact.ts";
import { truncateOutput } from "../utils/truncate.ts";
import { wrapSandboxedCommand } from "../sandbox/wrap.ts";

const BashArgs = z.strictObject({
  command: z.string().min(1).describe("Shell command to run with bash -c (non-interactive)."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Timeout in milliseconds (default from config, usually 120000)."),
  cwd: z.string().optional().describe("Working directory (default: workspace root)."),
});

export const bashTool = defineTool({
  name: "bash",
  description:
    "Run a non-interactive shell command with bash -c, capturing stdout/stderr and the exit code. " +
    "The command runs in the workspace with credential-like environment variables filtered out, a timeout, " +
    "and is killed as a process tree on timeout or interruption. Use for builds, tests, git and scripts.",
  schema: BashArgs,
  kind: "exec",
  async permissionInfo(input, ctx) {
    return {
      command: input.command,
      paths: input.cwd ? [resolveUserPath(ctx.cwd, input.cwd)] : [],
    };
  },
  async preview(input, ctx) {
    const cwd = input.cwd ? displayPath(resolveUserPath(ctx.cwd, input.cwd), ctx.cwd) : ".";
    return `Shell command (cwd: ${cwd}):\n\n$ ${input.command}\n\nTimeout: ${input.timeout_ms ?? ctx.config.tools.bash.timeoutMs}ms`;
  },
  async execute(input, ctx: ToolContext) {
    const cwd = resolveUserPath(ctx.cwd, input.cwd ?? ".");
    const stat = statSafe(cwd);
    if (!stat?.isDirectory()) {
      return { content: `Working directory not found: ${displayPath(cwd, ctx.cwd)}`, isError: true };
    }
    const timeoutMs = Math.min(input.timeout_ms ?? ctx.config.tools.bash.timeoutMs, 600_000);
    const env = filterEnv(process.env, ctx.config.tools.bash.envPassthrough);
    const sandboxed = wrapSandboxedCommand(input.command, {
      mode: ctx.config.sandbox.mode,
      network: ctx.config.sandbox.network,
      cwd,
    });
    if (sandboxed.error) {
      return { content: sandboxed.error, isError: true };
    }
    ctx.logger.debug("bash spawn", {
      sessionId: ctx.sessionId,
      cmd: sandboxed.cmd[0],
      cwd,
      timeoutMs,
      sandbox: ctx.config.sandbox.mode,
    });
    const result = await runCommand({
      cmd: sandboxed.cmd,
      cwd,
      env,
      signal: ctx.signal,
      timeoutMs,
      maxBytes: ctx.config.tools.limits.maxBytes,
      stripAnsiOutput: true,
    });
    const stdout = redactSecrets(result.stdout);
    const stderr = redactSecrets(result.stderr);
    const redactedCount = stdout.count + stderr.count;
    const parts: string[] = [];
    if (result.timedOut) parts.push(`Command timed out after ${timeoutMs}ms; the process tree was terminated.`);
    if (result.aborted) parts.push("Command aborted; the process tree was terminated.");
    parts.push(`exit_code: ${result.exitCode}`);
    parts.push(`duration_ms: ${result.durationMs}`);
    if (stdout.text.trim()) parts.push(`stdout:\n${stdout.text.replace(/\n+$/, "")}`);
    if (stderr.text.trim()) parts.push(`stderr:\n${stderr.text.replace(/\n+$/, "")}`);
    if (!stdout.text.trim() && !stderr.text.trim()) parts.push("(no output)");
    if (redactedCount > 0) parts.push(`[tcli: redacted ${redactedCount} secret-like value(s)]`);
    if (result.truncated) parts.push("[tcli: output was capped while streaming]");
    const truncated = truncateOutput(parts.join("\n"), {
      maxLines: ctx.config.tools.limits.maxLines,
      maxBytes: ctx.config.tools.limits.maxBytes,
    });
    const failed = result.exitCode !== 0 || result.timedOut || result.aborted;
    return {
      content: truncated.text,
      isError: failed,
      display: {
        summary: `$ ${input.command.split("\n")[0]!.slice(0, 120)} · exit ${result.exitCode} · ${result.durationMs}ms`,
      },
      metadata: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        truncated: truncated.truncated || result.truncated,
      },
    };
  },
});
