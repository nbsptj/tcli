import type { ChatMessage, StopReason, ToolSchema, Usage } from "../types.ts";

export interface ProviderRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  /** Verbose diagnostics: raw request/response payloads (already redacted by logger). */
  onDebug?: (event: ProviderDebugEvent) => void;
}

export interface ProviderDebugEvent {
  kind: "request" | "response" | "stream";
  data: unknown;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: StopReason }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  | { type: "error"; error: Error; retryable: boolean };

export interface Provider {
  readonly id: string;
  readonly type: string;
  readonly model: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown>;
}

export interface ProviderFactoryOptions {
  id: string;
  type: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  options?: Record<string, unknown>;
}
