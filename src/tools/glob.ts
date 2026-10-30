import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import { displayPath, resolveUserPath } from "../utils/paths.ts";
import { statSafe, walkFiles } from "../utils/fs.ts";
import { IgnoreMatcher } from "../ignore/matcher.ts";
import { matchGlob } from "../utils/glob.ts";

const GlobArgs = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .describe("Glob pattern such as '**/*.ts' or 'src/**/*.test.ts'. Patterns without '/' match the filename at any depth."),
  path: z.string().optional().describe("Directory to search (default: workspace root)."),
  limit: z.number().int().positive().max(5000).optional().describe("Maximum number of results (default 200)."),
});

export const globTool = defineTool({
  name: "glob",
  description:
    "Find files by glob pattern. Respects .gitignore and .tcliignore, skips symlinks, and sorts results by " +
    "modification time (newest first). Patterns without a slash match the basename at any depth.",
  schema: GlobArgs,
  kind: "read",
  async permissionInfo(input, ctx) {
    return { paths: [resolveUserPath(ctx.cwd, input.path ?? ".")] };
  },
  async execute(input, ctx: ToolContext) {
    const root = resolveUserPath(ctx.cwd, input.path ?? ".");
    const stat = statSafe(root);
    if (!stat) return { content: `Directory not found: ${displayPath(root, ctx.cwd)}`, isError: true };
    if (!stat.isDirectory()) {
      return {
        content: `"${displayPath(root, ctx.cwd)}" is a file. Use read_file for files.`,
        isError: true,
      };
    }
    const limit = Math.min(input.limit ?? ctx.config.tools.limits.maxResults, 5000);
    const ignore = new IgnoreMatcher(root);
    const recursiveBasename = !input.pattern.includes("/");
    const matches: Array<{ rel: string; mtimeMs: number; size: number }> = [];
    let scanned = 0;
    for (const entry of walkFiles(root, { shouldIgnore: ignore.shouldIgnore, signal: ctx.signal })) {
      scanned++;
      const rel = entry.rel;
      const hit = recursiveBasename
        ? matchGlob(input.pattern, rel, { basename: true })
        : matchGlob(input.pattern, rel);
      if (!hit) continue;
      matches.push({ rel, mtimeMs: entry.mtimeMs, size: entry.size });
      if (matches.length > limit * 4) break;
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
    const shown = matches.slice(0, limit);
    if (!shown.length) {
      return {
        content: `No files matching "${input.pattern}" under ${displayPath(root, ctx.cwd)} (${scanned} files scanned).`,
        display: { summary: `glob: 0 matches` },
      };
    }
    const lines = shown.map((m) => m.rel);
    if (matches.length > limit) {
      lines.push(`… [tcli: showing ${limit} of at least ${matches.length} matches; refine the pattern]`);
    }
    return {
      content: lines.join("\n"),
      display: { summary: `glob: ${shown.length}${matches.length > limit ? "+" : ""} files` },
      metadata: { count: shown.length, scanned },
    };
  },
});
