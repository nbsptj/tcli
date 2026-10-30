/**
 * Small glob implementation used by the glob/grep tools and ignore engine.
 *
 * Supported syntax: `*`, `?`, `**`, character classes (`[abc]`, `[!a-z]`),
 * brace alternation (`{a,b}`), and escaping with backslash.
 *
 * Patterns are matched against POSIX-style relative paths and are anchored at
 * both ends: `*.ts` only matches the repository root, use `**\/*.ts` for a
 * recursive search.
 */

import { escapeRegExp } from "./strings.ts";

export interface GlobOptions {
  caseSensitive?: boolean;
  /** Treat the pattern as matching the basename at any depth (ignore-style). */
  basename?: boolean;
}

function classToRegExp(pattern: string, start: number): { source: string; next: number } | null {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  let body = "";
  let first = true;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "]" && !first) {
      return { source: `[${negate ? "^" : ""}${body}]`, next: i + 1 };
    }
    first = false;
    if (ch === "\\" && i + 1 < pattern.length) {
      body += "\\" + pattern[i + 1];
      i += 2;
      continue;
    }
    if (ch === "]") body += "\\" + ch;
    else body += ch;
    i++;
  }
  return null;
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [pattern];
  const body = pattern.slice(open + 1, close);
  const parts: string[] = [];
  let current = "";
  let nested = 0;
  for (const ch of body) {
    if (ch === "," && nested === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    if (ch === "{") nested++;
    if (ch === "}") nested--;
    current += ch;
  }
  parts.push(current);
  if (parts.length < 2) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  return parts.flatMap((part) => expandBraces(prefix + part + suffix));
}

export function globToRegExpSource(pattern: string, opts: GlobOptions = {}): string {
  const basename = opts.basename ?? false;
  let body = "";
  if (basename) body += "(?:.*/)?";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      let stars = 1;
      while (pattern[i + 1] === "*") {
        stars++;
        i++;
      }
      if (stars >= 2) {
        if (pattern[i + 1] === "/") {
          body += "(?:[^/]+/)*";
          i += 2;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      body += "[^/]";
      i++;
    } else if (ch === "[") {
      const cls = classToRegExp(pattern, i);
      if (cls) {
        body += cls.source;
        i = cls.next;
      } else {
        body += "\\[";
        i++;
      }
    } else if (ch === "\\" && i + 1 < pattern.length) {
      body += escapeRegExp(pattern[i + 1]!);
      i += 2;
    } else {
      body += escapeRegExp(ch);
      i++;
    }
  }
  return `^${body}$`;
}

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string, opts: GlobOptions = {}): RegExp {
  const key = `${opts.basename ? "b" : "r"}:${opts.caseSensitive === false ? "i" : "s"}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const variants = expandBraces(pattern);
  const source =
    variants.length === 1
      ? globToRegExpSource(variants[0]!, opts)
      : `(?:${variants.map((v) => globToRegExpSource(v, opts).slice(1, -1)).join("|")})`;
  const re = new RegExp(`^${source}$`, opts.caseSensitive === false ? "i" : "");
  // Keep cache bounded for long-lived TUI processes.
  if (cache.size > 500) cache.clear();
  cache.set(key, re);
  return re;
}

export function matchGlob(pattern: string, relPath: string, opts: GlobOptions = {}): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(pattern, opts).test(normalized);
}

/** True when the pattern contains any glob metacharacter. */
export function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}
