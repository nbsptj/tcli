/**
 * Shared domain types for tcli.
 *
 * These types are deliberately provider-agnostic and UI-agnostic: the agent
 * kernel, tools, session store and every frontend speak this vocabulary.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool result messages. */
  toolCallId?: string;
  toolName?: string;
  /** True when a tool result represents a failure. */
  isError?: boolean;
  /** Provider-side reasoning/thinking text, kept for display only. */
  reasoning?: string;
  at?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  if (!b) return { ...a };
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
  };
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens;
}

/** Side-effect class of a tool, used by scheduling and permissions. */
export type ToolKind = "read" | "write" | "exec" | "network";

export type StopReason =
  | "end"
  | "tool_use"
  | "max_tokens"
  | "aborted"
  | "error"
  | "budget"
  | "refusal";

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the tool arguments. */
  parameters: Record<string, unknown>;
}

export type PermissionAction = "allow" | "ask" | "deny";

/** A tool call as rendered in transcripts and audit logs. */
export interface ToolInvocation {
  id: string;
  name: string;
  input: Record<string, unknown>;
  kind: ToolKind;
}

export interface ToolOutcome {
  invocation: ToolInvocation;
  ok: boolean;
  content: string;
  durationMs: number;
  denied?: boolean;
}

export interface DisplayDiff {
  path: string;
  text: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export const TCLI_VERSION = "0.1.0";
