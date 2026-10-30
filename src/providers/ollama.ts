import { AbortError, ProviderError } from "../utils/errors.ts";
import type { ChatMessage } from "../types.ts";
import { TCLI_VERSION, emptyUsage } from "../types.ts";
import { parseJsonLoose } from "../utils/json.ts";
import { debugRequest, debugResponse, debugStream, fetchWithTimeout, joinEndpoint, responseError } from "./http.ts";
import { parseNdjson } from "./sse.ts";
import type { Provider, ProviderFactoryOptions, ProviderRequest, StreamEvent } from "./types.ts";

function ollamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.toolName };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments ?? {} },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Ollama local model provider (`/api/chat`, NDJSON streaming). */
export class OllamaProvider implements Provider {
  readonly id: string;
  readonly type = "ollama";
  readonly model: string;
  private readonly cfg: ProviderFactoryOptions;

  constructor(cfg: ProviderFactoryOptions) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.model = cfg.model;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const url = joinEndpoint(this.cfg.baseUrl, "/api/chat");
    const opts = this.cfg.options ?? {};
    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages(req.messages),
      stream: true,
      options: {
        temperature: req.temperature,
        num_predict: req.maxTokens,
        ...(opts.ollamaOptions as Record<string, unknown> | undefined),
      },
    };
    if (opts.keepAlive !== undefined) body.keep_alive = opts.keepAlive;
    if (req.tools.length) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    debugRequest(req.onDebug, { provider: this.id, url, body });
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          "User-Agent": `tcli/${TCLI_VERSION}`,
          ...this.cfg.headers,
        },
        body: JSON.stringify(body),
      },
      this.cfg.timeoutMs,
      req.signal,
    );
    debugResponse(req.onDebug, { provider: this.id, url, status: res.status });
    if (!res.ok) throw await responseError(res);
    if (!res.body) throw new ProviderError("Ollama returned an empty response body", { retryable: true });

    let emittedTools = 0;
    const seenCalls = new Set<string>();
    for await (const raw of parseNdjson(res.body)) {
      if (req.signal.aborted) throw new AbortError("Request aborted");
      const chunk = raw as {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
        };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
      debugStream(req.onDebug, chunk);
      if (chunk.error) {
        throw new ProviderError(`Ollama error: ${chunk.error}`, { retryable: true, code: "STREAM_ERROR" });
      }
      if (chunk.message?.thinking) yield { type: "reasoning", text: chunk.message.thinking };
      if (chunk.message?.content) yield { type: "text", text: chunk.message.content };
      for (const [index, call] of (chunk.message?.tool_calls ?? []).entries()) {
        const name = call.function?.name;
        if (!name) continue;
        const rawArgs = call.function?.arguments;
        const args =
          typeof rawArgs === "string"
            ? rawArgs.trim()
              ? (() => {
                  const parsed = parseJsonLoose<Record<string, unknown>>(rawArgs);
                  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
                    throw new ProviderError(`Ollama produced invalid tool arguments for ${name}`, {
                      retryable: true,
                    });
                  }
                  return parsed.value;
                })()
              : {}
            : rawArgs && typeof rawArgs === "object"
              ? (rawArgs as Record<string, unknown>)
              : {};
        const key = `${name}:${JSON.stringify(args)}`;
        if (seenCalls.has(key)) continue;
        seenCalls.add(key);
        yield {
          type: "tool_call",
          toolCall: { id: `ollama_${index}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args },
        };
        emittedTools++;
      }
      if (chunk.done) {
        const usage = emptyUsage();
        usage.inputTokens = chunk.prompt_eval_count ?? 0;
        usage.outputTokens = chunk.eval_count ?? 0;
        yield { type: "usage", usage };
      }
    }
    yield { type: "stop", reason: emittedTools > 0 ? "tool_use" : "end" };
  }
}
