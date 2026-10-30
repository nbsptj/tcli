import { AbortError, ProviderError } from "../utils/errors.ts";
import type { ChatMessage, StopReason, Usage } from "../types.ts";
import { TCLI_VERSION, emptyUsage } from "../types.ts";
import { parseSse } from "./sse.ts";
import {
  debugRequest,
  debugResponse,
  debugStream,
  fetchWithTimeout,
  finalizeToolArguments,
  joinEndpoint,
  mergeHeaders,
  responseError,
} from "./http.ts";
import type { Provider, ProviderFactoryOptions, ProviderRequest, StreamEvent } from "./types.ts";

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content || "(no output)",
          ...(message.isError ? { is_error: true } : {}),
        },
      ]);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
      }
      push("assistant", blocks);
      continue;
    }
    if (message.content.trim()) push("user", [{ type: "text", text: message.content }]);
  }
  // Anthropic accepts an optional leading assistant turn; keep it.
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return "end";
  }
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

/** Anthropic Messages API provider (native tool use + streaming). */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly type = "anthropic";
  readonly model: string;
  private readonly cfg: ProviderFactoryOptions;

  constructor(cfg: ProviderFactoryOptions) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.model = cfg.model;
  }

  private headers(): Record<string, string> {
    return mergeHeaders(
      {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "user-agent": `tcli/${TCLI_VERSION}`,
      },
      this.cfg.apiKey ? { "x-api-key": this.cfg.apiKey } : undefined,
      this.cfg.headers,
    );
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const url = joinEndpoint(this.cfg.baseUrl, "/messages");
    const converted = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      temperature: Math.min(1, Math.max(0, req.temperature)),
      stream: true,
      messages: converted.messages,
    };
    if (converted.system) body.system = converted.system;
    if (req.tools.length) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    debugRequest(req.onDebug, { provider: this.id, url, body });
    const res = await fetchWithTimeout(
      url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      this.cfg.timeoutMs,
      req.signal,
    );
    debugResponse(req.onDebug, {
      provider: this.id,
      url,
      status: res.status,
      contentType: res.headers.get("content-type"),
    });
    if (!res.ok) throw await responseError(res);
    if (!res.body) throw new ProviderError("Anthropic returned an empty response body", { retryable: true });

    const usage: Usage = emptyUsage();
    let stopReason: string | null = null;
    let sawMessageStop = false;
    const blocks = new Map<number, { type: string; id?: string; name?: string; args: string }>();

    for await (const message of parseSse(res.body)) {
      if (req.signal.aborted) throw new AbortError("Request aborted");
      if (!message.data.trim()) continue;
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(message.data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      debugStream(req.onDebug, event);
      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage;
          if (u) {
            usage.inputTokens =
              (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          }
          break;
        }
        case "content_block_start": {
          const index = event.index ?? 0;
          const block = event.content_block;
          if (!block) break;
          if (block.type === "tool_use") {
            blocks.set(index, {
              type: "tool_use",
              id: block.id,
              name: block.name,
              args:
                block.input && typeof block.input === "object" && Object.keys(block.input as object).length > 0
                  ? JSON.stringify(block.input)
                  : "",
            });
          } else if (block.type === "text") {
            if (block.text) yield { type: "text", text: block.text };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (!delta) break;
          if (delta.type === "text_delta" && delta.text) yield { type: "text", text: delta.text };
          else if (delta.type === "thinking_delta" && delta.thinking) {
            yield { type: "reasoning", text: delta.thinking };
          } else if (delta.type === "input_json_delta") {
            const index = event.index ?? 0;
            const block = blocks.get(index);
            if (block) block.args += delta.partial_json ?? "";
          }
          break;
        }
        case "content_block_stop": {
          const index = event.index ?? 0;
          const block = blocks.get(index);
          if (block?.type === "tool_use" && block.name) {
            yield {
              type: "tool_call",
              toolCall: {
                id: block.id ?? `toolu_${index}_${Math.random().toString(36).slice(2, 8)}`,
                name: block.name,
                arguments: finalizeToolArguments(block.args, block.name),
              },
            };
          }
          break;
        }
        case "message_delta": {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage?.output_tokens !== undefined) usage.outputTokens = event.usage.output_tokens;
          break;
        }
        case "message_stop": {
          sawMessageStop = true;
          break;
        }
        case "error": {
          const message = event.error?.message ?? JSON.stringify(event.error);
          const type = event.error?.type ?? "";
          throw new ProviderError(`Anthropic stream error: ${message}`, {
            retryable: type === "overloaded_error" || type === "rate_limit_error" || type === "api_error",
            code: "STREAM_ERROR",
          });
        }
        default:
          break;
      }
    }

    yield { type: "usage", usage };
    yield { type: "stop", reason: mapStopReason(stopReason) };
    void sawMessageStop;
  }
}
