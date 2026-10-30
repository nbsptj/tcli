import type { Logger } from "../log/logger.ts";
import { truncateText } from "../utils/strings.ts";
import { parseSse } from "../providers/sse.ts";
import { McpError, type McpRequestOptions, type McpTransport } from "./types.ts";

function mergeHeaders(base: Record<string, string>, extra?: Record<string, string>): Record<string, string> {
  return { ...base, ...(extra ?? {}) };
}

async function errorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return truncateText(text, 500);
  } catch {
    return res.statusText;
  }
}

async function readJsonRpc(res: Response, expectedId: number): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 202 || res.status === 204) return undefined;
  if (!res.ok) throw new McpError(`MCP HTTP ${res.status}: ${await errorBody(res)}`, res.status);
  if (contentType.includes("text/event-stream")) {
    if (!res.body) throw new McpError("MCP SSE response had no body");
    for await (const event of parseSse(res.body)) {
      if (!event.data.trim()) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      const messages = Array.isArray(payload) ? payload : [payload];
      for (const message of messages) {
        const msg = message as { id?: number; result?: unknown; error?: { message?: string; code?: number } };
        if (msg.id !== expectedId) continue;
        if (msg.error) throw new McpError(msg.error.message ?? "MCP error", msg.error.code);
        return msg.result;
      }
    }
    throw new McpError("MCP SSE stream ended without a response");
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new McpError(`MCP returned invalid JSON: ${(err as Error).message}`);
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  for (const message of messages) {
    const msg = message as { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    if (msg.id !== expectedId) continue;
    if (msg.error) throw new McpError(msg.error.message ?? "MCP error", msg.error.code);
    return msg.result;
  }
  throw new McpError("MCP response did not match the request id");
}

/**
 * MCP Streamable HTTP transport (POST JSON-RPC, JSON or SSE response).
 * Session and protocol headers are captured during initialize.
 */
export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private nextId = 1;
  private sessionId?: string;
  private protocolVersion = "2024-11-05";

  constructor(opts: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    logger: Logger;
  }) {
    this.url = opts.url;
    this.headers = opts.headers;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
  }

  async connect(): Promise<void> {
    /* The initialize request is performed by McpClient. */
  }

  private async post(body: unknown, opts: McpRequestOptions = {}): Promise<Response> {
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    const signal = AbortSignal.any(signals);
    try {
      return await fetch(this.url, {
        method: "POST",
        headers: mergeHeaders(
          {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": this.protocolVersion,
            ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          },
          this.headers,
        ),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new McpError("MCP request aborted");
      if ((err as Error).name === "TimeoutError") {
        throw new McpError(`MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw new McpError(`MCP network error: ${(err as Error).message}`);
    }
  }

  async request(method: string, params?: unknown, opts: McpRequestOptions = {}): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, opts);
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const version = res.headers.get("mcp-protocol-version");
    if (version) this.protocolVersion = version;
    if (method === "initialize") {
      // Initialize may legitimately return 200 with the negotiated version.
      this.logger.debug("mcp http initialize", { url: this.url, status: res.status });
    }
    return await readJsonRpc(res, id);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method, params });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!res.ok && res.status !== 202) {
      throw new McpError(`MCP notification rejected (${res.status}): ${await errorBody(res)}`, res.status);
    }
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: mergeHeaders({ "Mcp-Session-Id": this.sessionId }, this.headers),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Legacy MCP HTTP+SSE transport (2024-11-05): a long-lived GET stream announces
 * a POST endpoint; responses are delivered through that stream.
 */
export class SseMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly controller = new AbortController();
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private endpoint?: string;
  private endpointResolve?: () => void;
  private endpointReject?: (err: Error) => void;
  private endpointPromise: Promise<void> = Promise.resolve();
  private nextId = 1;
  private closed = false;

  constructor(opts: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    logger: Logger;
  }) {
    this.url = opts.url;
    this.headers = opts.headers;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
  }

  async connect(): Promise<void> {
    this.endpointPromise = new Promise<void>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });
    void this.readLoop().catch((err) => {
      this.failAll(err instanceof Error ? err : new McpError(String(err)));
    });
    const timeout = setTimeout(() => {
      this.endpointReject?.(new McpError("Timed out waiting for MCP SSE endpoint"));
    }, this.timeoutMs);
    timeout.unref?.();
    try {
      await this.endpointPromise;
    } finally {
      clearTimeout(timeout);
    }
    if (!this.endpoint) throw new McpError("MCP SSE transport did not provide an endpoint");
  }

  private async readLoop(): Promise<void> {
    const res = await fetch(this.url, {
      headers: mergeHeaders({ Accept: "text/event-stream" }, this.headers),
      signal: this.controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new McpError(`MCP SSE connection failed (${res.status})`, res.status);
    }
    for await (const event of parseSse(res.body)) {
      if (event.event === "endpoint") {
        try {
          this.endpoint = new URL(event.data.trim(), this.url).toString();
          this.endpointResolve?.();
        } catch (err) {
          this.endpointReject?.(new McpError(`Invalid MCP endpoint: ${(err as Error).message}`));
        }
        continue;
      }
      if (!event.data.trim()) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      const msg = payload as {
        id?: number;
        result?: unknown;
        error?: { message?: string; code?: number };
        method?: string;
      };
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new McpError(msg.error.message ?? "MCP error", msg.error.code));
        else pending.resolve(msg.result);
      } else if (msg.method) {
        this.logger.debug("mcp server notification", { method: msg.method });
      }
    }
  }

  private failAll(error: Error): void {
    this.endpointReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async post(body: unknown, opts: McpRequestOptions = {}): Promise<Response> {
    if (!this.endpoint) throw new McpError("MCP SSE transport is not connected");
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    try {
      return await fetch(this.endpoint, {
        method: "POST",
        headers: mergeHeaders({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, this.headers),
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      throw new McpError(`MCP POST failed: ${(err as Error).message}`);
    }
  }

  async request(method: string, params?: unknown, opts: McpRequestOptions = {}): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (opts.signal) {
        const onAbort = () => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new McpError(`MCP request "${method}" aborted`));
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      void this.post({ jsonrpc: "2.0", id, method, params }, opts)
        .then(async (res) => {
          if (!res.ok) {
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              clearTimeout(pending.timer);
              pending.reject(new McpError(`MCP POST rejected (${res.status})`, res.status));
            }
          }
          try {
            await res.body?.cancel();
          } catch {
            /* ignore */
          }
        })
        .catch((err) => {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(err as Error);
          }
        });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method, params });
    if (!res.ok && res.status !== 202) {
      throw new McpError(`MCP notification rejected (${res.status}): ${await errorBody(res)}`, res.status);
    }
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.failAll(new McpError("MCP transport closed"));
  }
}
