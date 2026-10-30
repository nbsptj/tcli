import type {
  PermissionAction,
  StopReason,
  TodoItem,
  ToolInvocation,
  ToolOutcome,
  Usage,
} from "../types.ts";
import type { ToolDisplay } from "../tools/types.ts";

export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  | { type: "tool_start"; invocation: ToolInvocation; preview?: string }
  | {
      type: "permission";
      tool: string;
      decision: PermissionAction;
      allowed: boolean;
      approvedBy: string;
      reason: string;
    }
  | { type: "tool_result"; outcome: ToolOutcome; display?: ToolDisplay }
  | { type: "todo"; todos: TodoItem[] }
  | { type: "usage"; usage: Usage; total: Usage; costUsd?: number }
  | { type: "compaction"; beforeTokens: number; afterTokens: number; summary: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "debug"; text: string }
  | { type: "turn_end"; reason: StopReason; steps: number }
  | { type: "done"; reason: StopReason; text: string }
  | { type: "error"; message: string }
  | { type: "subagent"; phase: "start" | "end"; description: string; ok?: boolean };

export interface AgentRunResult {
  reason: StopReason;
  text: string;
  usage: Usage;
  costUsd?: number;
}
