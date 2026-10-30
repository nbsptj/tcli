export interface TruncateLimits {
  maxLines: number;
  maxBytes: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLines: number;
  originalBytes: number;
}

function splitKeep(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body === "" ? [] : body.split("\n"), trailingNewline };
}

/**
 * Truncate long tool output head-and-tail so both the beginning (setup) and the
 * end (errors, summaries) remain visible. A marker explains what was removed.
 */
export function truncateOutput(text: string, limits: TruncateLimits): TruncateResult {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const { lines, trailingNewline } = splitKeep(text);
  const originalLines = lines.length;
  const maxLines = Math.max(4, limits.maxLines);
  const maxBytes = Math.max(256, limits.maxBytes);
  let out = text;
  let truncated = false;
  let removedLines = 0;

  if (lines.length > maxLines) {
    const headCount = Math.max(1, Math.floor(maxLines * 0.6));
    const tailCount = Math.max(1, maxLines - headCount);
    removedLines = lines.length - headCount - tailCount;
    const marker = `\n… [tcli: truncated ${removedLines} lines; showing first ${headCount} and last ${tailCount}] …\n`;
    out = lines.slice(0, headCount).join("\n") + marker + lines.slice(-tailCount).join("\n");
    if (trailingNewline) out += "\n";
    truncated = true;
  }

  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > maxBytes) {
    const ratio = maxBytes / bytes;
    const headBytes = Math.max(64, Math.floor(maxBytes * 0.6));
    const tailBytes = Math.max(64, Math.floor(maxBytes * 0.35));
    const buf = Buffer.from(out, "utf8");
    const headEnd = safeUtf8Cut(buf, headBytes);
    const tailStart = Math.max(headEnd, buf.length - tailBytes);
    const tailIndex = safeUtf8CutFrom(buf, tailStart);
    const marker = "\n… [tcli: output truncated by size] …\n";
    out =
      buf.subarray(0, headEnd).toString("utf8") +
      marker +
      buf.subarray(tailIndex).toString("utf8");
    truncated = true;
    void ratio;
  }

  return { text: out, truncated, originalLines, originalBytes };
}

function safeUtf8Cut(buf: Buffer, target: number): number {
  let i = Math.min(target, buf.length);
  while (i > 0 && i < buf.length && (buf[i]! & 0xc0) === 0x80) i--;
  return i;
}

function safeUtf8CutFrom(buf: Buffer, target: number): number {
  let i = Math.max(0, Math.min(target, buf.length));
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** Truncate a single line for display or model consumption. */
export function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.slice(0, Math.max(0, max - 1)) + "…";
}
