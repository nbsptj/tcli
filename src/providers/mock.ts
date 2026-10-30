import type { Provider, ProviderFactoryOptions, ProviderRequest, StreamEvent } from "./types.ts";
import { emptyUsage } from "../types.ts";
import { estimateTokens } from "../utils/tokens.ts";
import { parseJsonLoose } from "../utils/json.ts";

const TOOL_MARKER = /\[\[tool:([A-Za-z0-9_.-]+)\s*(\{[\s\S]*?\})?\]\]/g;

/**
 * Deterministic offline provider for demos and smoke tests.
 *
 * If the last user message contains `[[tool:name {"json":"args"}]]` markers it
 * requests those tools; otherwise it echoes a short explanation. This is not
 * meant for real work — it exists so the CLI/TUI can be exercised without an
 * API key or network.
 */
export class MockProvider implements Provider {
  readonly id: string;
  readonly type = "mock";
  readonly model: string;

  constructor(cfg: ProviderFactoryOptions) {
    this.id = cfg.id;
    this.model = cfg.model;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown> {
    if (req.signal.aborted) {
      yield { type: "error", error: new Error("aborted"), retryable: false };
      return;
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const input = lastUser?.content ?? "";
    const lastMessage = req.messages[req.messages.length - 1];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const match of lastMessage?.role === "tool" ? [] : input.matchAll(TOOL_MARKER)) {
      const name = match[1]!;
      const rawArgs = match[2] ?? "{}";
      const parsed = parseJsonLoose<Record<string, unknown>>(rawArgs);
      calls.push({ name, args: parsed.ok && parsed.value ? parsed.value : {} });
    }
    if (calls.length) {
      for (const [i, call] of calls.entries()) {
        yield {
          type: "tool_call",
          toolCall: {
            id: `mock_call_${i}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.args,
          },
        };
      }
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    const scripted = process.env.TCLI_MOCK_RESPONSE;
    const sawToolResult = req.messages.some((m) => m.role === "tool");
    const text =
      scripted ??
      (sawToolResult
        ? "Mock provider: tool execution finished. Configure a real model with `tcli init` or ~/.tcli/config.json for real reasoning."
        : input.trim()
          ? `Mock provider active (no network call was made).\n\nYou said: ${input.slice(0, 400)}\n\nConfigure a real provider with \`tcli init\` or ~/.tcli/config.json to let the agent use tools.`
          : "Mock provider ready. Type a task to see the agent loop, or configure a real provider.");
    // Stream in small chunks to exercise the renderer.
    for (let i = 0; i < text.length; i += 32) {
      if (req.signal.aborted) {
        yield { type: "error", error: new Error("aborted"), retryable: false };
        return;
      }
      yield { type: "text", text: text.slice(i, i + 32) };
    }
    const usage = emptyUsage();
    usage.inputTokens = estimateTokens(input);
    usage.outputTokens = estimateTokens(text);
    yield { type: "usage", usage };
    yield { type: "stop", reason: "end" };
  }
}
