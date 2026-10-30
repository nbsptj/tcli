import type { McpServerConfig } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
  structured?: unknown;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
}

export interface McpTransport {
  connect(): Promise<void>;
  request(method: string, params?: unknown, opts?: McpRequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export class McpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export interface McpClientOptions {
  name: string;
  config: McpServerConfig;
  workspace: string;
  logger: Logger;
  transportOverride?: "stdio" | "sse" | "http";
}

export interface McpLoadResult {
  tools: import("../tools/types.ts").AnyToolDefinition[];
  warnings: string[];
  clients: number;
}
