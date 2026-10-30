import { stripAnsi } from "./strings.ts";

export interface JsonParseResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  repaired?: boolean;
}

function extractJsonCandidate(text: string): string {
  let s = text.trim();
  // Strip markdown code fences.
  const fence = /^```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```$/i.exec(s);
  if (fence) s = fence[1]!.trim();
  // Grab from first brace/bracket to last matching-ish brace/bracket.
  const first = s.search(/[{[]/);
  if (first > 0) {
    const lastObj = s.lastIndexOf("}");
    const lastArr = s.lastIndexOf("]");
    const last = Math.max(lastObj, lastArr);
    if (last > first) s = s.slice(first, last + 1);
  }
  return s;
}

/**
 * Parse model-produced JSON, tolerating fences, prose and trailing commas.
 * Does not attempt heroic repairs: callers treat failure as a retryable
 * provider/tool error rather than executing malformed input.
 */
export function parseJsonLoose<T = unknown>(text: string): JsonParseResult<T> {
  const raw = stripAnsi(text ?? "").trim();
  if (!raw) return { ok: false, error: "empty JSON input" };
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    /* fall through */
  }
  let candidate = extractJsonCandidate(raw);
  try {
    return { ok: true, value: JSON.parse(candidate) as T, repaired: true };
  } catch (err) {
    try {
      candidate = candidate
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/^\uFEFF/, "")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
      return { ok: true, value: JSON.parse(candidate) as T, repaired: true };
    } catch {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function safeStringify(value: unknown, maxLength = 20_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? text.slice(0, maxLength) + "\n… [truncated]" : text;
}

/** Parse an SSE data payload that should be JSON; returns undefined when partial. */
export function tryParseJson<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
