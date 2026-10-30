import type { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";
import type { PermissionRequest } from "../permissions/types.ts";
import type { TodoItem, ToolKind, Usage } from "../types.ts";
import type { SnapshotStore } from "../context/snapshots.ts";
import type { CheckpointStore } from "../context/checkpoint.ts";
import type { TodoStore } from "./todo-store.ts";

export interface ToolPermissionInfo {
  /** Absolute paths touched by the call. */
  paths?: string[];
  /** Shell command for exec tools. */
  command?: string;
  /** Extra content-level sensitivity discovered by the tool. */
  sensitive?: boolean;
  sensitiveReasons?: string[];
}

export interface ToolDisplay {
  /** One-line summary shown after the tool call. */
  summary?: string;
  /** Unified diff for write/edit previews. */
  diff?: string;
  /** Additional human-facing text (already truncated by the caller if huge). */
  text?: string;
}

export interface ToolResult {
  /** Content sent back to the model. */
  content: string;
  isError?: boolean;
  display?: ToolDisplay;
  metadata?: Record<string, unknown>;
}

export interface SubagentRequest {
  description: string;
  prompt: string;
  maxSteps?: number;
}

export interface SubagentResult {
  text: string;
  ok: boolean;
  usage?: Usage;
  toolCalls?: number;
}

export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentResult>;

export interface ToolContext {
  cwd: string;
  config: Config;
  logger: Logger;
  signal: AbortSignal;
  snapshots: SnapshotStore;
  checkpoints: CheckpointStore;
  todo: TodoStore;
  sessionId: string;
  traceId: string;
  /** User-facing todo updates (AG-4). */
  onTodo?: (todos: TodoItem[]) => void;
  /** Run a nested agent (TL-8 / AG-9). */
  spawnSubagent?: SubagentRunner;
  /** Optional progress sink for long-running tools. */
  onProgress?: (text: string) => void;
}

export interface ToolValidationResult {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema used for validation and JSON Schema generation. */
  schema: S;
  /** Explicit provider-facing JSON Schema (MCP/custom tools); overrides schema. */
  inputSchema?: Record<string, unknown>;
  /** Optional custom validator (used with inputSchema). */
  validateInput?: (input: unknown) => ToolValidationResult;
  kind: ToolKind;
  /** Build the permission request metadata before execution. */
  permissionInfo(input: z.infer<S>, ctx: ToolContext): ToolPermissionInfo | Promise<ToolPermissionInfo>;
  /** Human-readable preview for confirmation (command, diff, ...). */
  preview?(input: z.infer<S>, ctx: ToolContext): string | Promise<string>;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export type AnyToolDefinition = ToolDefinition<z.ZodTypeAny>;

export function defineTool<S extends z.ZodTypeAny>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export interface PreparedPermission {
  request: PermissionRequest;
  preview?: string;
}

/** Runtime host callbacks shared by the agent and tool registry. */
export interface ToolHost {
  workspace: string;
  config: Config;
  logger: Logger;
  snapshots: SnapshotStore;
  checkpoints: CheckpointStore;
  todo: TodoStore;
  sessionId: string;
  traceId: string;
  signal: AbortSignal;
  onTodo?: (todos: TodoItem[]) => void;
  onProgress?: (text: string) => void;
  spawnSubagent?: SubagentRunner;
}
