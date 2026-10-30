const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Remove ANSI escape sequences (CSI, OSC and friends). */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  if (min < 60) return `${min}m${rest > 0 ? `${rest}s` : ""}`;
  const hours = Math.floor(min / 60);
  return `${hours}h${min % 60}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatRelativeTime(iso: string | number | Date, now = Date.now()): string {
  const then = iso instanceof Date ? iso.getTime() : typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const delta = Math.max(0, now - then);
  const min = Math.floor(delta / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function truncateText(text: string, max: number, suffix = "…"): string {
  if (text.length <= max) return text;
  if (max <= suffix.length) return suffix.slice(0, max);
  return text.slice(0, max - suffix.length) + suffix;
}

export function truncateMiddle(text: string, max: number, marker = " … "): string {
  if (text.length <= max) return text;
  const keep = max - marker.length;
  if (keep <= 1) return marker.slice(0, max);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

export function sanitizeFileName(name: string, fallback = "item"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 120);
  return cleaned || fallback;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Simple subsequence fuzzy matcher; higher score is better, null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (found === ti) {
      streak++;
      score += 2 + streak;
    } else {
      streak = 0;
      score += 1;
      if (found === 0 || "/._- ".includes(t[found - 1] ?? "")) score += 2;
    }
    ti = found + 1;
  }
  // Prefer shorter targets when scores tie.
  return score - t.length * 0.01;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!normalized) return 1;
  return normalized.split("\n").length;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}

export function padEndVisible(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : text + " ".repeat(width - visible);
}

export function padStartVisible(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : " ".repeat(width - visible) + text;
}

/** Wrap plain text to a width, preserving explicit newlines. */
export function wrapPlainText(text: string, width: number): string[] {
  if (width < 2) return [text];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) {
      out.push("");
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut < Math.floor(width * 0.4)) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ +/, "");
    }
    out.push(rest);
  }
  return out;
}

export function toOneLine(text: string, max = 160): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), max);
}
