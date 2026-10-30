import type { ChatMessage, TodoItem, ToolInvocation } from "../types.ts";
import { truncateText, toOneLine } from "../utils/strings.ts";
import {
  segmentsWidth,
  styledDiffLines,
  textLine,
  wrapSegments,
  type DisplayLine,
  type Style,
} from "./ansi.ts";

export type ToolStatus = "running" | "ok" | "error";

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "command"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      inputSummary: string;
      status: ToolStatus;
      summary?: string;
      diff?: string;
      denied?: boolean;
    }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string };

export interface TranscriptRenderOptions {
  spinner?: string;
  showReasoning?: boolean;
}

const BLANK: DisplayLine = [];

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  let summary = "";
  switch (name) {
    case "bash":
      summary = str(input.command).split("\n")[0] ?? "";
      break;
    case "read_file":
    case "write_file":
    case "edit_file":
      summary = str(input.path);
      break;
    case "glob":
      summary = str(input.pattern);
      break;
    case "grep":
      summary = `/${str(input.pattern)}/` + (str(input.path) ? ` in ${str(input.path)}` : "");
      break;
    case "git_status":
      summary = str(input.path) ?? "";
      break;
    case "git_diff":
      summary = [str(input.path), input.staged ? "--staged" : ""].filter(Boolean).join(" ");
      break;
    case "todo":
      summary = `${Array.isArray(input.todos) ? input.todos.length : 0} item(s)`;
      break;
    case "task":
      summary = str(input.description);
      break;
    case "web_fetch":
      summary = str(input.url);
      break;
    case "web_search":
      summary = str(input.query);
      break;
    default:
      summary = Object.entries(input)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ");
      break;
  }
  return toOneLine(summary, 100);
}

function stripReferenceBlocks(text: string): string {
  return text
    .replace(/\n*<file-references>[\s\S]*?<\/file-references>\s*$/m, "\n… [referenced files]")
    .trim();
}

function parseInline(text: string, base: Style): DisplayLine {
  const segments: DisplayLine = [];
  let rest = text;
  // Inline code and bold are rendered as styled segments; markers are removed.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rest))) {
    if (match.index > last) segments.push({ text: rest.slice(last, match.index), style: base });
    if (match[1] !== undefined) segments.push({ text: match[1], style: { ...base, fg: "accent" } });
    else segments.push({ text: match[2] ?? "", style: { ...base, bold: true } });
    last = match.index + match[0].length;
  }
  if (last < rest.length) segments.push({ text: rest.slice(last), style: base });
  if (!segments.length) segments.push({ text: "", style: base });
  return segments;
}

function renderMarkdown(text: string, width: number, base: Style, options: TranscriptRenderOptions): DisplayLine[] {
  const out: DisplayLine[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(textLine(raw.trim(), { fg: "muted" }));
      continue;
    }
    if (inFence) {
      out.push(...wrapSegments([{ text: raw, style: { fg: "text", dim: true } }], width));
      continue;
    }
    if (/^\s*#{1,6}\s+/.test(raw)) {
      const heading = raw.replace(/^\s*#{1,6}\s+/, "");
      out.push(...wrapSegments([{ text: heading, style: { ...base, bold: true, fg: "accent" } }], width));
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      const body = raw.replace(/^\s*[-*]\s+/, "");
      out.push(...wrapSegments([{ text: "• ", style: { ...base, fg: "accent" } }, ...parseInline(body, base)], width));
      continue;
    }
    if (!raw.trim()) {
      out.push(BLANK);
      continue;
    }
    out.push(...wrapSegments(parseInline(raw, base), width));
  }
  void options;
  return out;
}

function withPrefix(prefix: string, prefixStyle: Style, lines: DisplayLine[]): DisplayLine[] {
  return lines.map((line, index) => {
    if (index === 0) return [{ text: prefix, style: prefixStyle }, ...line];
    return [{ text: " ".repeat(segmentsWidth([{ text: prefix }])), style: prefixStyle }, ...line];
  });
}

/**
 * Renderable conversation transcript. Blocks are appended/updated by the TUI;
 * rendered lines are cached per width and invalidated on mutation.
 */
export class Transcript {
  private blocks: Block[] = [];
  private activeAssistant?: Extract<Block, { kind: "assistant" }>;
  private activeReasoning?: Extract<Block, { kind: "reasoning" }>;
  private cache?: { width: number; optionsKey: string; lines: DisplayLine[] };

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  allBlocks(): readonly Block[] {
    return this.blocks;
  }

  clear(): void {
    this.blocks = [];
    this.activeAssistant = undefined;
    this.activeReasoning = undefined;
    this.cache = undefined;
  }

  addUser(text: string): void {
    this.activeAssistant = undefined;
    this.activeReasoning = undefined;
    this.blocks.push({ kind: "user", text: stripReferenceBlocks(text) });
    this.invalidate();
  }

  addCommand(text: string): void {
    this.blocks.push({ kind: "command", text });
    this.invalidate();
  }

  appendAssistant(text: string): void {
    if (!text) return;
    if (!this.activeAssistant) {
      this.activeAssistant = { kind: "assistant", text: "" };
      this.blocks.push(this.activeAssistant);
    }
    this.activeAssistant.text += text;
    this.invalidate();
  }

  appendReasoning(text: string): void {
    if (!text) return;
    if (!this.activeReasoning) {
      this.activeReasoning = { kind: "reasoning", text: "" };
      this.blocks.push(this.activeReasoning);
    }
    this.activeReasoning.text += text;
    this.invalidate();
  }

  startTool(invocation: ToolInvocation, _preview?: string): void {
    this.activeAssistant = undefined;
    this.activeReasoning = undefined;
    this.blocks.push({
      kind: "tool",
      id: invocation.id,
      name: invocation.name,
      inputSummary: summarizeToolInput(invocation.name, invocation.input),
      status: "running",
    });
    this.invalidate();
  }

  finishTool(id: string, ok: boolean, summary?: string, diff?: string, denied?: boolean): void {
    const block = [...this.blocks].reverse().find((b) => b.kind === "tool" && b.id === id) as
      | Extract<Block, { kind: "tool" }>
      | undefined;
    if (!block) return;
    block.status = ok ? "ok" : "error";
    block.summary = summary;
    if (diff) block.diff = diff;
    block.denied = denied;
    this.invalidate();
  }

  addNotice(level: "info" | "warn" | "error", text: string): void {
    this.blocks.push({ kind: "notice", level, text });
    this.invalidate();
  }

  addError(text: string): void {
    this.blocks.push({ kind: "error", text });
    this.invalidate();
  }

  addSystem(text: string): void {
    this.blocks.push({ kind: "system", text });
    this.invalidate();
  }

  restore(messages: ChatMessage[]): void {
    this.clear();
    for (const message of messages) {
      if (message.role === "system") {
        if (message.content.startsWith("[Conversation summary")) {
          const body = message.content.replace(/^\[[^\]]+\]\n?/, "");
          this.addSystem(`Earlier context compacted:\n${truncateText(body, 1200)}`);
        }
        continue;
      }
      if (message.role === "user") {
        this.addUser(message.content);
        continue;
      }
      if (message.role === "assistant") {
        if (message.reasoning) this.appendReasoning(message.reasoning);
        if (message.content) this.appendAssistant(message.content);
        for (const call of message.toolCalls ?? []) {
          this.startTool({ id: call.id, name: call.name, input: call.arguments, kind: "read" });
        }
        continue;
      }
      if (message.role === "tool") {
        this.finishTool(
          message.toolCallId ?? "",
          !message.isError,
          message.isError ? truncateText(message.content, 160) : "done",
          undefined,
          false,
        );
      }
    }
    this.invalidate();
  }

  private invalidate(): void {
    this.cache = undefined;
  }

  render(width: number, options: TranscriptRenderOptions = {}): DisplayLine[] {
    const optionsKey = options.showReasoning ? "1" : "0";
    if (this.cache && this.cache.width === width && this.cache.optionsKey === optionsKey) return this.cache.lines;
    const lines: DisplayLine[] = [];
    for (const block of this.blocks) {
      if (block.kind === "user") {
        lines.push(...withPrefix("› ", { fg: "accent", bold: true }, wrapSegments([{ text: block.text, style: { fg: "user" } }], width - 2)));
        lines.push(BLANK);
      } else if (block.kind === "assistant") {
        lines.push(...renderMarkdown(block.text, width - 2, { fg: "text" }, options).map((line) => [{ text: "  " }, ...line]));
        lines.push(BLANK);
      } else if (block.kind === "reasoning") {
        if (options.showReasoning) {
          lines.push(textLine("  ✻ thinking", { fg: "muted", italic: true }));
          const body = truncateText(block.text, 2000);
          lines.push(...renderMarkdown(body, width - 4, { fg: "muted", dim: true }, options).map((line) => [{ text: "    " }, ...line]));
          lines.push(BLANK);
        }
      } else if (block.kind === "tool") {
        const icon = block.status === "running" ? "●" : block.status === "ok" ? "✓" : "✗";
        const style: Style =
          block.status === "running"
            ? { fg: "tool" }
            : block.status === "ok"
              ? { fg: "success" }
              : { fg: "error" };
        const head = `${icon} ${block.name}${block.inputSummary ? `  ${block.inputSummary}` : ""}`;
        lines.push(...wrapSegments([{ text: head, style }], width).map((line) => [{ text: "  " }, ...line]));
        if (block.summary) {
          lines.push(textLine(`    ${toOneLine(block.summary, Math.max(20, width - 6))}`, { fg: "muted" }));
        }
        if (block.diff) {
          const diffLines = styledDiffLines(block.diff, 60);
          lines.push(...diffLines.map((line) => [{ text: "    " }, ...line]));
          if (block.diff.split("\n").length > 60) lines.push(textLine("    … diff truncated", { fg: "muted" }));
        }
        lines.push(BLANK);
      } else if (block.kind === "notice") {
        const icon = block.level === "warn" ? "!" : block.level === "error" ? "✗" : "i";
        const style: Style =
          block.level === "warn" ? { fg: "warning" } : block.level === "error" ? { fg: "error" } : { fg: "info" };
        lines.push(...wrapSegments([{ text: `${icon} ${block.text}`, style }], width));
        lines.push(BLANK);
      } else if (block.kind === "error") {
        lines.push(...wrapSegments([{ text: `✗ ${block.text}`, style: { fg: "error" } }], width));
        lines.push(BLANK);
      } else if (block.kind === "system") {
        const body = block.text.split("\n");
        for (const line of body) {
          lines.push(...wrapSegments([{ text: `│ ${line}`, style: { fg: "muted" } }], width));
        }
        lines.push(BLANK);
      } else if (block.kind === "command") {
        lines.push(...wrapSegments([{ text: `› ${block.text}`, style: { fg: "command" } }], width));
        lines.push(BLANK);
      }
    }
    // Avoid a trailing blank line at the very bottom.
    while (lines.length && lines[lines.length - 1]!.length === 0) lines.pop();
    this.cache = { width, optionsKey, lines };
    return lines;
  }
}

export function todoLines(todos: TodoItem[], width: number, maxItems = 4): DisplayLine[] {
  if (!todos.length) return [];
  const done = todos.filter((t) => t.status === "completed").length;
  const out: DisplayLine[] = [
    [{ text: `Plan ${done}/${todos.length}`, style: { fg: "accent", bold: true } }],
  ];
  const hidden = Math.max(0, todos.length - maxItems);
  for (const todo of todos.slice(0, maxItems)) {
    const icon = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○";
    const style: Style =
      todo.status === "completed"
        ? { fg: "muted" }
        : todo.status === "in_progress"
          ? { fg: "warning" }
          : { fg: "text" };
    out.push(
      ...wrapSegments(
        [{ text: `  ${icon} ${todo.content}`, style }],
        width,
      ).slice(0, 2),
    );
  }
  if (hidden > 0) out.push([{ text: `  … ${hidden} more`, style: { fg: "muted" } }]);
  return out;
}
