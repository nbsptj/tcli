/**
 * Line-based unified diff used for edit previews and transcripts.
 *
 * Uses an LCS table for small inputs and falls back to a coarse whole-file
 * replacement for very large files (diff quality is less important than staying
 * responsive).
 */

interface LineOp {
  type: " " | "-" | "+";
  line: string;
}

function splitLines(text: string): { lines: string[]; trailing: boolean } {
  const trailing = text.endsWith("\n");
  const body = trailing ? text.slice(0, -1) : text;
  return { lines: body === "" ? [] : body.split("\n"), trailing };
}

function lcsOps(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((line) => ({ type: "-" as const, line })), ...b.map((line) => ({ type: "+" as const, line }))];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ type: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", line: a[i++]! });
  while (j < m) ops.push({ type: "+", line: b[j++]! });
  return ops;
}

export interface DiffOptions {
  context?: number;
  /** Label used in the ---/+++ header, usually a workspace-relative path. */
  path?: string;
  maxLines?: number;
}

/** Returns "" when the inputs are identical. */
export function unifiedDiff(oldText: string, newText: string, opts: DiffOptions = {}): string {
  if (oldText === newText) return "";
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 400;
  const oldSplit = splitLines(oldText);
  const newSplit = splitLines(newText);
  const ops = lcsOps(oldSplit.lines, newSplit.lines);
  const pathLabel = opts.path ?? "file";

  // Identify changed op indexes and expand by context.
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i]!.type !== " ") changed.push(i);
  if (!changed.length) return "";

  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length - 1, changed[0]! + context);
  for (let k = 1; k < changed.length; k++) {
    const idx = changed[k]!;
    if (idx - context <= end + 1) {
      end = Math.min(ops.length - 1, idx + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  ranges.push([start, end]);

  const out: string[] = [];
  out.push(`--- ${oldText ? `a/${pathLabel}` : "/dev/null"}`);
  out.push(`+++ ${newText ? `b/${pathLabel}` : "/dev/null"}`);
  let oldLine = 1;
  let newLine = 1;
  let opIndex = 0;
  let emitted = 0;
  for (const [from, to] of ranges) {
    while (opIndex < from) {
      const op = ops[opIndex]!;
      if (op.type !== "+") oldLine++;
      if (op.type !== "-") newLine++;
      opIndex++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let i = from; i <= to; i++) {
      if (ops[i]!.type !== "+") oldCount++;
      if (ops[i]!.type !== "-") newCount++;
    }
    out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
    for (let i = from; i <= to; i++) {
      const op = ops[i]!;
      out.push(op.type + op.line);
      if (op.type !== "+") oldLine++;
      if (op.type !== "-") newLine++;
      opIndex = i + 1;
      emitted++;
      if (emitted > maxLines) {
        out.push("… [diff truncated] …");
        return out.join("\n");
      }
    }
  }
  return out.join("\n");
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(oldText: string, newText: string): DiffStat {
  if (oldText === newText) return { added: 0, removed: 0 };
  const a = splitLines(oldText).lines;
  const b = splitLines(newText).lines;
  let added = 0;
  let removed = 0;
  for (const op of lcsOps(a, b)) {
    if (op.type === "+") added++;
    else if (op.type === "-") removed++;
  }
  return { added, removed };
}

/** Compact `+N -M` summary for tool results. */
export function formatDiffStat(stat: DiffStat): string {
  return `+${stat.added} -${stat.removed}`;
}
