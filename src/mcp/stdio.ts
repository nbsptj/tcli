import type { McpServerConfig } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";
import { filterEnv } from "../utils/env.ts";
import { killProcessTree } from "../utils/process.ts";
import { redactSecrets } from "../utils/redact.ts";
import { truncateText } from "../utils/strings.ts";
import { McpError, type McpRequestOptions, type McpTransport } from "./types.ts";

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * MCP stdio transport: newline-delimited JSON-RPC over a long-lived child
 * process. Server stderr is captured for diagnostics; stray stdout lines that
 * are not JSON are logged and ignored.
 */
export class StdioTransport implements McpTransport {
  private readonly config: McpServerConfig;
  private readonly workspace: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private buffer = "";
  private stderrTail = "";

  constructor(opts: { config: McpServerConfig; workspace: string; logger: Logger; timeoutMs: number }) {
    this.config = opts.config;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs;
  }

  async connect(): Promise<void> {
    if (!this.config.command) throw new McpError("MCP stdio server has no command");
    const env: Record<string, string> = { ...filterEnv(process.env), ...(this.config.env ?? {}) };
    const cwd = this.config.cwd ? this.config.cwd : this.workspace;
    try {
      this.child = Bun.spawn({
        cmd: [this.config.command, ...(this.config.args ?? [])],
        cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
    } catch (err) {
      throw new McpError(`Failed to start MCP server "${this.config.command}": ${(err as Error).message}`);
    }
    void this.readStdout(this.child.stdout);
    void this.readStderr(this.child.stderr);
    void this.child.exited.then((code) => this.onExit(code));
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch {
      /* process exited */
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const text = decoder.decode(value, { stream: true });
        this.stderrTail = truncateText(this.stderrTail + text, 4000, "");
        for (const line of text.split("\n")) {
          if (line.trim()) this.logger.debug("mcp stderr", { server: this.config.command, line: line.slice(0, 500) });
        }
      }
    } catch {
      /* process exited */
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.logger.debug("mcp non-JSON stdout", { line: line.slice(0, 300) });
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined || message.method === undefined)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new McpError(message.error.message ?? "MCP error", message.error.code));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      // Server-initiated request. We only support ping; everything else is rejected.
      const result = message.method === "ping" ? {} : undefined;
      void this.write({
        jsonrpc: "2.0",
        id: message.id,
        ...(result !== undefined
          ? { result }
          : { error: { code: -32601, message: `Method not supported by tcli: ${message.method}` } }),
      });
      return;
    }
    if (message.method === "notifications/tools/list_changed") {
      this.logger.info("mcp tools list changed", { server: this.config.command });
    }
  }

  private async write(message: unknown): Promise<void> {
    const child = this.child;
    if (!child || this.closed) throw new McpError("MCP stdio transport is closed");
    try {
      child.stdin.write(JSON.stringify(message) + "\n");
      await child.stdin.flush();
    } catch (err) {
      throw new McpError(`Failed to write to MCP server: ${(err as Error).message}`);
    }
  }

  async request(method: string, params?: unknown, opts: McpRequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new McpError("MCP stdio transport is closed");
    const id = this.nextId++;
    const timeoutMs = this.timeoutMs;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(err as Error);
        }
      });
      if (opts.signal) {
        const onAbort = () => {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new McpError(`MCP request "${method}" aborted`));
          }
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private onExit(code: number): void {
    if (this.closed) return;
    this.closed = true;
    const tail = redactSecrets(this.stderrTail).text.trim();
    const error = new McpError(
      `MCP server exited with code ${code}${tail ? `: ${tail.slice(-500)}` : ""}`,
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed && !this.child) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpError("MCP transport closed"));
    }
    this.pending.clear();
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    killProcessTree(child.pid, "SIGTERM");
    await Promise.race([
      child.exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    killProcessTree(child.pid, "SIGKILL");
    this.child = undefined;
  }
}
