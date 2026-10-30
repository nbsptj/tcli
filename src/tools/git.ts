import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { displayPath, resolveUserPath } from "../utils/paths.ts";
import { filterEnv } from "../utils/env.ts";
import { runCommand } from "../utils/process.ts";
import { truncateOutput } from "../utils/truncate.ts";

const GitStatusArgs = z.strictObject({
  path: z.string().optional().describe("Optional repository subdirectory (default: workspace root)."),
});

const GitDiffArgs = z.strictObject({
  path: z.string().optional().describe("Limit the diff to this file or directory."),
  staged: z.boolean().optional().describe("Show staged (index) changes instead of working tree changes."),
  context_lines: z.number().int().min(0).max(20).optional().describe("Unified diff context lines (default 3)."),
});

function gitEnv(): Record<string, string> {
  // Keep git prompts out of non-interactive tool calls.
  return { ...filterEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
}

async function gitCommand(
  ctx: ToolContext,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const result = await runCommand({
    cmd: ["git", "-C", cwd, ...args],
    cwd,
    env: gitEnv(),
    signal: ctx.signal,
    timeoutMs: 30_000,
    maxBytes: ctx.config.tools.limits.maxBytes,
    stripAnsiOutput: true,
  });
  if (result.exitCode !== 0) {
    const message = (result.stderr || result.stdout).trim();
    if (/not a git repository/i.test(message)) {
      return { ok: false, output: "", error: `Not a git repository: ${displayPath(cwd, ctx.cwd)}` };
    }
    return { ok: false, output: result.stdout, error: message || `git exited with code ${result.exitCode}` };
  }
  return { ok: true, output: result.stdout };
}

export const gitStatusTool = defineTool({
  name: "git_status",
  description: "Show git working-tree status (branch, staged/unstaged/untracked files). Read-only.",
  schema: GitStatusArgs,
  kind: "read",
  async permissionInfo(input, ctx) {
    return { paths: [resolveUserPath(ctx.cwd, input.path ?? ".")] };
  },
  async execute(input, ctx: ToolContext) {
    const cwd = resolveUserPath(ctx.cwd, input.path ?? ".");
    const result = await gitCommand(ctx, ["status", "--porcelain=v1", "-b"], cwd);
    if (!result.ok) return { content: result.error ?? "git status failed", isError: true };
    const text = result.output.trim();
    return {
      content: text || "Working tree clean.",
      display: { summary: `git status (${text ? text.split("\n").length : 0} lines)` },
    };
  },
});

export const gitDiffTool = defineTool({
  name: "git_diff",
  description: "Show a unified git diff (working tree or staged). Read-only. Commits and other git writes must use bash with confirmation.",
  schema: GitDiffArgs,
  kind: "read",
  async permissionInfo(input, ctx) {
    return { paths: [resolveUserPath(ctx.cwd, input.path ?? ".")] };
  },
  async execute(input, ctx: ToolContext) {
    const cwd = ctx.cwd;
    const args = ["diff", "--no-color", `-U${input.context_lines ?? 3}`];
    if (input.staged) args.push("--staged");
    if (input.path) args.push("--", input.path);
    const result = await gitCommand(ctx, args, cwd);
    if (!result.ok) return { content: result.error ?? "git diff failed", isError: true };
    const text = result.output.trimEnd();
    const truncated = truncateOutput(text || "(no changes)", {
      maxLines: ctx.config.tools.limits.maxLines,
      maxBytes: ctx.config.tools.limits.maxBytes,
    });
    return {
      content: truncated.text,
      display: { summary: `git diff${input.staged ? " --staged" : ""}${input.path ? ` ${input.path}` : ""}` },
      metadata: { truncated: truncated.truncated },
    };
  },
});
