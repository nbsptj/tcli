import { AbortError, ProviderError } from "../utils/errors.ts";
import type { ChatMessage } from "../types.ts";
import { TCLI_VERSION, emptyUsage } from "../types.ts";
import { parseSse } from "./sse.ts";
import {
  authHeaders,
  debugRequest,
  debugResponse,
  debugStream,
  extractTextContent,
  fetchWithTimeout,
  finalizeToolArguments,
  joinEndpoint,
  mapOpenAiFinish,
  mergeHeaders,
  responseError,
} from "./http.ts";
import type { Provider, ProviderFactoryOptions, ProviderRequest, StreamEvent } from "./types.ts";

interface OpenAiToolAccumulator {
  id?: string;
  name?: string;
  args: string;
}

function openAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }));
      }
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

function maxTokensParam(model: string, override: unknown): string {
  if (override === "max_tokens" || override === "max_completion_tokens") return override;
  return /^(?:o\d|gpt-5)/i.test(model) ? "max_completion_tokens" : "max_tokens";
}

/**
 * OpenAI Chat Completions compatible provider (OpenAI, DeepSeek, Groq,
 * OpenRouter, vLLM, LM Studio, Azure-compatible gateways, ...).
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  readonly type = "openai-compatible";
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
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": `tcli/${TCLI_VERSION}`,
      },
      authHeaders(this.cfg.apiKey),
      this.cfg.headers,
    );
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const url = joinEndpoint(this.cfg.baseUrl, "/chat/completions");
    const options = this.cfg.options ?? {};
    const tokenParam = maxTokensParam(this.model, options.maxTokensParam);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: openAiMessages(req.messages),
      stream: true,
      temperature: req.temperature,
      [tokenParam]: req.maxTokens,
    };
    if (options.streamOptions !== false) {
      body.stream_options = { include_usage: true };
    }
    if (req.tools.length) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = options.toolChoice ?? "auto";
    }
    if (options.extraBody && typeof options.extraBody === "object") {
      Object.assign(body, options.extraBody);
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
    if (!res.body) throw new ProviderError("Provider returned an empty response body", { retryable: true });

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Some gateways ignore stream=true and return a complete JSON response.
      yield* this.consumeJsonResponse(res, req);
      return;
    }

    const toolCalls = new Map<number, OpenAiToolAccumulator>();
    let finishReason: string | null = null;

    for await (const message of parseSse(res.body)) {
      if (req.signal.aborted) throw new AbortError("Request aborted");
      const data = message.data.trim();
      if (!data) continue;
      if (data === "[DONE]") break;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        // Keepalive or vendor-specific non-JSON event; ignore.
        continue;
      }
      debugStream(req.onDebug, json);
      if (json.error) {
        const errObj = json.error as { message?: string; type?: string };
        throw new ProviderError(`Provider stream error: ${errObj.message ?? JSON.stringify(errObj)}`, {
          retryable: true,
          code: "STREAM_ERROR",
        });
      }
      const choices = json.choices as
        | Array<{
            delta?: {
              content?: unknown;
              reasoning_content?: unknown;
              reasoning?: unknown;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>
        | undefined;
      const choice = choices?.[0];
      if (choice) {
        const delta = choice.delta;
        if (delta) {
          const text = extractTextContent(delta.content);
          if (text) yield { type: "text", text };
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
          for (const [fallbackIndex, tc] of (delta.tool_calls ?? []).entries()) {
            const index = tc.index ?? fallbackIndex;
            const acc = toolCalls.get(index) ?? { args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = (acc.name ?? "") + tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolCalls.set(index, acc);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (json.usage) {
        const u = json.usage as {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
        const usage = emptyUsage();
        usage.inputTokens = u.prompt_tokens ?? 0;
        usage.outputTokens = u.completion_tokens ?? 0;
        usage.cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
        yield { type: "usage", usage };
      }
    }

    let emittedTools = 0;
    for (const [index, acc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) continue;
      const args = finalizeToolArguments(acc.args, acc.name);
      yield {
        type: "tool_call",
        toolCall: {
          id: acc.id ?? `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
          name: acc.name,
          arguments: args,
        },
      };
      emittedTools++;
    }
    if (emittedTools > 0) {
      yield { type: "stop", reason: "tool_use" };
    } else {
      yield { type: "stop", reason: mapOpenAiFinish(finishReason) };
    }
  }

  private async *consumeJsonResponse(
    res: Response,
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw new ProviderError(`Provider returned malformed JSON: ${(err as Error).message}`, {
        retryable: true,
      });
    }
    debugStream(req.onDebug, json);
    if (json.error) {
      const errObj = json.error as { message?: string };
      throw new ProviderError(`Provider error: ${errObj.message ?? JSON.stringify(errObj)}`, { retryable: false });
    }
    const choices = json.choices as
      | Array<{
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>
      | undefined;
    const choice = choices?.[0];
    const message = choice?.message;
    if (message) {
      const text = extractTextContent(message.content);
      if (text) yield { type: "text", text };
      if (typeof message.reasoning_content === "string") {
        yield { type: "reasoning", text: message.reasoning_content };
      }
      const calls = message.tool_calls ?? [];
      for (const [index, call] of calls.entries()) {
        const name = call.function?.name;
        if (!name) continue;
        yield {
          type: "tool_call",
          toolCall: {
            id: call.id ?? `call_${index}`,
            name,
            arguments: finalizeToolArguments(call.function?.arguments ?? "{}", name),
          },
        };
      }
      if (json.usage) {
        const u = json.usage as { prompt_tokens?: number; completion_tokens?: number };
        const usage = emptyUsage();
        usage.inputTokens = u.prompt_tokens ?? 0;
        usage.outputTokens = u.completion_tokens ?? 0;
        yield { type: "usage", usage };
      }
      if (calls.length) {
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "stop", reason: mapOpenAiFinish(choice?.finish_reason) };
      }
    } else {
      yield { type: "stop", reason: "end" };
    }
  }
}
