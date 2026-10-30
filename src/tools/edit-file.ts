import fs from "node:fs";
import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { displayPath, resolveUserPath } from "../utils/paths.ts";
import { statSafe, writeFileAtomicSync } from "../utils/fs.ts";
import { diffStat, formatDiffStat, unifiedDiff } from "../utils/diff.ts";
import { classifySensitivePath } from "../permissions/sensitive.ts";

const EditArgs = z.strictObject({
  path: z.string().min(1).describe("File to edit."),
  old_string: z.string().min(1).describe("Exact text to replace (must match including whitespace)."),
  new_string: z.string().describe("Replacement text. May be empty to delete the matched text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence (default: only a unique match)."),
});

interface AppliedEdit {
  ok: boolean;
  content: string;
  count: number;
  error?: string;
}

function countOccurrences(content: string, needle: string): number[] {
  const positions: number[] = [];
  let index = content.indexOf(needle);
  while (index >= 0) {
    positions.push(index);
    index = content.indexOf(needle, index + Math.max(1, needle.length));
  }
  return positions;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): AppliedEdit {
  const positions = countOccurrences(content, oldString);
  if (!positions.length) {
    return {
      ok: false,
      content,
      count: 0,
      error: "old_string was not found. The file may have changed; read it again and copy the exact text (including whitespace).",
    };
  }
  if (positions.length > 1 && !replaceAll) {
    const lines = positions.slice(0, 10).map((p) => lineOf(content, p)).join(", ");
    return {
      ok: false,
      content,
      count: positions.length,
      error: `old_string occurs ${positions.length} times (lines ${lines}). Provide more context to make it unique, or set replace_all=true.`,
    };
  }
  if (oldString === newString) {
    return { ok: false, content, count: positions.length, error: "new_string is identical to old_string; no change would be made." };
  }
  if (replaceAll) {
    return { ok: true, content: content.split(oldString).join(newString), count: positions.length };
  }
  const pos = positions[0]!;
  return {
    ok: true,
    content: content.slice(0, pos) + newString + content.slice(pos + oldString.length),
    count: 1,
  };
}

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a text file. Defaults to requiring a unique match; use replace_all for " +
    "multiple occurrences. Requires a prior read_file and fails if the file changed on disk since. " +
    "Writes are atomic and create a checkpoint.",
  schema: EditArgs,
  kind: "write",
  async permissionInfo(input, ctx) {
    const abs = resolveUserPath(ctx.cwd, input.path);
    const sensitivity = classifySensitivePath(abs, ctx.cwd, ctx.config.permissions.sensitivePatterns);
    return { paths: [abs], sensitive: sensitivity.sensitive, sensitiveReasons: sensitivity.reasons };
  },
  async preview(input, ctx) {
    const abs = resolveUserPath(ctx.cwd, input.path);
    const label = displayPath(abs, ctx.cwd);
    let old = "";
    try {
      old = fs.readFileSync(abs, "utf8");
    } catch {
      return `edit_file ${label}: file does not exist`;
    }
    const applied = applyEdit(old, input.old_string, input.new_string, input.replace_all ?? false);
    if (applied.ok) return unifiedDiff(old, applied.content, { path: label, maxLines: 200 });
    return `edit_file ${label}: ${applied.error}`;
  },
  async execute(input, ctx: ToolContext) {
    const abs = resolveUserPath(ctx.cwd, input.path);
    const label = displayPath(abs, ctx.cwd);
    const stat = statSafe(abs);
    if (!stat) return { content: `File not found: ${label}`, isError: true };
    if (stat.isDirectory()) return { content: `"${label}" is a directory; use edit_file on a file.`, isError: true };
    let old: string;
    try {
      old = fs.readFileSync(abs, "utf8");
    } catch (err) {
      return { content: `Cannot read ${label}: ${(err as Error).message}`, isError: true };
    }
    const check = ctx.snapshots.verify(abs, old, {
      requireRead: ctx.config.permissions.requireReadBeforeWrite,
    });
    if (!check.ok) return { content: check.reason, isError: true, metadata: { code: check.code } };

    const applied = applyEdit(old, input.old_string, input.new_string, input.replace_all ?? false);
    if (!applied.ok) return { content: applied.error ?? "edit failed", isError: true };

    const checkpoint = ctx.checkpoints.create(abs, old, { tool: "edit_file" });
    try {
      writeFileAtomicSync(abs, applied.content);
    } catch (err) {
      return { content: `Failed to write ${label}: ${(err as Error).message}`, isError: true };
    }
    ctx.checkpoints.finalize(checkpoint.id, applied.content);
    ctx.snapshots.recordRead(abs, applied.content);
    const stats = diffStat(old, applied.content);
    const diff = unifiedDiff(old, applied.content, { path: label, maxLines: 200 });
    const summary = `Edited ${label} (${applied.count} replacement${applied.count === 1 ? "" : "s"}, ${formatDiffStat(stats)})`;
    return {
      content: `${summary}\n\n${diff}`,
      display: { summary, diff },
      metadata: {
        path: abs,
        replacements: applied.count,
        checkpoint: checkpoint.id,
        ...stats,
      },
    };
  },
});
