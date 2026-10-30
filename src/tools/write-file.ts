import fs from "node:fs";
import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { displayPath, resolveUserPath } from "../utils/paths.ts";
import { statSafe, writeFileAtomicSync } from "../utils/fs.ts";
import { diffStat, formatDiffStat, unifiedDiff } from "../utils/diff.ts";
import { classifySensitivePath } from "../permissions/sensitive.ts";

const MAX_WRITE_BYTES = 10 * 1024 * 1024;

const WriteArgs = z.strictObject({
  path: z.string().min(1).describe("File path to write, relative to the workspace or absolute."),
  content: z.string().describe("Complete new file content. Parent directories are created automatically."),
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or completely overwrite a text file. Writing an existing file requires reading it first " +
    "(read_file) and fails if it changed on disk since that read. Writes are atomic and create a checkpoint.",
  schema: WriteArgs,
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
      old = "";
    }
    const diff = unifiedDiff(old, input.content, { path: label, context: 3, maxLines: 200 });
    if (!diff) return `write_file ${label}: no content change`;
    return diff;
  },
  async execute(input, ctx: ToolContext) {
    const abs = resolveUserPath(ctx.cwd, input.path);
    const label = displayPath(abs, ctx.cwd);
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_WRITE_BYTES) {
      return { content: `Refusing to write ${bytes} bytes (limit ${MAX_WRITE_BYTES}).`, isError: true };
    }
    const stat = statSafe(abs);
    if (stat?.isDirectory()) return { content: `"${label}" is a directory; cannot write a file there.`, isError: true };
    const existed = Boolean(stat?.isFile());
    let old = "";
    if (existed) {
      try {
        old = fs.readFileSync(abs, "utf8");
      } catch (err) {
        return { content: `Cannot read existing file ${label}: ${(err as Error).message}`, isError: true };
      }
      const check = ctx.snapshots.verify(abs, old, {
        requireRead: ctx.config.permissions.requireReadBeforeWrite,
      });
      if (!check.ok) {
        return { content: check.reason, isError: true, metadata: { code: check.code } };
      }
    }
    const checkpoint = ctx.checkpoints.create(abs, existed ? old : null, { tool: "write_file" });
    try {
      writeFileAtomicSync(abs, input.content);
    } catch (err) {
      return { content: `Failed to write ${label}: ${(err as Error).message}`, isError: true };
    }
    ctx.checkpoints.finalize(checkpoint.id, input.content);
    ctx.snapshots.recordRead(abs, input.content);
    const statAfter = diffStat(old, input.content);
    const diff = unifiedDiff(old, input.content, { path: label, maxLines: 200 });
    const summary = `${existed ? "Wrote" : "Created"} ${label} (${bytes} bytes, ${formatDiffStat(statAfter)})`;
    return {
      content: `${summary}${diff ? "\n\n" + diff : ""}`,
      display: { summary, diff: diff || undefined },
      metadata: { path: abs, bytes, existed, checkpoint: checkpoint.id, ...statAfter },
    };
  },
});
