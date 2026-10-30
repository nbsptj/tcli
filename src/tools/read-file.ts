import fs from "node:fs";
import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { resolveUserPath, displayPath } from "../utils/paths.ts";
import { isBinaryBuffer, statSafe } from "../utils/fs.ts";
import { redactSecrets } from "../utils/redact.ts";
import { classifySensitiveContent, classifySensitivePath } from "../permissions/sensitive.ts";
import { truncateLine } from "../utils/truncate.ts";

const ReadArgs = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("File path to read, absolute or relative to the workspace root."),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line number to start reading from. Use to continue a large file."),
  limit: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe("Maximum number of lines to return (default 2000, max 5000)."),
});

export type ReadFileInput = z.infer<typeof ReadArgs>;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns line-numbered content, detects binary files, " +
    "enforces a size limit, redacts credentials, and records the file snapshot required before editing. " +
    "Use offset/limit for large files.",
  schema: ReadArgs,
  kind: "read",
  async permissionInfo(input, ctx) {
    const abs = resolveUserPath(ctx.cwd, input.path);
    const pathSensitivity = classifySensitivePath(abs, ctx.cwd, ctx.config.permissions.sensitivePatterns);
    const reasons = [...pathSensitivity.reasons];
    let contentSensitive = false;
    const stat = statSafe(abs);
    if (stat?.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024) {
      try {
        const fd = fs.openSync(abs, "r");
        try {
          const buf = Buffer.alloc(Math.min(32 * 1024, stat.size));
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          const contentCheck = classifySensitiveContent(buf.subarray(0, n).toString("utf8"));
          if (contentCheck.sensitive) {
            contentSensitive = true;
            reasons.push(...contentCheck.reasons);
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* unreadable files fail during execute with a clear error */
      }
    }
    return { paths: [abs], sensitive: pathSensitivity.sensitive || contentSensitive, sensitiveReasons: reasons };
  },
  async execute(input, ctx: ToolContext) {
    const abs = resolveUserPath(ctx.cwd, input.path);
    const label = displayPath(abs, ctx.cwd);
    const stat = statSafe(abs);
    if (!stat) return { content: `File not found: ${label}`, isError: true };
    if (stat.isDirectory()) {
      return {
        content: `"${label}" is a directory. Use glob or grep to inspect directories.`,
        isError: true,
      };
    }
    if (!stat.isFile()) return { content: `Not a regular file: ${label}`, isError: true };
    const maxFile = ctx.config.tools.read.maxFileBytes;
    if (stat.size > maxFile) {
      return {
        content: `File ${label} is ${stat.size} bytes, which exceeds the read limit of ${maxFile} bytes. Read a smaller file or use bash (e.g. sed -n '1,200p').`,
        isError: true,
      };
    }
    const buffer = fs.readFileSync(abs);
    if (isBinaryBuffer(buffer)) {
      return {
        content: `Refusing to read binary file ${label} (NUL byte detected).`,
        isError: true,
      };
    }
    const text = buffer.toString("utf8");
    ctx.snapshots.recordRead(abs, text, stat.mtimeMs);

    const allLines = text.split("\n");
    const trailingEmpty = allLines.length > 0 && allLines[allLines.length - 1] === "";
    const totalLines = trailingEmpty ? allLines.length - 1 : allLines.length;
    const offset = input.offset ?? 1;
    const limit = input.limit ?? Math.min(ctx.config.tools.limits.maxLines, 2000);
    if (totalLines === 0) {
      return {
        content: `[${label} | empty file | ${stat.size} bytes]`,
        display: { summary: `Read ${label} (empty)` },
      };
    }
    if (offset > totalLines) {
      return {
        content: `offset ${offset} is past the end of ${label} (${totalLines} lines).`,
        isError: true,
      };
    }
    const end = Math.min(totalLines, offset - 1 + limit);
    const selected = allLines.slice(offset - 1, end);
    const width = Math.max(3, String(totalLines).length);
    let redactedCount = 0;
    const formatted: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      const rawLine = selected[i]!.replace(/\r$/, "");
      const redacted = redactSecrets(rawLine);
      redactedCount += redacted.count;
      formatted.push(`${String(offset + i).padStart(width)}| ${truncateLine(redacted.text, 2000)}`);
    }
    const header = `[${label} | ${totalLines} lines | ${stat.size} bytes]`;
    const notes: string[] = [];
    if (end < totalLines) {
      notes.push(`… showing lines ${offset}-${end} of ${totalLines}; call read_file again with offset=${end + 1} to continue.`);
    }
    if (redactedCount > 0) notes.push(`[tcli: redacted ${redactedCount} secret-like value(s)]`);
    const content = [header, ...formatted, ...notes].join("\n");
    return {
      content,
      display: {
        summary: `Read ${label} (${end - offset + 1}/${totalLines} lines)`,
      },
      metadata: { path: abs, totalLines, from: offset, to: end, redacted: redactedCount },
    };
  },
});
