import fs from "node:fs";
import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { displayPath, resolveUserPath } from "../utils/paths.ts";
import { isBinaryBuffer, statSafe, walkFiles } from "../utils/fs.ts";
import { IgnoreMatcher } from "../ignore/matcher.ts";
import { matchGlob } from "../utils/glob.ts";
import { truncateLine } from "../utils/truncate.ts";

const GrepArgs = z.strictObject({
  pattern: z.string().min(1).describe("JavaScript regular expression to search for."),
  path: z.string().optional().describe("File or directory to search (default: workspace root)."),
  glob: z.string().optional().describe("Only search files whose path matches this glob (e.g. '*.ts')."),
  ignore_case: z.boolean().optional().describe("Case-insensitive search."),
  context: z.number().int().min(0).max(10).optional().describe("Lines of context around each match."),
  limit: z.number().int().positive().max(2000).optional().describe("Maximum number of matching lines (default 200)."),
});

interface MatchLine {
  lineNo: number;
  text: string;
  isMatch: boolean;
}

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Respects .gitignore/.tcliignore, skips binary " +
    "files, supports a file glob filter and context lines, and truncates results. Output format: path:line:text.",
  schema: GrepArgs,
  kind: "read",
  async permissionInfo(input, ctx) {
    return { paths: [resolveUserPath(ctx.cwd, input.path ?? ".")] };
  },
  async execute(input, ctx: ToolContext) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.ignore_case ? "i" : "");
    } catch (err) {
      return {
        content: `Invalid regular expression "${input.pattern}": ${(err as Error).message}. Escape special characters such as ( ) [ ] . * + ? |.`,
        isError: true,
      };
    }
    const root = resolveUserPath(ctx.cwd, input.path ?? ".");
    const stat = statSafe(root);
    if (!stat) return { content: `Path not found: ${displayPath(root, ctx.cwd)}`, isError: true };
    const limit = Math.min(input.limit ?? ctx.config.tools.limits.maxResults, 2000);
    const contextLines = input.context ?? 0;
    const files: Array<{ path: string; rel: string }> = [];
    if (stat.isFile()) {
      files.push({ path: root, rel: displayPath(root, ctx.cwd) });
    } else if (stat.isDirectory()) {
      const ignore = new IgnoreMatcher(root);
      const basenameGlob = input.glob ? !input.glob.includes("/") : false;
      for (const entry of walkFiles(root, { shouldIgnore: ignore.shouldIgnore, signal: ctx.signal })) {
        if (input.glob) {
          const hit = basenameGlob
            ? matchGlob(input.glob, entry.rel, { basename: true })
            : matchGlob(input.glob, entry.rel);
          if (!hit) continue;
        }
        files.push({ path: entry.path, rel: displayPath(entry.path, ctx.cwd) });
        if (files.length > 50_000) break;
      }
    } else {
      return { content: `Not a regular file or directory: ${displayPath(root, ctx.cwd)}`, isError: true };
    }

    const output: string[] = [];
    const matchFiles = new Set<string>();
    let totalMatches = 0;
    let truncated = false;
    let filesScanned = 0;
    let lastFile: string | undefined;
    for (const file of files) {
      if (ctx.signal.aborted) break;
      if (totalMatches >= limit) {
        truncated = true;
        break;
      }
      let buffer: Buffer;
      try {
        const fileStat = fs.statSync(file.path);
        if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024) continue;
        buffer = fs.readFileSync(file.path);
      } catch {
        continue;
      }
      if (isBinaryBuffer(buffer)) continue;
      filesScanned++;
      const lines = buffer.toString("utf8").split("\n");
      const matchIndexes: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i]!.replace(/\r$/, ""))) matchIndexes.push(i);
      }
      if (!matchIndexes.length) continue;
      matchFiles.add(file.rel);
      const include = new Map<number, boolean>();
      for (const idx of matchIndexes) {
        if (totalMatches >= limit) {
          truncated = true;
          break;
        }
        totalMatches++;
        for (let c = Math.max(0, idx - contextLines); c <= Math.min(lines.length - 1, idx + contextLines); c++) {
          include.set(c, include.get(c) === true || c === idx);
        }
      }
      const ordered = [...include.keys()].sort((a, b) => a - b);
      let previous: number | undefined;
      if (lastFile !== undefined && lastFile !== file.rel) {
        // keep file separation implicit via path prefix
      }
      for (const lineNo of ordered) {
        if (previous !== undefined && lineNo > previous + 1) output.push("--");
        previous = lineNo;
        const text = truncateLine(lines[lineNo]!.replace(/\r$/, ""), 600);
        const separator = include.get(lineNo) === true ? ":" : "-";
        output.push(`${file.rel}${separator}${lineNo + 1}${separator} ${text}`);
      }
      lastFile = file.rel;
    }

    if (!totalMatches) {
      return {
        content: `No matches for /${input.pattern}/ in ${displayPath(root, ctx.cwd)} (${filesScanned} files searched).`,
        display: { summary: "grep: 0 matches" },
        metadata: { matches: 0, files: filesScanned },
      };
    }
    if (truncated) output.push(`… [tcli: stopped at ${limit} matching lines]`);
    return {
      content: output.join("\n"),
      display: {
        summary: `grep: ${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${matchFiles.size} file${matchFiles.size === 1 ? "" : "s"}`,
      },
      metadata: { matches: totalMatches, files: matchFiles.size, filesScanned, truncated },
    };
  },
});
