import type { PermissionAction, ToolKind } from "../types.ts";

export interface PermissionRequest {
  tool: string;
  kind: ToolKind;
  input: Record<string, unknown>;
  /** Shell command for exec tools. */
  command?: string;
  /** Absolute paths touched by the call (after resolution). */
  paths: string[];
  /** At least one path resolves outside the workspace (symlinks included). */
  outsideWorkspace: boolean;
  /** Path or content is credential-sensitive. */
  sensitive: boolean;
  sensitiveReasons?: string[];
  /** Human-readable preview shown in confirmation UI (command or diff). */
  preview?: string;
}

export interface PermissionRuleMatch {
  tool: string;
  match?: string;
  action: PermissionAction;
  reason?: string;
}

export interface Decision {
  action: PermissionAction;
  reason: string;
  /** Rule or danger label that produced the decision. */
  source: "mode" | "danger" | "workspace" | "sensitive" | "grant" | "rule" | "default" | "yes";
  rule?: PermissionRuleMatch;
  dangerLabel?: string;
}

export interface SessionGrant {
  tool: string;
  /** Command prefix, path glob, or host; absent = whole tool. */
  match?: string;
  createdAt: number;
}

export type ConfirmationAnswer =
  | { type: "yes" }
  | { type: "no" }
  | { type: "always" }
  | { type: "edit"; editedCommand?: string };

export interface ConfirmationRequest extends PermissionRequest {
  decision: Decision;
  preview?: string;
}

export type Asker = (req: ConfirmationRequest) => Promise<ConfirmationAnswer>;

export interface AuthorizeResult {
  allowed: boolean;
  decision: Decision;
  approvedBy: "policy" | "grant" | "user" | "yes" | "edited" | "none";
  /** Replacement args when the user edited a command. */
  editedInput?: Record<string, unknown>;
  durationMs: number;
}
