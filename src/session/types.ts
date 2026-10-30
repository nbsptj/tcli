import type { ChatMessage, TodoItem, Usage } from "../types.ts";
import type { SnapshotRecord } from "../context/snapshots.ts";
import type { CheckpointInfo } from "../context/checkpoint.ts";

export interface SessionMeta {
  type: "meta";
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
  provider: string;
  model: string;
  traceId: string;
  title: string;
  tcliVersion: string;
}

export interface MessageEvent {
  type: "message";
  at: string;
  message: ChatMessage;
}

export interface UsageEvent {
  type: "usage";
  at: string;
  usage: Usage;
  model?: string;
}

export interface TodoEvent {
  type: "todo";
  at: string;
  todos: TodoItem[];
}

export interface SnapshotEvent {
  type: "snapshot";
  at: string;
  snapshot: SnapshotRecord;
}

export interface CheckpointEvent {
  type: "checkpoint";
  at: string;
  checkpoint: CheckpointInfo;
}

export interface CompactionEvent {
  type: "compaction";
  at: string;
  summary: string;
  keepMessages: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface TitleEvent {
  type: "title";
  at: string;
  title: string;
}

export interface NoteEvent {
  type: "note";
  at: string;
  text: string;
}

export type SessionEvent =
  | SessionMeta
  | MessageEvent
  | UsageEvent
  | TodoEvent
  | SnapshotEvent
  | CheckpointEvent
  | CompactionEvent
  | TitleEvent
  | NoteEvent;

export interface LoadedSession {
  meta: SessionMeta;
  /** Messages after applying compaction events, ready to send to a model. */
  messages: ChatMessage[];
  usage: Usage;
  todos: TodoItem[];
  snapshots: SnapshotRecord[];
  events: number;
  warnings: string[];
  lastAt?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
  file: string;
}
