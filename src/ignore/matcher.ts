import fs from "node:fs";
import path from "node:path";
import { globToRegExpSource } from "../utils/glob.ts";
import { toPosix } from "../utils/paths.ts";

interface IgnoreRule {
  base: string;
  negated: boolean;
  dirOnly: boolean;
  source: string;
  re: RegExp;
}

export interface IgnoreOptions {
  /** Additional root-level patterns (e.g. from config). */
  extraPatterns?: string[];
  /** Set false to include node_modules/.git in searches (rarely useful). */
  defaults?: boolean;
  /** Ignore files to consult at each directory level. */
  fileNames?: string[];
}

const DEFAULT_PATTERNS = [".git/", "node_modules/", ".tcli/cache/", ".DS_Store"];

function parseLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function trimUnescapedTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let i = end - 2; i >= 0 && line[i] === "\\"; i--) backslashes++;
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

function compileRule(raw: string, base: string): IgnoreRule | null {
  let line = trimUnescapedTrailingSpaces(raw);
  if (!line) return null;
  if (line.startsWith("#")) return null;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }
  if (!line) return null;
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  let anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!line) return null;
  const hasSlash = line.includes("/");
  const body = globToRegExpSource(line).slice(1, -1);
  const prefix = anchored || hasSlash ? "" : "(?:.*/)?";
  let source: string;
  try {
    source = `^${prefix}${body}$`;
    return {
      base,
      negated,
      dirOnly,
      source: raw,
      re: new RegExp(source),
    };
  } catch {
    return null;
  }
}

/**
 * gitignore-compatible matcher with nested ignore files and negation.
 *
 * Rules are evaluated from the root down and, within a file, in order; the last
 * matching rule wins. Directory-only rules also match ancestors, so an ignored
 * directory prunes its whole subtree.
 */
export class IgnoreMatcher {
  readonly root: string;
  private readonly opts: IgnoreOptions;
  private readonly dirCache = new Map<string, IgnoreRule[]>();

  constructor(root: string, opts: IgnoreOptions = {}) {
    this.root = path.resolve(root);
    this.opts = { defaults: true, fileNames: [".gitignore", ".tcliignore"], ...opts };
  }

  private loadDir(dir: string): IgnoreRule[] {
    const cached = this.dirCache.get(dir);
    if (cached) return cached;
    const rules: IgnoreRule[] = [];
    if (dir === this.root) {
      if (this.opts.defaults !== false) {
        for (const pattern of DEFAULT_PATTERNS) {
          const rule = compileRule(pattern, dir);
          if (rule) rules.push(rule);
        }
      }
      for (const pattern of this.opts.extraPatterns ?? []) {
        const rule = compileRule(pattern, dir);
        if (rule) rules.push(rule);
      }
    }
    for (const name of this.opts.fileNames ?? []) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 512 * 1024) continue;
        const text = fs.readFileSync(file, "utf8");
        for (const line of parseLines(text)) {
          const rule = compileRule(line, dir);
          if (rule) rules.push(rule);
        }
      } catch {
        /* no ignore file */
      }
    }
    this.dirCache.set(dir, rules);
    return rules;
  }

  /** All rules that apply to a path, root first, deepest last. */
  private rulesFor(absPath: string): IgnoreRule[] {
    const rel = path.relative(this.root, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
    const segments = rel.split(path.sep).filter(Boolean);
    const dirs: string[] = [this.root];
    let cur = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      cur = path.join(cur, segments[i]!);
      dirs.push(cur);
    }
    const rules: IgnoreRule[] = [];
    for (const dir of dirs) rules.push(...this.loadDir(dir));
    return rules;
  }

  isIgnored(absPath: string, isDir = false): boolean {
    return this.matchDetails(absPath, isDir).ignored;
  }

  matchDetails(absPath: string, isDir = false): { ignored: boolean; rule?: IgnoreRule } {
    const resolved = path.resolve(absPath);
    const rel = path.relative(this.root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { ignored: false };
    const rules = this.rulesFor(resolved);
    if (!rules.length) return { ignored: false };
    const segments = rel.split(path.sep).filter(Boolean);
    let ignored = false;
    let matched: IgnoreRule | undefined;
    for (const rule of rules) {
      const relToBase = path.relative(rule.base, resolved);
      if (relToBase.startsWith("..") || path.isAbsolute(relToBase)) continue;
      const candidates: Array<{ rel: string; isDir: boolean }> = [];
      const parts = relToBase.split(path.sep).filter(Boolean);
      // Ancestors are directories; the last component keeps the caller's type.
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
        const isLast = i === parts.length - 1;
        candidates.push({ rel: acc, isDir: isLast ? isDir : true });
      }
      for (const candidate of candidates) {
        if (rule.dirOnly && !candidate.isDir) continue;
        if (rule.re.test(toPosix(candidate.rel))) {
          ignored = !rule.negated;
          matched = rule;
          break;
        }
      }
    }
    return { ignored, rule: matched };
  }

  /** Bound callback suitable for walkFiles(). */
  shouldIgnore = (absPath: string, _rel: string, isDir: boolean): boolean => {
    return this.isIgnored(absPath, isDir);
  };

  addFile(file: string, base = this.root): void {
    try {
      const text = fs.readFileSync(file, "utf8");
      const existing = this.dirCache.get(base) ?? [];
      for (const line of parseLines(text)) {
        const rule = compileRule(line, base);
        if (rule) existing.push(rule);
      }
      this.dirCache.set(base, existing);
    } catch {
      /* ignore */
    }
  }
}

/** Convenience factory used by tools and the repo overview. */
export function createIgnoreMatcher(cwd: string, extraPatterns: string[] = []): IgnoreMatcher {
  return new IgnoreMatcher(cwd, { extraPatterns });
}
