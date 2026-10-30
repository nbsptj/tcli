import { describe, expect, test } from "bun:test";
import { KeyParser, type Key } from "../src/ui/keys.ts";
import { LineEditor, detectCompletion, applyCompletion } from "../src/ui/editor.ts";
import { Screen } from "../src/ui/screen.ts";
import { Transcript, summarizeToolInput, todoLines } from "../src/ui/transcript.ts";
import { textLine, wrapSegments, stringWidth, paint, detectColorMode, styledDiffLines } from "../src/ui/ansi.ts";
import { HeadlessRenderer } from "../src/ui/headless.ts";
import type { ChatMessage } from "../src/types.ts";
import type { AgentEvent } from "../src/agent/events.ts";

describe("key parser", () => {
  test("parses common keys in one chunk", () => {
    const parser = new KeyParser();
    const keys = parser.feed("ab\r\t\u007f\x03\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F");
    expect(keys.map((k) => k.type)).toEqual([
      "char",
      "char",
      "enter",
      "tab",
      "backspace",
      "ctrl",
      "up",
      "down",
      "right",
      "left",
      "home",
      "end",
    ]);
    expect(keys[0]).toEqual({ type: "char", char: "a" });
    expect(keys[5]).toEqual({ type: "ctrl", char: "C" });
  });

  test("buffers split escape sequences and flushes a lone Esc", () => {
    const parser = new KeyParser();
    expect(parser.feed("\x1b")).toEqual([]);
    expect(parser.hasPending()).toBe(true);
    expect(parser.feed("[")).toEqual([]);
    expect(parser.feed("A")).toEqual([{ type: "up" }]);
    expect(parser.feed("\x1b")).toEqual([]);
    expect(parser.flushEscape()).toEqual([{ type: "esc" }]);
  });

  test("parses bracketed paste including newlines", () => {
    const parser = new KeyParser();
    const keys: Key[] = [];
    for (const chunk of ["\x1b[200~line", "1\nline2\x1b[20", "1~"]) keys.push(...parser.feed(chunk));
    expect(keys).toEqual([{ type: "paste", text: "line1\nline2" }]);
  });

  test("parses kitty keyboard modifiers", () => {
    const parser = new KeyParser();
    expect(parser.feed("\x1b[13;2u")).toEqual([{ type: "newline" }]);
    expect(parser.feed("\x1b[13u")).toEqual([{ type: "enter" }]);
    expect(parser.feed("\x1b[97;5u")).toEqual([{ type: "ctrl", char: "A" }]);
    expect(parser.feed("\x1b[9;2u")).toEqual([{ type: "tab", shift: true }]);
    expect(parser.feed("\x1b[1;5C")).toEqual([{ type: "right", ctrl: true, alt: false, shift: false }]);
  });

  test("alt keys, delete and page keys", () => {
    const parser = new KeyParser();
    expect(parser.feed("\x1bx")).toEqual([{ type: "alt", char: "x" }]);
    expect(parser.feed("\x1b[3~")).toEqual([{ type: "delete" }]);
    expect(parser.feed("\x1b[5~")).toEqual([{ type: "pageup" }]);
    expect(parser.feed("\x1b[6~")).toEqual([{ type: "pagedown" }]);
  });
});

describe("line editor", () => {
  test("insert, move and delete", () => {
    const editor = new LineEditor();
    editor.insert("hello");
    editor.moveLeft();
    editor.backspace();
    expect(editor.text).toBe("helo");
    editor.deleteForward();
    expect(editor.text).toBe("hel");
    editor.insert("lo world");
    editor.moveHome();
    editor.deleteToLineEnd();
    expect(editor.text).toBe("");
  });

  test("history navigation preserves the draft", () => {
    const editor = new LineEditor();
    editor.setHistory(["one", "two"]);
    editor.insert("draft");
    expect(editor.historyPrev()).toBe(true);
    expect(editor.text).toBe("two");
    expect(editor.historyPrev()).toBe(true);
    expect(editor.text).toBe("one");
    editor.historyNext();
    editor.historyNext();
    expect(editor.text).toBe("draft");
    editor.setText("submitted");
    expect(editor.submit()).toBe("submitted");
    expect(editor.isEmpty).toBe(true);
    expect(editor.historyEntries.at(-1)).toBe("submitted");
  });

  test("word motions and multiline navigation", () => {
    const editor = new LineEditor();
    editor.insert("one two three");
    editor.moveLeft(true);
    expect(editor.cursorIndex).toBe(8);
    editor.deleteWordBackward();
    expect(editor.text).toBe("one three");
    editor.setText("abc\ndef");
    editor.moveHome();
    expect(editor.moveUp()).toBe(true);
    expect(editor.cursorIndex).toBe(0);
    editor.moveEnd();
    editor.moveLeft();
    expect(editor.moveDown()).toBe(true);
    expect(editor.cursorIndex).toBe(6);
  });

  test("renders wrapping, prompt and cursor position", () => {
    const editor = new LineEditor();
    editor.setText("hello world this is a long line");
    const render = editor.render(16, "› ", 3);
    expect(render.lines[0]!.startsWith("› ")).toBe(true);
    expect(render.lines.length).toBeGreaterThan(1);
    expect(render.cursorRow).toBe(render.lines.length - 1);
    expect(render.cursorCol).toBeGreaterThan(0);
    const multiline = new LineEditor();
    multiline.setText("a\nb\nc");
    const r2 = multiline.render(20, "› ", 2);
    expect(r2.lines.length).toBe(2);
    expect(r2.cursorRow).toBe(1);
    expect(r2.totalLines).toBe(3);
  });

  test("detects @path and /command tokens", () => {
    expect(detectCompletion("@src/fo", 7)).toEqual({ kind: "path", query: "src/fo", start: 0 });
    expect(detectCompletion("look @src/a", 11)?.query).toBe("src/a");
    expect(detectCompletion("mail me@example.com", 18)).toBeNull();
    expect(detectCompletion("/he", 3)).toEqual({ kind: "command", query: "he", start: 0 });
    expect(detectCompletion("/help ", 6)).toBeNull();
    expect(detectCompletion('@"a b', 5)?.kind).toBe("path");
  });

  test("applies path and command completions", () => {
    const editor = new LineEditor();
    editor.setText("@src/fo");
    const ctx = detectCompletion(editor.text, editor.cursorIndex)!;
    applyCompletion(editor, ctx, { path: "src/foo.ts", isDir: false });
    expect(editor.text).toBe("@src/foo.ts ");
    const dirEditor = new LineEditor();
    dirEditor.setText("@sr");
    applyCompletion(dirEditor, detectCompletion(dirEditor.text, dirEditor.cursorIndex)!, { path: "src/", isDir: true });
    expect(dirEditor.text).toBe("@src/");
    const commandEditor = new LineEditor();
    commandEditor.setText("/he");
    applyCompletion(commandEditor, detectCompletion(commandEditor.text, commandEditor.cursorIndex)!, {
      name: "help",
      kind: "command",
    });
    expect(commandEditor.text).toBe("/help ");
  });
});

describe("screen and ANSI", () => {
  test("renders only changed rows and positions the cursor", () => {
    const writes: string[] = [];
    const screen = new Screen({
      write: (chunk) => writes.push(chunk),
      mode: "none",
      theme: "dark",
      width: 20,
      height: 4,
    });
    screen.render([textLine("hello")], { row: 0, col: 5 });
    expect(writes[0]).toContain("\u001b[2J");
    expect(writes[0]).toContain("hello");
    expect(writes[0]).toContain("\u001b[?25h");
    const first = writes.length;
    screen.render([textLine("hello")], { row: 0, col: 5 });
    expect(writes.length).toBe(first + 1);
    expect(writes.at(-1)).toContain("\u001b[1;6H");
    screen.render([textLine("bye")], { row: 0, col: 3 });
    expect(writes.at(-1)).toContain("bye");
    expect(writes.at(-1)).not.toContain("hello");
  });

  test("widths, wrapping and colors", () => {
    expect(stringWidth("你好a")).toBe(5);
    const wrapped = wrapSegments([{ text: "abcdef" }], 3);
    expect(wrapped.map((l) => l.map((s) => s.text).join(""))).toEqual(["abc", "def"]);
    const colored = paint("x", { fg: "error", bold: true }, "dark", "none");
    expect(colored).toBe("x");
    expect(paint("x", { fg: "error" }, "dark", "ansi16")).toContain("\u001b[");
    expect(detectColorMode({ isTTY: false }, "auto")).toBe("none");
    expect(detectColorMode({ isTTY: true }, "never")).toBe("none");
    expect(styledDiffLines("+a\n-b\n@@ x").map((l) => l[0]!.style?.fg)).toEqual(["diffAdd", "diffDel", "diffMeta"]);
  });
});

describe("transcript", () => {
  test("renders user, assistant, tool and diff blocks", () => {
    const transcript = new Transcript();
    transcript.addUser("do the thing");
    transcript.appendAssistant("Working on it.\n\n```ts\nconst x = 1;\n```");
    transcript.startTool({ id: "c1", name: "read_file", input: { path: "a.ts" }, kind: "read" });
    transcript.finishTool("c1", true, "Read a.ts", "+added\n-removed");
    transcript.addNotice("warn", "careful");
    const lines = transcript.render(80);
    const text = lines.map((line) => line.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("do the thing");
    expect(text).toContain("Working on it.");
    expect(text).toContain("read_file");
    expect(text).toContain("Read a.ts");
    expect(text).toContain("+added");
    expect(text).toContain("careful");
    expect(text).toContain("const x = 1;");
  });

  test("restores messages and hides reasoning by default", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer", reasoning: "thought" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "glob", arguments: { pattern: "*.ts" } }] },
      { role: "tool", toolCallId: "c1", toolName: "glob", content: "a.ts" },
    ];
    const transcript = new Transcript();
    transcript.restore(messages);
    const hidden = transcript.render(80).map((l) => l.map((s) => s.text).join("")).join("\n");
    expect(hidden).not.toContain("thought");
    const shown = transcript.render(80, { showReasoning: true }).map((l) => l.map((s) => s.text).join("")).join("\n");
    expect(shown).toContain("thought");
    expect(shown).toContain("glob");
  });

  test("tool summaries and todo lines", () => {
    expect(summarizeToolInput("bash", { command: "npm test\nmore" })).toBe("npm test");
    expect(summarizeToolInput("read_file", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolInput("grep", { pattern: "foo", path: "src" })).toBe("/foo/ in src");
    expect(summarizeToolInput("task", { description: "research" })).toBe("research");
    const lines = todoLines(
      [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
      ],
      40,
    );
    expect(lines.map((l) => l[0]!.text).join("\n")).toContain("Plan 1/2");
  });

  test("clear and empty", () => {
    const transcript = new Transcript();
    expect(transcript.isEmpty).toBe(true);
    transcript.addUser("x");
    expect(transcript.isEmpty).toBe(false);
    transcript.clear();
    expect(transcript.isEmpty).toBe(true);
    expect(transcript.render(20)).toEqual([]);
  });
});

describe("headless renderer", () => {
  function sink(): { write: (s: string) => void; text: string } {
    let text = "";
    return { write: (s: string) => (text += s), get text() { return text; } };
  }

  test("streams text to stdout and activity to stderr", () => {
    const out = sink();
    const err = sink();
    const renderer = new HeadlessRenderer({
      out: out as unknown as NodeJS.WriteStream,
      err: err as unknown as NodeJS.WriteStream,
      colorMode: "none",
    });
    const events: AgentEvent[] = [
      { type: "text", text: "hello" },
      { type: "tool_start", invocation: { id: "1", name: "read_file", input: { path: "a.ts" }, kind: "read" } },
      {
        type: "tool_result",
        outcome: { invocation: { id: "1", name: "read_file", input: { path: "a.ts" }, kind: "read" }, ok: true, content: "x", durationMs: 1 },
        display: { summary: "Read a.ts" },
      },
      { type: "notice", level: "info", text: "note" },
      { type: "done", reason: "end", text: "hello" },
    ];
    for (const event of events) renderer.handle(event);
    expect(out.text).toBe("hello\n");
    expect(err.text).toContain("read_file");
    expect(err.text).toContain("Read a.ts");
    expect(err.text).toContain("note");
  });

  test("suppresses stdout in JSON mode", () => {
    const out = sink();
    const renderer = new HeadlessRenderer({
      out: out as unknown as NodeJS.WriteStream,
      err: sink() as unknown as NodeJS.WriteStream,
      emitText: false,
      showActivity: false,
    });
    renderer.handle({ type: "text", text: "hidden" });
    renderer.handle({ type: "tool_start", invocation: { id: "1", name: "glob", input: {}, kind: "read" } });
    renderer.handle({ type: "done", reason: "end", text: "hidden" });
    expect(out.text).toBe("");
  });
});
