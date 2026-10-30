import fs from "node:fs";
import path from "node:path";
import { TCLI_VERSION, addUsage, emptyUsage, type ChatMessage, type TodoItem, type Usage } from "../types.ts";
import { appendLineSync, ensureDirSync } from "../utils/fs.ts";
import { sessionDir, sessionFile, sessionsDir, toPosix } from "../utils/paths.ts";
import { TcliError } from "../utils/errors.ts";
import { truncateText } from "../utils/strings.ts";
import type { SnapshotRecord } from "../context/snapshots.ts";
import type { CheckpointInfo } from "../context/checkpoint.ts";
import type {
  LoadedSession,
  SessionEvent,
  SessionMeta,
  SessionSummary,
} from "./types.ts";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function assertSessionId(id: string): string {
  if (!ID_RE.test(id) || id.includes("..")) throw new TcliError(`Invalid session id: ${id}`, { code: "SESSION_ID" });
  return id;
}

export function generateSessionId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function generateTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function titleFromPrompt(prompt: string, max = 70): string {
  return truncateText(prompt.replace(/\s+/g, " ").trim(), max);
}

function parseLine(line: string): SessionEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as SessionEvent;
  } catch {
    return undefined;
  }
}

export function readSession(id: string): LoadedSession {
  assertSessionId(id);
  const file = sessionFile(id);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new TcliError(`Session not found: ${id}`, { code: "SESSION_NOT_FOUND" });
  }
  const lines = text.split("\n");
  let meta: SessionMeta | undefined;
  let messages: ChatMessage[] = [];
  const usage: Usage = emptyUsage();
  let todos: TodoItem[] = [];
  const snapshots = new Map<string, SnapshotRecord>();
  const warnings: string[] = [];
  let events = 0;
  let lastAt: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = parseLine(line);
    if (!event) {
      warnings.push("Ignored a malformed JSONL line (possibly a crash-truncated write).");
      continue;
    }
    events++;
    if (event.type === "meta") {
      meta = event;
      continue;
    }
    if ("at" in event && event.at) lastAt = event.at;
    switch (event.type) {
      case "message":
        messages.push(event.message);
        break;
      case "usage":
        Object.assign(usage, addUsage(usage, event.usage));
        break;
      case "todo":
        todos = event.todos;
        break;
      case "snapshot":
        snapshots.set(event.snapshot.path, event.snapshot);
        break;
      case "compaction": {
        const keep = Math.max(0, event.keepMessages);
        const kept = keep > 0 ? messages.slice(-keep) : [];
        messages = [
          {
            role: "system",
            content: `[Conversation summary — earlier turns compacted]\n${event.summary}`,
            at: event.at,
          },
          ...kept,
        ];
        break;
      }
      case "title":
        if (meta) meta.title = event.title;
        break;
      default:
        break;
    }
  }
  if (!meta) throw new TcliError(`Session is corrupt (missing metadata): ${id}`, { code: "SESSION_CORRUPT" });
  return { meta, messages, usage, todos, snapshots: [...snapshots.values()], events, warnings, lastAt };
}

function readMeta(file: string): SessionMeta | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
      const event = parseLine(firstLine);
      return event?.type === "meta" ? event : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function readLastTitle(file: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const readSize = Math.min(stat.size, 64 * 1024);
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const event = parseLine(lines[i]!);
        if (event?.type === "title") return event.title;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function listSessions(opts: { cwd?: string; limit?: number } = {}): SessionSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    if (!ID_RE.test(id)) continue;
    const file = path.join(sessionsDir(), entry);
    const meta = readMeta(file);
    if (!meta) continue;
    if (opts.cwd && path.resolve(meta.cwd) !== path.resolve(opts.cwd)) continue;
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    out.push({
      id,
      title: readLastTitle(file) ?? meta.title ?? "Untitled session",
      cwd: meta.cwd,
      provider: meta.provider,
      model: meta.model,
      createdAt: meta.createdAt,
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      file,
    });
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out;
}

export function latestSession(cwd?: string): SessionSummary | undefined {
  if (cwd) {
    const inCwd = listSessions({ cwd, limit: 1 });
    if (inCwd.length) return inCwd[0];
  }
  return listSessions({ limit: 1 })[0];
}

export function deleteSession(id: string): void {
  assertSessionId(id);
  const file = sessionFile(id);
  try {
    fs.unlinkSync(file);
  } catch {
    throw new TcliError(`Session not found: ${id}`, { code: "SESSION_NOT_FOUND" });
  }
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}

/**
 * Append-only session store. The current turn writes each message/event as it
 * happens, so a crash loses at most the final partial line.
 */
export class SessionStore {
  readonly meta: SessionMeta;
  readonly file: string;
  readonly dir: string;
  private readonly autoSave: boolean;
  private usage: Usage = emptyUsage();
  private savedTitle: string;

  private constructor(meta: SessionMeta, autoSave: boolean) {
    this.meta = meta;
    this.autoSave = autoSave;
    this.file = sessionFile(meta.id);
    this.dir = sessionDir(meta.id);
    this.savedTitle = meta.title;
  }

  static create(opts: {
    cwd: string;
    provider: string;
    model: string;
    traceId: string;
    title?: string;
    autoSave?: boolean;
    titleMaxLength?: number;
  }): SessionStore {
    const now = new Date();
    const meta: SessionMeta = {
      type: "meta",
      version: 1,
      id: generateSessionId(now),
      createdAt: now.toISOString(),
      cwd: path.resolve(opts.cwd),
      provider: opts.provider,
      model: opts.model,
      traceId: opts.traceId,
      title: opts.title ? truncateText(opts.title, opts.titleMaxLength ?? 70) : "New session",
      tcliVersion: TCLI_VERSION,
    };
    const store = new SessionStore(meta, opts.autoSave ?? true);
    if (store.autoSave) {
      ensureDirSync(sessionsDir());
      ensureDirSync(store.dir);
      appendLineSync(store.file, JSON.stringify(meta));
    }
    return store;
  }

  static resume(id: string, opts: { autoSave?: boolean } = {}): { store: SessionStore; loaded: LoadedSession } {
    const loaded = readSession(id);
    const store = new SessionStore(loaded.meta, opts.autoSave ?? true);
    store.usage = loaded.usage;
    return { store, loaded };
  }

  get id(): string {
    return this.meta.id;
  }

  get usageTotal(): Usage {
    return { ...this.usage };
  }

  private append(event: SessionEvent): void {
    if (!this.autoSave) return;
    ensureDirSync(this.dir);
    try {
      appendLineSync(this.file, JSON.stringify(event));
    } catch {
      /* session persistence must not break the agent */
    }
  }

  appendMessage(message: ChatMessage): void {
    this.append({ type: "message", at: new Date().toISOString(), message });
  }

  recordUsage(usage: Usage, model?: string): void {
    this.usage = addUsage(this.usage, usage);
    this.append({ type: "usage", at: new Date().toISOString(), usage, model });
  }

  recordTodo(todos: TodoItem[]): void {
    this.append({ type: "todo", at: new Date().toISOString(), todos });
  }

  recordSnapshot(snapshot: SnapshotRecord): void {
    this.append({ type: "snapshot", at: new Date().toISOString(), snapshot });
  }

  recordCheckpoint(checkpoint: CheckpointInfo): void {
    this.append({ type: "checkpoint", at: new Date().toISOString(), checkpoint });
  }

  recordCompaction(summary: string, keepMessages: number, beforeTokens: number, afterTokens: number): void {
    this.append({
      type: "compaction",
      at: new Date().toISOString(),
      summary,
      keepMessages,
      beforeTokens,
      afterTokens,
    });
  }

  recordNote(text: string): void {
    this.append({ type: "note", at: new Date().toISOString(), text });
  }

  ensureTitle(prompt: string, maxLength = 70): void {
    if (this.savedTitle && this.savedTitle !== "New session") return;
    const title = titleFromPrompt(prompt, maxLength);
    if (!title) return;
    this.savedTitle = title;
    this.meta.title = title;
    this.append({ type: "title", at: new Date().toISOString(), title });
  }

  setTitle(title: string): void {
    const trimmed = truncateText(title.trim(), 200);
    if (!trimmed) return;
    this.savedTitle = trimmed;
    this.meta.title = trimmed;
    this.append({ type: "title", at: new Date().toISOString(), title: trimmed });
  }

  /** Session directory (used for checkpoints). */
  projectRelativeCwd(): string {
    return toPosix(path.relative(this.meta.cwd, this.meta.cwd)) || ".";
  }
}
