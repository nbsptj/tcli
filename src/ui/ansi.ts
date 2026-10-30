/** ANSI styling, width calculation and segment layout primitives. */

export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

export type ColorName =
  | "text"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "info"
  | "user"
  | "tool"
  | "command"
  | "diffAdd"
  | "diffDel"
  | "diffMeta";

export interface Style {
  fg?: ColorName;
  bg?: ColorName;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Segment {
  text: string;
  style?: Style;
}

export type DisplayLine = Segment[];

const TRUE_COLORS: Record<ColorName, string> = {
  text: "#e5e7eb",
  accent: "#22d3ee",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
  muted: "#6b7280",
  info: "#60a5fa",
  user: "#93c5fd",
  tool: "#c084fc",
  command: "#f472b6",
  diffAdd: "#4ade80",
  diffDel: "#f87171",
  diffMeta: "#38bdf8",
};

const LIGHT_COLORS: Record<ColorName, string> = {
  text: "#111827",
  accent: "#0e7490",
  success: "#15803d",
  warning: "#b45309",
  error: "#b91c1c",
  muted: "#6b7280",
  info: "#1d4ed8",
  user: "#1e40af",
  tool: "#7e22ce",
  command: "#be185d",
  diffAdd: "#15803d",
  diffDel: "#b91c1c",
  diffMeta: "#0369a1",
};

const ANSI256: Record<ColorName, number> = {
  text: 252,
  accent: 51,
  success: 114,
  warning: 221,
  error: 210,
  muted: 244,
  info: 75,
  user: 117,
  tool: 177,
  command: 211,
  diffAdd: 114,
  diffDel: 210,
  diffMeta: 81,
};

const ANSI16: Record<ColorName, number> = {
  text: 37,
  accent: 36,
  success: 32,
  warning: 33,
  error: 31,
  muted: 90,
  info: 34,
  user: 36,
  tool: 35,
  command: 35,
  diffAdd: 32,
  diffDel: 31,
  diffMeta: 36,
};

export interface ThemeOptions {
  theme: "dark" | "light";
  mode: ColorMode;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function colorCode(name: ColorName, theme: "dark" | "light", mode: ColorMode): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "truecolor") {
    const [r, g, b] = hexToRgb((theme === "light" ? LIGHT_COLORS : TRUE_COLORS)[name]);
    return `38;2;${r};${g};${b}`;
  }
  if (mode === "ansi256") return `38;5;${ANSI256[name]}`;
  return String(ANSI16[name]);
}

export function paint(text: string, style: Style | undefined, theme: "dark" | "light", mode: ColorMode): string {
  if (!text || !style || mode === "none") return text;
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.inverse) codes.push("7");
  if (style.fg) {
    const fg = colorCode(style.fg, theme, mode);
    if (fg) codes.push(fg);
  }
  if (style.bg) {
    const bg = colorCode(style.bg, theme, mode);
    if (bg) codes.push(bg.replace(/^38;/, "48;"));
  }
  if (!codes.length) return text;
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

export function detectColorMode(
  stream: { isTTY?: boolean } | undefined,
  setting: "auto" | "always" | "never",
): ColorMode {
  if (setting === "never") return "none";
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return "none";
  if (process.env.TERM === "dumb") return "none";
  if (setting === "always") return "truecolor";
  if (!stream?.isTTY) return "none";
  const colorterm = (process.env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (/256color/i.test(process.env.TERM ?? "")) return "ansi256";
  return "ansi16";
}

export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

export function textLine(text: string, style?: Style): DisplayLine {
  return text ? [{ text, style }] : [];
}

export function segmentsWidth(line: DisplayLine): number {
  return line.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
}

/** Hard-wrap segments at a display width. Explicit newlines are honored. */
export function wrapSegments(line: DisplayLine, width: number): DisplayLine[] {
  const safeWidth = Math.max(1, width);
  const out: DisplayLine[] = [];
  let current: DisplayLine = [];
  let col = 0;
  const push = () => {
    out.push(current);
    current = [];
    col = 0;
  };
  for (const segment of line) {
    for (const ch of segment.text) {
      if (ch === "\n") {
        push();
        continue;
      }
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (col + w > safeWidth) push();
      const last = current[current.length - 1];
      if (last && last.style === segment.style) last.text += ch;
      else current.push({ text: ch, style: segment.style });
      col += w;
    }
  }
  if (current.length || !out.length) out.push(current);
  return out;
}

export function truncateSegments(line: DisplayLine, width: number): DisplayLine {
  if (width <= 0) return [];
  let col = 0;
  const out: DisplayLine = [];
  for (const segment of line) {
    let text = "";
    for (const ch of segment.text) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (col + w > width - 1 && col + w > width) break;
      if (col + w > width) break;
      text += ch;
      col += w;
    }
    if (text) out.push({ text, style: segment.style });
    if (col >= width) break;
  }
  return out;
}

export function padLine(line: DisplayLine, width: number): DisplayLine {
  const current = segmentsWidth(line);
  if (current >= width) return truncateSegments(line, width);
  return [...line, { text: " ".repeat(width - current) }];
}

export function renderLine(
  line: DisplayLine,
  width: number,
  theme: "dark" | "light",
  mode: ColorMode,
): string {
  const padded = padLine(line, width);
  return padded
    .map((segment) => paint(segment.text, segment.style, theme, mode))
    .join("");
}

export function joinLines(lines: DisplayLine[]): DisplayLine {
  const out: DisplayLine = [];
  for (const line of lines) out.push(...line);
  return out;
}

export function styledDiffLines(diff: string, maxLines = 80): DisplayLine[] {
  const lines = diff.split("\n").slice(0, maxLines);
  return lines.map((text) => {
    if (text.startsWith("+++") || text.startsWith("---")) return textLine(text, { fg: "muted" });
    if (text.startsWith("@@")) return textLine(text, { fg: "diffMeta" });
    if (text.startsWith("+")) return textLine(text, { fg: "diffAdd" });
    if (text.startsWith("-")) return textLine(text, { fg: "diffDel" });
    return textLine(text, { fg: "muted" });
  });
}
