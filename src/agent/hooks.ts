import type { HooksConfig, HookConfig } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";
import { filterEnv } from "../utils/env.ts";
import { matchGlob } from "../utils/glob.ts";
import { runCommand } from "../utils/process.ts";
import { redactSecrets } from "../utils/redact.ts";
import { truncateText } from "../utils/strings.ts";
import { parseJsonLoose } from "../utils/json.ts";

export interface PreToolHookResult {
  decision?: "allow" | "ask" | "deny";
  reason?: string;
  input?: Record<string, unknown>;
}

interface HookOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  decision?: "allow" | "ask" | "deny";
  reason?: string;
  input?: Record<string, unknown>;
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher) return true;
  return matchGlob(matcher, tool);
}

/**
 * Runs user-configured shell hooks (EX-3).
 *
 * Hooks receive a JSON payload on stdin and TCLI_* environment variables. For
 * preToolUse, exit code 2 or `{"decision":"deny"}` blocks the call; `ask`
 * upgrades an allow decision to a confirmation; `input` can replace arguments.
 * Other hook failures are logged and ignored so a broken hook cannot brick the
 * agent, except for the explicit exit-code-2 block.
 */
export class HookRunner {
  private readonly config: HooksConfig;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly logger: Logger;

  constructor(opts: { hooks: HooksConfig; cwd: string; sessionId: string; logger: Logger }) {
    this.config = opts.hooks;
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.logger = opts.logger;
  }

  private async execute(
    def: HookConfig,
    event: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookOutput> {
    const env: Record<string, string> = {
      ...filterEnv(process.env),
      TCLI_EVENT: event,
      TCLI_SESSION_ID: this.sessionId,
      TCLI_CWD: this.cwd,
      TCLI_HOOK: def.command.slice(0, 200),
    };
    if (typeof payload.tool === "string") env.TCLI_TOOL = payload.tool;
    const result = await runCommand({
      cmd: ["bash", "-c", def.command],
      cwd: this.cwd,
      env,
      stdin: JSON.stringify(payload),
      timeoutMs: def.timeoutMs ?? 10_000,
      maxBytes: 32_768,
      signal,
      stripAnsiOutput: true,
    });
    let decision: HookOutput["decision"];
    let reason: string | undefined;
    let input: Record<string, unknown> | undefined;
    const text = result.stdout.trim();
    if (text.startsWith("{")) {
      const parsed = parseJsonLoose<{ decision?: unknown; reason?: unknown; input?: unknown }>(text);
      if (parsed.ok && parsed.value && typeof parsed.value === "object") {
        const d = parsed.value.decision;
        if (d === "allow" || d === "ask" || d === "deny") decision = d;
        if (typeof parsed.value.reason === "string") reason = parsed.value.reason;
        if (parsed.value.input && typeof parsed.value.input === "object" && !Array.isArray(parsed.value.input)) {
          input = parsed.value.input as Record<string, unknown>;
        }
      }
    }
    if (result.exitCode === 2 && !decision) {
      decision = "deny";
      reason = reason ?? (result.stderr.trim() || env.TCLI_HOOK || "blocked by hook");
    }
    if (result.exitCode !== 0 && result.exitCode !== 2) {
      this.logger.warn("hook failed", {
        event,
        command: truncateText(def.command, 120),
        exitCode: result.exitCode,
        stderr: truncateText(redactSecrets(result.stderr).text, 500),
      });
    }
    if (result.stdout.trim() || result.stderr.trim()) {
      this.logger.debug("hook output", {
        event,
        stdout: truncateText(redactSecrets(result.stdout).text, 1000),
        stderr: truncateText(redactSecrets(result.stderr).text, 1000),
      });
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, decision, reason, input };
  }

  private defs(event: keyof HooksConfig): HookConfig[] {
    return this.config[event] ?? [];
  }

  async sessionStart(signal?: AbortSignal): Promise<void> {
    for (const def of this.defs("sessionStart")) {
      await this.execute(def, "sessionStart", { event: "sessionStart", sessionId: this.sessionId, cwd: this.cwd }, signal);
    }
  }

  async sessionEnd(signal?: AbortSignal): Promise<void> {
    for (const def of this.defs("sessionEnd")) {
      await this.execute(def, "sessionEnd", { event: "sessionEnd", sessionId: this.sessionId, cwd: this.cwd }, signal);
    }
  }

  async preTool(
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PreToolHookResult> {
    let result: PreToolHookResult = {};
    for (const def of this.defs("preToolUse")) {
      if (!matches(def.matcher, tool)) continue;
      const output = await this.execute(
        def,
        "preToolUse",
        { event: "preToolUse", tool, input, sessionId: this.sessionId, cwd: this.cwd },
        signal,
      );
      if (output.input) {
        input = output.input;
        result.input = output.input;
      }
      if (output.decision === "deny") {
        return { ...result, decision: "deny", reason: output.reason ?? "denied by preToolUse hook" };
      }
      if (output.decision === "ask") {
        result.decision = "ask";
        result.reason = output.reason;
      }
    }
    return result;
  }

  async postTool(
    tool: string,
    input: Record<string, unknown>,
    result: { ok: boolean; summary: string },
    signal?: AbortSignal,
  ): Promise<void> {
    for (const def of this.defs("postToolUse")) {
      if (!matches(def.matcher, tool)) continue;
      await this.execute(
        def,
        "postToolUse",
        {
          event: "postToolUse",
          tool,
          input,
          ok: result.ok,
          summary: truncateText(result.summary, 800),
          sessionId: this.sessionId,
          cwd: this.cwd,
        },
        signal,
      );
    }
  }
}
