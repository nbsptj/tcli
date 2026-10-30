import type { ColorMode, DisplayLine } from "./ansi.ts";
import { renderLine } from "./ansi.ts";

export interface CursorPosition {
  row: number;
  col: number;
}

/**
 * A small full-screen renderer that writes only changed rows using absolute
 * cursor positioning. Frames are composed as styled display lines; the Screen
 * owns padding, truncation and cursor placement.
 */
export class Screen {
  private readonly write: (chunk: string) => void;
  private readonly mode: ColorMode;
  private readonly theme: "dark" | "light";
  private width = 80;
  private height = 24;
  private previous: string[] = [];
  private first = true;

  constructor(opts: {
    write: (chunk: string) => void;
    mode: ColorMode;
    theme: "dark" | "light";
    width?: number;
    height?: number;
  }) {
    this.write = opts.write;
    this.mode = opts.mode;
    this.theme = opts.theme;
    this.width = opts.width ?? 80;
    this.height = opts.height ?? 24;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(20, width);
    const h = Math.max(4, height);
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.previous = [];
      this.first = true;
    }
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Compose and write a frame; returns the escape sequence (for tests). */
  render(lines: DisplayLine[], cursor?: CursorPosition): string {
    const rows = Math.min(this.height, Math.max(0, lines.length));
    const rendered: string[] = [];
    for (let row = 0; row < this.height; row++) {
      const line = row < rows ? lines[row]! : [];
      rendered.push(renderLine(line, this.width, this.theme, this.mode));
    }
    let out = "";
    if (this.first) {
      out += "\u001b[2J\u001b[H";
      this.first = false;
    }
    for (let row = 0; row < this.height; row++) {
      const next = rendered[row]!;
      if (this.previous[row] === next) continue;
      out += `\u001b[${row + 1};1H${next}\u001b[K`;
    }
    if (cursor) {
      const row = Math.min(this.height - 1, Math.max(0, cursor.row));
      const col = Math.min(this.width - 1, Math.max(0, cursor.col));
      out += `\u001b[${row + 1};${col + 1}H\u001b[?25h`;
    } else {
      out += "\u001b[?25l";
    }
    this.previous = rendered;
    if (out) this.write(out);
    return out;
  }

  clear(): void {
    this.previous = [];
    this.first = true;
  }

  enterAlternateScreen(): void {
    this.write("\u001b[?1049h\u001b[?2004h\u001b[>1u\u001b[2J\u001b[H\u001b[?25l");
  }

  leaveAlternateScreen(): void {
    this.write("\u001b[<u\u001b[?2004l\u001b[?25h\u001b[?1049l");
  }
}
