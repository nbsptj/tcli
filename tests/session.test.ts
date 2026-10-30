import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { SessionStore, readSession, listSessions, latestSession, deleteSession } from "../src/session/index.ts";
import { sessionToMarkdown } from "../src/session/export.ts";
import { CheckpointStore } from "../src/context/checkpoint.ts";
import { SnapshotStore } from "../src/context/snapshots.ts";
import { cleanup, tempDir } from "./helpers.ts";

let home = "";
const originalHome = process.env.TCLI_HOME;

beforeEach(() => {
  home = tempDir("tcli-session-home-");
  process.env.TCLI_HOME = home;
});

afterEach(() => {
  cleanup(home);
  if (originalHome === undefined) delete process.env.TCLI_HOME;
  else process.env.TCLI_HOME = originalHome;
});

describe("session persistence", () => {
  test("writes and reloads messages, usage, todos and snapshots", () => {
    const cwd = tempDir("tcli-session-ws-");
    try {
      const store = SessionStore.create({
        cwd,
        provider: "mock",
        model: "mock-model",
        traceId: "trace_x",
        autoSave: true,
      });
      store.ensureTitle("Fix the login test", 70);
      store.appendMessage({ role: "user", content: "hello", at: new Date().toISOString() });
      store.appendMessage({
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }],
      });
      store.appendMessage({ role: "tool", toolCallId: "call_1", toolName: "read_file", content: "file body" });
      store.recordUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, "mock-model");
      store.recordTodo([{ content: "step", status: "in_progress" }]);
      store.recordSnapshot({
        path: path.join(cwd, "a.ts"),
        hash: "abc",
        size: 9,
        mtimeMs: 1,
        readAt: new Date().toISOString(),
      });

      const loaded = readSession(store.id);
      expect(loaded.meta.title).toBe("Fix the login test");
      expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      expect(loaded.messages[1]!.toolCalls?.[0]!.name).toBe("read_file");
      expect(loaded.usage.inputTokens).toBe(10);
      expect(loaded.usage.outputTokens).toBe(5);
      expect(loaded.todos[0]!.content).toBe("step");
      expect(loaded.snapshots.length).toBe(1);
      expect(loaded.warnings).toEqual([]);

      const sessions = listSessions({ cwd });
      expect(sessions.some((s) => s.id === store.id)).toBe(true);
      expect(latestSession(cwd)?.id).toBe(store.id);
      const markdown = sessionToMarkdown(loaded);
      expect(markdown).toContain("# Fix the login test");
      expect(markdown).toContain("read_file");
      expect(markdown).toContain("hello");
    } finally {
      cleanup(cwd);
    }
  });

  test("ignores a crash-truncated final JSONL line", () => {
    const cwd = tempDir("tcli-session-ws-");
    try {
      const store = SessionStore.create({ cwd, provider: "mock", model: "m", traceId: "t", autoSave: true });
      store.appendMessage({ role: "user", content: "before crash" });
      fs.appendFileSync(store.file, '{"type":"message","message":{"role":');
      const loaded = readSession(store.id);
      expect(loaded.messages.length).toBe(1);
      expect(loaded.warnings.length).toBe(1);
    } finally {
      cleanup(cwd);
    }
  });

  test("compaction events replay into summary plus recent messages", () => {
    const cwd = tempDir("tcli-session-ws-");
    try {
      const store = SessionStore.create({ cwd, provider: "mock", model: "m", traceId: "t", autoSave: true });
      const messages = [
        { role: "user" as const, content: "one" },
        { role: "assistant" as const, content: "a1" },
        { role: "user" as const, content: "two" },
        { role: "assistant" as const, content: "a2" },
        { role: "user" as const, content: "three" },
      ];
      for (const message of messages) store.appendMessage(message);
      store.recordCompaction("earlier summary", 2, 100, 50);
      store.appendMessage({ role: "assistant", content: "after" });
      const loaded = readSession(store.id);
      expect(loaded.messages.length).toBe(4);
      expect(loaded.messages[0]!.role).toBe("system");
      expect(loaded.messages[0]!.content).toContain("earlier summary");
      expect(loaded.messages.slice(1).map((m) => m.content)).toEqual(["a2", "three", "after"]);
    } finally {
      cleanup(cwd);
    }
  });

  test("delete removes the session and checkpoints", () => {
    const cwd = tempDir("tcli-session-ws-");
    try {
      const store = SessionStore.create({ cwd, provider: "mock", model: "m", traceId: "t", autoSave: true });
      fs.mkdirSync(store.dir, { recursive: true });
      fs.writeFileSync(path.join(store.dir, "x.txt"), "x");
      deleteSession(store.id);
      expect(() => readSession(store.id)).toThrow();
      expect(fs.existsSync(store.dir)).toBe(false);
      expect(listSessions({ cwd }).length).toBe(0);
    } finally {
      cleanup(cwd);
    }
  });
});

describe("checkpoints and snapshots", () => {
  test("undo restores an edited file", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "file.txt");
      fs.writeFileSync(file, "old");
      const store = new CheckpointStore(path.join(dir, "checkpoints"));
      const cp = store.create(file, "old", { tool: "write_file" });
      fs.writeFileSync(file, "new");
      store.finalize(cp.id, "new");
      const result = store.undoLast();
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("old");
      expect(store.undoLast().ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("undo deletes a file that did not exist before", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "new.txt");
      const store = new CheckpointStore(path.join(dir, "checkpoints"));
      const cp = store.create(file, null, { tool: "write_file" });
      fs.writeFileSync(file, "fresh");
      store.finalize(cp.id, "fresh");
      const result = store.undoLast();
      expect(result.ok).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("refuses to overwrite external edits unless forced", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "file.txt");
      fs.writeFileSync(file, "old");
      const store = new CheckpointStore(path.join(dir, "checkpoints"));
      const cp = store.create(file, "old", { tool: "edit_file" });
      fs.writeFileSync(file, "agent");
      store.finalize(cp.id, "agent");
      fs.writeFileSync(file, "human");
      expect(store.undoLast().ok).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe("human");
      const forced = store.undoLast({ force: true });
      expect(forced.ok).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("old");
    } finally {
      cleanup(dir);
    }
  });

  test("snapshot verification detects missing reads and external changes", () => {
    const store = new SnapshotStore();
    const file = "/tmp/example.txt";
    expect(store.verify(file, "a", { requireRead: true }).ok).toBe(false);
    expect(store.verify(file, "a", { requireRead: false }).ok).toBe(true);
    store.recordRead(file, "a");
    expect(store.verify(file, "a", { requireRead: true }).ok).toBe(true);
    const stale = store.verify(file, "b", { requireRead: true });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale");
  });
});
