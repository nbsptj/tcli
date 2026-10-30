import { charWidth } from "./ansi.ts";

export interface EditorRender {
  /** Display lines, including prompt/continuation prefixes. */
  lines: string[];
  /** Cursor position within `lines` (0-based). */
  cursorRow: number;
  /** Visual column (0-based, display width). */
  cursorCol: number;
  totalLines: number;
}

/**
 * Multiline input editor with a code-point based cursor, word motions, history
 * and width-aware wrapping. Rendering is plain text; the TUI styles the prompt
 * separately and positions the terminal cursor.
 */
export class LineEditor {
  private chars: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = "";

  get text(): string {
    return this.chars.join("");
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  get historyEntries(): string[] {
    return [...this.history];
  }

  setHistory(entries: string[]): void {
    this.history = entries.filter((e) => e.trim().length > 0);
    this.historyIndex = -1;
  }

  addHistory(entry: string): void {
    const trimmed = entry.replace(/\s+$/, "");
    if (!trimmed) return;
    if (this.history[this.history.length - 1] === trimmed) return;
    this.history.push(trimmed);
    if (this.history.length > 200) this.history.shift();
  }

  setText(text: string): void {
    this.chars = [...text];
    this.cursor = this.chars.length;
    this.historyIndex = -1;
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = "";
  }

  insert(text: string): void {
    if (!text) return;
    const incoming = [...text];
    this.chars.splice(this.cursor, 0, ...incoming);
    this.cursor += incoming.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor--;
  }

  deleteForward(): void {
    if (this.cursor >= this.chars.length) return;
    this.chars.splice(this.cursor, 1);
  }

  deleteWordBackward(): void {
    const start = this.wordStart();
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
  }

  deleteToLineStart(): void {
    const text = this.text;
    const before = text.slice(0, this.cursor);
    const lineStart = before.lastIndexOf("\n") + 1;
    this.chars.splice(lineStart, this.cursor - lineStart);
    this.cursor = lineStart;
  }

  deleteToLineEnd(): void {
    const text = this.text;
    const after = text.slice(this.cursor);
    const newline = after.indexOf("\n");
    const end = newline >= 0 ? this.cursor + newline : this.chars.length;
    this.chars.splice(this.cursor, end - this.cursor);
  }

  moveLeft(byWord = false): void {
    this.cursor = byWord ? this.wordStart() : Math.max(0, this.cursor - 1);
  }

  moveRight(byWord = false): void {
    this.cursor = byWord ? this.wordEnd() : Math.min(this.chars.length, this.cursor + 1);
  }

  moveHome(): void {
    const before = this.text.slice(0, this.cursor);
    this.cursor = before.lastIndexOf("\n") + 1;
  }

  moveEnd(): void {
    const after = this.text.slice(this.cursor);
    const newline = after.indexOf("\n");
    this.cursor = newline >= 0 ? this.cursor + newline : this.chars.length;
  }

  moveUp(): boolean {
    const text = this.text;
    const before = text.slice(0, this.cursor);
    const lineStart = before.lastIndexOf("\n") + 1;
    if (lineStart === 0) return false;
    const column = this.cursor - lineStart;
    const prevLineStart = text.slice(0, lineStart - 1).lastIndexOf("\n") + 1;
    const prevLine = text.slice(prevLineStart, lineStart - 1);
    this.cursor = prevLineStart + Math.min(column, prevLine.length);
    return true;
  }

  moveDown(): boolean {
    const text = this.text;
    const after = text.slice(this.cursor);
    const newline = after.indexOf("\n");
    if (newline < 0) return false;
    const lineStart = this.cursor - (text.slice(0, this.cursor).lastIndexOf("\n") + 1);
    const nextStart = this.cursor + newline + 1;
    const nextEnd = text.indexOf("\n", nextStart);
    const nextLine = text.slice(nextStart, nextEnd >= 0 ? nextEnd : text.length);
    this.cursor = nextStart + Math.min(lineStart, nextLine.length);
    return true;
  }

  historyPrev(): boolean {
    if (!this.history.length) return false;
    if (this.historyIndex === -1) {
      this.draft = this.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return true;
    }
    this.applyHistoryValue(this.history[this.historyIndex]!);
    return true;
  }

  historyNext(): boolean {
    if (this.historyIndex === -1) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.applyHistoryValue(this.history[this.historyIndex]!);
    } else {
      this.historyIndex = -1;
      this.applyHistoryValue(this.draft);
    }
    return true;
  }

  private applyHistoryValue(value: string): void {
    this.chars = [...value];
    this.cursor = this.chars.length;
  }

  private isWordChar(ch: string | undefined): boolean {
    return Boolean(ch && /[A-Za-z0-9_]/.test(ch));
  }

  private wordStart(): number {
    let i = this.cursor;
    while (i > 0 && !this.isWordChar(this.chars[i - 1])) i--;
    while (i > 0 && this.isWordChar(this.chars[i - 1])) i--;
    return i;
  }

  private wordEnd(): number {
    let i = this.cursor;
    while (i < this.chars.length && !this.isWordChar(this.chars[i])) i++;
    while (i < this.chars.length && this.isWordChar(this.chars[i])) i++;
    return i;
  }

  /** Consume the input (without clearing) for submission. */
  take(): string {
    return this.text.trim();
  }

  submit(): string {
    const text = this.text;
    this.addHistory(text);
    this.clear();
    return text.trim();
  }

  render(width: number, prompt = "› ", maxLines = 6): EditorRender {
    const safeWidth = Math.max(8, width);
    const promptWidth = [...prompt].reduce((sum, ch) => sum + charWidth(ch.codePointAt(0) ?? 0), 0);
    const contentWidth = Math.max(4, safeWidth - promptWidth);
    const rawLines: string[][] = [[]];
    let line = rawLines[0]!;
    let col = 0;
    let cursorRow = 0;
    let cursorCol = 0;
    for (let i = 0; i < this.chars.length; i++) {
      const ch = this.chars[i]!;
      if (i === this.cursor) {
        cursorRow = rawLines.length - 1;
        cursorCol = col;
      }
      if (ch === "\n") {
        rawLines.push([]);
        line = rawLines[rawLines.length - 1]!;
        col = 0;
        continue;
      }
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (col + w > contentWidth) {
        rawLines.push([]);
        line = rawLines[rawLines.length - 1]!;
        col = 0;
      }
      line.push(ch);
      col += w;
    }
    if (this.cursor >= this.chars.length) {
      cursorRow = rawLines.length - 1;
      cursorCol = col;
    }
    const totalLines = rawLines.length;
    let start = 0;
    if (totalLines > maxLines) {
      start = Math.max(0, Math.min(cursorRow - maxLines + 1, totalLines - maxLines));
    }
    const visible = rawLines.slice(start, start + maxLines);
    const lines = visible.map((parts, index) => {
      const prefix = index === 0 && start === 0 ? prompt : " ".repeat(promptWidth);
      return prefix + parts.join("");
    });
    return {
      lines,
      cursorRow: Math.max(0, cursorRow - start),
      cursorCol: promptWidth + cursorCol,
      totalLines,
    };
  }
}

export interface CompletionContext {
  kind: "path" | "command";
  query: string;
  /** Absolute index in the input where replacement starts. */
  start: number;
}

/** Detect whether the cursor is inside an `@path` or `/command` token. */
export function detectCompletion(text: string, cursor: number): CompletionContext | null {
  const before = text.slice(0, cursor);
  if (before.startsWith("/") && !/\s/.test(before)) {
    return { kind: "command", query: before.slice(1), start: 0 };
  }
  // Quoted paths may contain spaces; detect an unclosed @'...' / @"..."
  const quoted = /(^|[\s(])@(["'])([^"']*)$/.exec(before);
  if (quoted) {
    return { kind: "path", query: quoted[3]!, start: quoted.index + quoted[1]!.length };
  }
  let at = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = before[i]!;
    if (ch === "@") {
      const prev = i > 0 ? before[i - 1]! : "";
      if (!prev || /[\s("'`]/.test(prev)) {
        at = i;
        break;
      }
    }
    if (/\s/.test(ch) || ch === '"' || ch === "'") {
      // Allow quoted paths to contain spaces while completing.
      if (ch === '"' || ch === "'") {
        const quote = ch;
        const nextAt = before.lastIndexOf("@", i);
        if (nextAt >= 0) {
          const prev = nextAt > 0 ? before[nextAt - 1]! : "";
          if ((!prev || /[\s("'`]/.test(prev)) && before[nextAt + 1] === quote) {
            at = nextAt;
            break;
          }
        }
      }
      break;
    }
  }
  if (at < 0) return null;
  let query = before.slice(at + 1);
  if ((query.startsWith('"') && !query.endsWith('"')) || (query.startsWith("'") && !query.endsWith("'"))) {
    query = query.slice(1);
  } else if (query.startsWith('"') || query.startsWith("'")) {
    return null;
  }
  return { kind: "path", query, start: at };
}

export function applyCompletion(
  editor: LineEditor,
  context: CompletionContext,
  completion: { path: string; isDir: boolean } | { name: string; kind: "command" },
): void {
  const text = editor.text;
  if (context.kind === "command" && "kind" in completion && completion.kind === "command") {
    const replacement = `/${completion.name} `;
    editor.setText(replacement + text.slice(editor.cursorIndex));
    return;
  }
  if (!("path" in completion)) return;
  const needsQuote = /\s/.test(completion.path);
  const inserted = needsQuote ? `@"${completion.path}"` : `@${completion.path}`;
  const suffix = completion.isDir ? "" : " ";
  const rest = text.slice(editor.cursorIndex);
  const before = text.slice(0, context.start);
  editor.setText(before + inserted + (completion.isDir ? "" : suffix) + rest);
  if (completion.isDir && needsQuote) {
    // Move the cursor inside the closing quote so further completion can continue.
    editor.setText(before + inserted + rest);
  }
}
