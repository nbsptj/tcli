import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config/schema.ts";
import { IgnoreMatcher } from "../ignore/matcher.ts";
import { isBinaryBuffer, statSafe, walkFiles } from "../utils/fs.ts";
import { displayPath, isWithinWorkspace, resolveUserPath, toPosix } from "../utils/paths.ts";
import { redactSecrets } from "../utils/redact.ts";
import { fuzzyScore, truncateText } from "../utils/strings.ts";

export interface ReferenceToken {
  raw: string;
  path: string;
}

const REFERENCE_RE = /(^|[\s(])@(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'`]+))/g;

export function extractReferences(text: string): ReferenceToken[] {
  const out: ReferenceToken[] = [];
  for (const match of text.matchAll(REFERENCE_RE)) {
    let value = match[2] ?? match[3] ?? match[4] ?? "";
    value = value.replace(/\\"/g, '"').replace(/\\'/g, "'");
    if (!match[2] && !match[3]) value = value.replace(/[.,;:!?)\]]+$/, "");
    if (!value) continue;
    out.push({ raw: match[0].trim(), path: value });
  }
  return out;
}

export interface ExpandedReference {
  path: string;
  kind: "file" | "dir";
  bytes: number;
}

export interface ReferenceExpansion {
  text: string;
  references: ExpandedReference[];
  warnings: string[];
}

function listTree(dir: string, maxDepth = 2, maxEntries = 200): string[] {
  const lines: string[] = [];
  const walk = (current: string, prefix: string, depth: number) => {
    if (lines.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of entries) {
      if (lines.length >= maxEntries) {
        lines.push(`${prefix}…`);
        return;
      }
      if (entry.isSymbolicLink()) continue;
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && depth < maxDepth) walk(path.join(current, entry.name), prefix + "  ", depth + 1);
    }
  };
  walk(dir, "", 1);
  return lines;
}

/**
 * Expand `@file` and `@dir` references into an explicit context block. Explicit
 * references are constrained to the workspace, size-capped, binary-checked and
 * credential-redacted.
 */
export function expandReferences(
  text: string,
  opts: { cwd: string; config: Config },
): ReferenceExpansion {
  const tokens = extractReferences(text);
  if (!tokens.length) return { text, references: [], warnings: [] };
  const warnings: string[] = [];
  const blocks: string[] = [];
  const references: ExpandedReference[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const totalCap = 60_000;

  for (const token of tokens) {
    if (totalBytes >= totalCap) {
      warnings.push("reference context limit reached; later references were skipped");
      break;
    }
    const abs = resolveUserPath(opts.cwd, token.path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!isWithinWorkspace(opts.cwd, abs)) {
      warnings.push(`@${token.path}: outside the workspace (skipped)`);
      continue;
    }
    const stat = statSafe(abs);
    if (!stat) {
      warnings.push(`@${token.path}: not found`);
      continue;
    }
    if (stat.isDirectory()) {
      const tree = listTree(abs);
      const rel = toPosix(path.relative(opts.cwd, abs)) || ".";
      const body = `<referenced-directory path="${rel}">\n${tree.join("\n")}\n</referenced-directory>`;
      blocks.push(body);
      references.push({ path: abs, kind: "dir", bytes: Buffer.byteLength(body, "utf8") });
      totalBytes += body.length;
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`@${token.path}: not a regular file`);
      continue;
    }
    const maxBytes = Math.min(opts.config.context.maxFileBytes, 200_000);
    if (stat.size > maxBytes) {
      warnings.push(`@${token.path}: file is ${stat.size} bytes (limit ${maxBytes})`);
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch (err) {
      warnings.push(`@${token.path}: ${(err as Error).message}`);
      continue;
    }
    if (isBinaryBuffer(buffer)) {
      warnings.push(`@${token.path}: binary file (skipped)`);
      continue;
    }
    const raw = buffer.toString("utf8");
    const redacted = redactSecrets(raw);
    if (redacted.count > 0) warnings.push(`@${token.path}: redacted ${redacted.count} secret-like value(s)`);
    const rel = displayPath(abs, opts.cwd);
    let content = redacted.text;
    if (content.length > maxBytes) content = truncateText(content, maxBytes, "\n… [truncated]");
    const body = `<referenced-file path="${rel}">\n${content}\n</referenced-file>`;
    blocks.push(body);
    references.push({ path: abs, kind: "file", bytes: Buffer.byteLength(body, "utf8") });
    totalBytes += body.length;
  }

  if (!blocks.length) {
    return { text, references, warnings };
  }
  const block = [
    "<file-references>",
    "The user explicitly attached these workspace files/directories as context.",
    "",
    ...blocks,
    "</file-references>",
  ].join("\n");
  return { text: `${text}\n\n${block}`, references, warnings };
}

export interface CompletionItem {
  path: string;
  isDir: boolean;
}

/**
 * Cached workspace path index for `@` completion. The TUI calls this on every
 * keystroke; the index is rebuilt at most once every few seconds.
 */
export class PathCompleter {
  private readonly cwd: string;
  private readonly ttlMs: number;
  private builtAt = 0;
  private entries: Array<{ rel: string; isDir: boolean }> = [];
  private truncated = false;

  constructor(cwd: string, opts: { ttlMs?: number } = {}) {
    this.cwd = cwd;
    this.ttlMs = opts.ttlMs ?? 4000;
  }

  private buildIndex(): void {
    if (Date.now() - this.builtAt < this.ttlMs && this.entries.length) return;
    const ignore = new IgnoreMatcher(this.cwd);
    const entries = new Map<string, boolean>();
    let count = 0;
    for (const entry of walkFiles(this.cwd, {
      shouldIgnore: ignore.shouldIgnore,
      includeDirs: true,
      maxEntries: 20_000,
    })) {
      count++;
      if (entry.isDir) {
        entries.set(entry.rel, true);
        const parts = entry.rel.split("/");
        for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join("/"), true);
      } else {
        entries.set(entry.rel, false);
      }
      if (count > 20_000) {
        this.truncated = true;
        break;
      }
    }
    this.entries = [...entries.entries()].map(([rel, isDir]) => ({ rel, isDir }));
    this.builtAt = Date.now();
  }

  complete(query: string, limit = 12): CompletionItem[] {
    this.buildIndex();
    const q = query.replace(/^@/, "").replace(/\\/g, "/");
    if (!q) {
      return this.entries
        .filter((e) => !e.rel.includes("/"))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.rel.localeCompare(b.rel))
        .slice(0, limit)
        .map((e) => ({
          path: e.rel + (e.isDir && !e.rel.endsWith("/") ? "/" : ""),
          isDir: e.isDir,
        }));
    }
    const slash = q.lastIndexOf("/");
    const dirPart = slash >= 0 ? q.slice(0, slash + 1) : "";
    const namePart = slash >= 0 ? q.slice(slash + 1) : q;
    const candidates: Array<{ entry: { rel: string; isDir: boolean }; score: number }> = [];
    for (const entry of this.entries) {
      if (dirPart && !entry.rel.startsWith(dirPart)) continue;
      const name = dirPart ? entry.rel.slice(dirPart.length) : entry.rel;
      const haystack = dirPart ? name : entry.rel;
      const score = fuzzyScore(namePart, haystack);
      if (score === null) continue;
      candidates.push({ entry, score: score + (entry.isDir ? 3 : 0) - entry.rel.length * 0.02 });
    }
    candidates.sort((a, b) => b.score - a.score);
    const out: CompletionItem[] = [];
    for (const candidate of candidates) {
      if (out.length >= limit) break;
      out.push({
        path: candidate.entry.rel + (candidate.entry.isDir ? "/" : ""),
        isDir: candidate.entry.isDir,
      });
    }
    return out;
  }

  isTruncated(): boolean {
    return this.truncated;
  }
}
