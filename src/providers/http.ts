import { AbortError, ProviderError, isAbortError } from "../utils/errors.ts";
import { redactValue } from "../utils/redact.ts";
import { parseJsonLoose } from "../utils/json.ts";
import type { Provider, ProviderDebugEvent, ProviderRequest, StreamEvent } from "./types.ts";

export function joinEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith(path)) return base;
  return base + (path.startsWith("/") ? path : `/${path}`);
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function mergeHeaders(...sets: Array<Record<string, string> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [k, v] of Object.entries(set)) out[k] = v;
  }
  return out;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  userSignal: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const signal = AbortSignal.any([userSignal, timeoutSignal]);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (isAbortError(err) || userSignal.aborted) throw new AbortError("Request aborted");
    if (timeoutSignal.aborted) {
      throw new ProviderError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, {
        retryable: true,
        code: "TIMEOUT",
        cause: err,
      });
    }
    throw new ProviderError(`Network request failed: ${(err as Error).message}`, {
      retryable: true,
      code: "NETWORK",
      cause: err,
    });
  }
}

export async function responseError(res: Response): Promise<ProviderError> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
    /* ignore */
  }
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error?.message) message = parsed.error.message;
    else if (parsed.message) message = parsed.message;
  } catch {
    /* plain text error */
  }
  const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
  const retryAfterRaw = res.headers.get("retry-after");
  let retryAfterMs: number | undefined;
  if (retryAfterRaw) {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    else {
      const date = Date.parse(retryAfterRaw);
      if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - Date.now());
    }
  }
  const hint =
    res.status === 401
      ? " Check the API key and provider configuration."
      : res.status === 404
        ? " Check the base URL and model name."
        : "";
  return new ProviderError(`HTTP ${res.status}: ${message || res.statusText}${hint}`, {
    retryable,
    status: res.status,
    retryAfterMs,
  });
}

export function finalizeToolArguments(raw: string, toolName: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const parsed = parseJsonLoose<unknown>(text);
  if (!parsed.ok) {
    throw new ProviderError(`Model produced invalid JSON arguments for tool "${toolName}": ${parsed.error}`, {
      retryable: true,
      code: "TOOL_JSON",
    });
  }
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    throw new ProviderError(`Model produced non-object arguments for tool "${toolName}"`, {
      retryable: true,
      code: "TOOL_JSON",
    });
  }
  return parsed.value as Record<string, unknown>;
}

function emitDebug(
  sink: ProviderRequest["onDebug"],
  event: ProviderDebugEvent,
): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    /* diagnostics must not affect the request */
  }
}

/**
 * Wrap a provider with bounded retries and exponential backoff.
 *
 * A stream is only retried if it has not committed any visible output yet;
 * replaying after partial text would duplicate content. Aborts are never
 * retried.
 */
export async function* streamWithRetry(
  provider: Provider,
  req: ProviderRequest,
  opts: { maxRetries?: number; onDebug?: ProviderRequest["onDebug"] } = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const maxRetries = opts.maxRetries ?? 3;
  let committed = false;
  for (let attempt = 0; ; attempt++) {
    let failed: { error: Error; retryable: boolean } | undefined;
    try {
      for await (const event of provider.stream(req)) {
        if (event.type === "text" || event.type === "reasoning" || event.type === "tool_call" || event.type === "stop") {
          if (event.type !== "stop") committed = true;
        }
        if (event.type === "error") {
          failed = { error: event.error, retryable: event.retryable };
          break;
        }
        if (event.type === "retry") continue;
        yield event;
        if (event.type === "stop") return;
      }
    } catch (err) {
      const retryable =
        err instanceof ProviderError ? err.retryable : !isAbortError(err) && !committed;
      failed = { error: err instanceof Error ? err : new Error(String(err)), retryable };
    }
    if (!failed) return;
    if (isAbortError(failed.error) || req.signal.aborted) {
      yield { type: "error", error: new AbortError("Request aborted"), retryable: false };
      return;
    }
    if (!failed.retryable || committed || attempt >= maxRetries) {
      yield { type: "error", error: failed.error, retryable: false };
      return;
    }
    const providerErr = failed.error instanceof ProviderError ? failed.error : undefined;
    const baseDelay = providerErr?.retryAfterMs ?? Math.min(8000, 400 * 2 ** attempt);
    const delayMs = Math.max(0, baseDelay) + Math.floor(Math.random() * 150);
    emitDebug(opts.onDebug, {
      kind: "response",
      data: { retry: attempt + 1, delayMs, error: failed.error.message },
    });
    yield { type: "retry", attempt: attempt + 1, delayMs, reason: failed.error.message };
    await abortableSleep(delayMs, req.signal);
    if (req.signal.aborted) {
      yield { type: "error", error: new AbortError("Request aborted"), retryable: false };
      return;
    }
  }
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError("Request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function debugRequest(sink: ProviderRequest["onDebug"], data: Record<string, unknown>): void {
  emitDebug(sink, { kind: "request", data: redactValue(data) });
}

export function debugResponse(sink: ProviderRequest["onDebug"], data: Record<string, unknown>): void {
  emitDebug(sink, { kind: "response", data: redactValue(data) });
}

export function debugStream(sink: ProviderRequest["onDebug"], data: unknown): void {
  emitDebug(sink, { kind: "stream", data: redactValue(data) });
}

export function mapOpenAiFinish(reason: string | null | undefined): "end" | "tool_use" | "max_tokens" | "refusal" {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end";
  }
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { text?: unknown; content?: unknown };
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}
