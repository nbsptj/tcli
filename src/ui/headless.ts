import type { AgentEvent } from "../agent/events.ts";
import type { TodoItem } from "../types.ts";
import { summarizeToolInput } from "./transcript.ts";
import { paint, type ColorMode } from "./ansi.ts";

export interface HeadlessRendererOptions {
  out?: NodeJS.WriteStream;
  err?: NodeJS.WriteStream;
  colorMode?: ColorMode;
  theme?: "dark" | "light";
  /** Emit assistant text to stdout (false for JSON modes). */
  emitText?: boolean;
  /** Emit tool/permission activity to stderr (false for JSON modes). */
  showActivity?: boolean;
  verbose?: boolean;
}

/**
 * Linear, non-TUI renderer used for single-shot mode, pipes and CI. Tool
 * activity and diagnostics go to stderr; assistant text goes to stdout so
 * `tcli "..." > out.md` stays clean.
 */
export class HeadlessRenderer {
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private readonly colorMode: ColorMode;
  private readonly theme: "dark" | "light";
  private readonly emitText: boolean;
  private readonly showActivity: boolean;
  private readonly verbose: boolean;
  private atLineStart = true;
  private wroteText = false;
  private todos: TodoItem[] = [];

  constructor(opts: HeadlessRendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
    this.colorMode = opts.colorMode ?? "none";
    this.theme = opts.theme ?? "dark";
    this.emitText = opts.emitText ?? true;
    this.showActivity = opts.showActivity ?? true;
    this.verbose = opts.verbose ?? false;
  }

  private style(text: string, style: Parameters<typeof paint>[1]): string {
    return paint(text, style, this.theme, this.colorMode);
  }

  private ensureNewline(): void {
    if (!this.atLineStart && this.emitText) {
      this.out.write("\n");
      this.atLineStart = true;
    }
  }

  private status(text: string): void {
    if (!this.showActivity) return;
    this.ensureNewline();
    this.err.write(text + "\n");
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "text":
        if (this.emitText) {
          this.out.write(event.text);
          this.atLineStart = event.text.endsWith("\n");
          this.wroteText = true;
        }
        break;
      case "reasoning":
        if (this.verbose && this.showActivity) {
          this.status(this.style(event.text, { fg: "muted", dim: true }));
        }
        break;
      case "tool_start": {
        if (!this.showActivity) break;
        const summary = summarizeToolInput(event.invocation.name, event.invocation.input);
        this.status(this.style(`› ${event.invocation.name}${summary ? `  ${summary}` : ""}`, { fg: "tool" }));
        break;
      }
      case "tool_result": {
        if (!this.showActivity) break;
        const { outcome, display } = event;
        const icon = outcome.ok ? "✓" : "✗";
        const style = outcome.ok ? { fg: "success" as const } : { fg: "error" as const };
        const summary = display?.summary ?? (outcome.ok ? "done" : "failed");
        this.status(this.style(`  ${icon} ${summary}`, style));
        if (this.verbose && display?.diff) {
          for (const line of display.diff.split("\n").slice(0, 80)) {
            this.err.write(this.style("    " + line, line.startsWith("+") ? { fg: "diffAdd" } : line.startsWith("-") ? { fg: "diffDel" } : { fg: "muted" }) + "\n");
          }
        } else if (!outcome.ok && this.verbose) {
          this.err.write(this.style("    " + outcome.content.split("\n").slice(0, 8).join("\n    "), { fg: "muted" }) + "\n");
        }
        break;
      }
      case "permission":
        if (this.showActivity && (!event.allowed || event.approvedBy !== "policy")) {
          const text = event.allowed
            ? `  ${event.tool}: allowed (${event.approvedBy})`
            : `  ${event.tool}: denied — ${event.reason}`;
          this.status(this.style(text, event.allowed ? { fg: "muted" } : { fg: "error" }));
        }
        break;
      case "notice":
        this.status(
          this.style(`${event.level === "warn" ? "!" : event.level === "error" ? "✗" : "i"} ${event.text}`, {
            fg: event.level === "warn" ? "warning" : event.level === "error" ? "error" : "info",
          }),
        );
        break;
      case "retry":
        this.status(this.style(`↻ retrying (${event.attempt}) in ${event.delayMs}ms: ${event.reason}`, { fg: "warning" }));
        break;
      case "compaction":
        this.status(
          this.style(
            `↺ context compacted: ${event.beforeTokens} → ${event.afterTokens} tokens`,
            { fg: "muted" },
          ),
        );
        break;
      case "error":
        this.status(this.style(`✗ ${event.message}`, { fg: "error" }));
        break;
      case "debug":
        if (this.verbose && this.showActivity) this.err.write(this.style(event.text, { fg: "muted", dim: true }) + "\n");
        break;
      case "todo":
        this.todos = event.todos;
        if (this.showActivity && this.verbose) {
          const done = event.todos.filter((t) => t.status === "completed").length;
          this.status(this.style(`plan: ${done}/${event.todos.length}`, { fg: "muted" }));
        }
        break;
      case "done":
        this.finish();
        break;
      default:
        break;
    }
  }

  finish(): void {
    if (this.emitText && this.wroteText && !this.atLineStart) {
      this.out.write("\n");
      this.atLineStart = true;
    }
  }

  get currentTodos(): TodoItem[] {
    return [...this.todos];
  }
}
