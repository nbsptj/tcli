import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config/schema.ts";
import { IgnoreMatcher } from "../ignore/matcher.ts";
import { ensureDirSync, readFileTextSafe, walkFiles, writeFileAtomicSync } from "../utils/fs.ts";
import { toPosix } from "../utils/paths.ts";
import { formatBytes } from "../utils/strings.ts";

const CACHE_VERSION = 3;

export interface RepoOverview {
  text: string;
  data: OverviewData;
  cached: boolean;
  generatedAt: string;
}

export interface OverviewData {
  cwd: string;
  gitBranch?: string;
  isGitRepo: boolean;
  packageManager?: string;
  languages: Array<{ name: string; count: number }>;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  fileCount: number;
  dirCount: number;
  scanned: number;
  truncated: boolean;
  tree: string[];
  recentFiles: string[];
  hasReadme: boolean;
  hasInstructions: boolean;
}

interface CacheFile {
  version: number;
  configKey: string;
  createdAt: string;
  text: string;
  data: OverviewData;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  pyi: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  c: "C",
  h: "C",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  lua: "Lua",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  hs: "Haskell",
  scala: "Scala",
  clj: "Clojure",
  vue: "Vue",
  svelte: "Svelte",
  html: "HTML",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
  sql: "SQL",
  md: "Markdown",
  mdx: "Markdown",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
};

const LOCKFILES: Array<[string, string]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
  ["Pipfile.lock", "pipenv"],
  ["composer.lock", "composer"],
];

function cachePath(cwd: string): string {
  return path.join(cwd, ".tcli", "cache", "overview.json");
}

function configKey(config: Config): string {
  return `${config.context.overview.depth}:${config.context.overview.maxFiles}`;
}

function readCache(cwd: string, config: Config): CacheFile | undefined {
  const file = cachePath(cwd);
  const raw = readFileTextSafe(file);
  if (!raw) return undefined;
  try {
    const cached = JSON.parse(raw) as CacheFile;
    if (cached.version !== CACHE_VERSION || cached.configKey !== configKey(config)) return undefined;
    if (!cached.createdAt || !cached.text) return undefined;
    const age = Date.now() - Date.parse(cached.createdAt);
    if (!Number.isFinite(age) || age > config.context.overview.ttlMs || age < 0) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

function writeCache(cwd: string, config: Config, text: string, data: OverviewData): void {
  try {
    const file = cachePath(cwd);
    ensureDirSync(path.dirname(file));
    const payload: CacheFile = {
      version: CACHE_VERSION,
      configKey: configKey(config),
      createdAt: new Date().toISOString(),
      text,
      data,
    };
    writeFileAtomicSync(file, JSON.stringify(payload, null, 2));
  } catch {
    /* cache is best effort */
  }
}

function findGitDir(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 100; i++) {
    const candidate = path.join(dir, ".git");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const text = fs.readFileSync(candidate, "utf8");
        const match = /^gitdir:\s*(.+)$/m.exec(text);
        if (match) return path.resolve(dir, match[1]!.trim());
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function readGitBranch(cwd: string): { isRepo: boolean; branch?: string } {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return { isRepo: false };
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return { isRepo: true, branch: head.slice("ref: refs/heads/".length) };
    if (/^[0-9a-f]{7,40}$/i.test(head)) return { isRepo: true, branch: `detached@${head.slice(0, 8)}` };
    return { isRepo: true };
  } catch {
    return { isRepo: true };
  }
}

function readPackageScripts(cwd: string): Record<string, string> | undefined {
  const raw = readFileTextSafe(path.join(cwd, "package.json"));
  if (!raw) return undefined;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return undefined;
  }
}

function detectPackageManager(cwd: string): string | undefined {
  for (const [file, name] of LOCKFILES) {
    if (fs.existsSync(path.join(cwd, file))) return name;
  }
  if (fs.existsSync(path.join(cwd, "package.json"))) return "npm";
  return undefined;
}

function detectCommands(cwd: string, pm: string | undefined): { test?: string; build?: string; lint?: string } {
  const scripts = readPackageScripts(cwd);
  const run = (name: string): string => {
    if (pm === "bun") return `bun run ${name}`;
    if (pm === "pnpm") return `pnpm run ${name}`;
    if (pm === "yarn") return `yarn ${name}`;
    return `npm run ${name}`;
  };
  let test: string | undefined;
  let build: string | undefined;
  let lint: string | undefined;
  if (scripts?.test) test = run("test");
  else if (scripts?.tests) test = run("tests");
  else if (fs.existsSync(path.join(cwd, "bunfig.toml")) || fs.existsSync(path.join(cwd, "bun.lock"))) {
    test = "bun test";
  } else if (scripts) test = run("test");
  if (scripts?.build) build = run("build");
  else if (scripts?.compile) build = run("compile");
  if (scripts?.lint) lint = run("lint");
  else if (scripts?.typecheck) lint = run("typecheck");
  else if (fs.existsSync(path.join(cwd, "tsconfig.json"))) lint = "tsc --noEmit";

  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    test = "cargo test";
    build = "cargo build";
    lint ??= "cargo clippy";
  } else if (fs.existsSync(path.join(cwd, "go.mod"))) {
    test = "go test ./...";
    build = "go build ./...";
    lint ??= "go vet ./...";
  } else if (
    fs.existsSync(path.join(cwd, "pyproject.toml")) ||
    fs.existsSync(path.join(cwd, "requirements.txt"))
  ) {
    test ??= "pytest";
    lint ??= "ruff check .";
  } else if (fs.existsSync(path.join(cwd, "Makefile"))) {
    const makefile = readFileTextSafe(path.join(cwd, "Makefile")) ?? "";
    if (/^test:/m.test(makefile)) test ??= "make test";
    if (/^build:/m.test(makefile)) build ??= "make build";
  }
  return { test, build, lint };
}

interface TreeNode {
  name: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
}

function buildTree(files: string[], dirs: string[], maxDepth: number, maxLines: number): string[] {
  const root: TreeNode = { name: "", isDir: true, children: new Map() };
  const insert = (rel: string, isDir: boolean) => {
    const parts = rel.split("/").filter(Boolean);
    if (parts.length > maxDepth) return;
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const last = i === parts.length - 1;
      let child = node.children.get(name);
      if (!child) {
        child = { name, isDir: last ? isDir : true, children: new Map() };
        node.children.set(name, child);
      }
      if (last) child.isDir = isDir;
      node = child;
    }
  };
  const sortedDirs = [...dirs].sort();
  const sortedFiles = [...files].sort();
  for (const dir of sortedDirs) insert(toPosix(dir), true);
  for (const file of sortedFiles) insert(toPosix(file), false);

  const lines: string[] = [];
  const render = (node: TreeNode, prefix: string, depth: number) => {
    if (lines.length >= maxLines) return;
    const children = [...node.children.values()].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) {
      if (lines.length >= maxLines) {
        lines.push(`${prefix}…`);
        return;
      }
      lines.push(`${prefix}${child.name}${child.isDir ? "/" : ""}`);
      if (child.isDir && depth + 1 < maxDepth) render(child, prefix + "  ", depth + 1);
    }
  };
  render(root, "", 0);
  return lines;
}

function generateOverview(cwd: string, config: Config): { text: string; data: OverviewData } {
  const ignore = new IgnoreMatcher(cwd);
  const maxFiles = config.context.overview.maxFiles;
  const files: Array<{ rel: string; size: number; mtimeMs: number }> = [];
  const dirs = new Set<string>();
  let scanned = 0;
  let truncated = false;
  for (const entry of walkFiles(cwd, {
    shouldIgnore: ignore.shouldIgnore,
    includeDirs: true,
    maxEntries: Math.max(maxFiles * 8, 4000),
  })) {
    scanned++;
    if (entry.isDir) {
      dirs.add(entry.rel);
      continue;
    }
    files.push({ rel: entry.rel, size: entry.size, mtimeMs: entry.mtimeMs });
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
  }
  const languages = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file.rel).slice(1).toLowerCase();
    const language = EXT_LANGUAGE[ext];
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
  }
  const languageList = [...languages.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  const packageManager = detectPackageManager(cwd);
  const commands = detectCommands(cwd, packageManager);
  const git = readGitBranch(cwd);
  const recentFiles = [...files]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 8)
    .map((f) => f.rel);
  const data: OverviewData = {
    cwd,
    gitBranch: git.branch,
    isGitRepo: git.isRepo,
    packageManager,
    languages: languageList,
    testCommand: commands.test,
    buildCommand: commands.build,
    lintCommand: commands.lint,
    fileCount: files.length,
    dirCount: dirs.size,
    scanned,
    truncated,
    tree: buildTree(files.map((f) => f.rel), [...dirs], config.context.overview.depth, 160),
    recentFiles,
    hasReadme: ["README.md", "README", "readme.md"].some((f) => fs.existsSync(path.join(cwd, f))),
    hasInstructions: ["AGENTS.md", "TCLI.md"].some((f) => fs.existsSync(path.join(cwd, f))),
  };
  const lines = [
    `[Repository overview — generated snapshot, may be stale]`,
    `workspace: ${cwd}`,
    `git: ${git.isRepo ? git.branch ?? "repository" : "not a git repository"}`,
    `package manager: ${packageManager ?? "unknown"}`,
    `languages: ${languageList.length ? languageList.map((l) => `${l.name} (${l.count})`).join(", ") : "unknown"}`,
    `test command: ${commands.test ?? "not detected"}`,
    `build command: ${commands.build ?? "not detected"}`,
    `lint/typecheck: ${commands.lint ?? "not detected"}`,
    `files scanned: ${files.length}${truncated ? "+" : ""} (${dirs.size} dirs, ${formatBytes(files.reduce((sum, f) => sum + f.size, 0))})`,
    `instructions: ${data.hasInstructions ? "AGENTS.md/TCLI.md present" : "none"}`,
    "",
    "tree:",
    ...data.tree.map((line) => `  ${line}`),
  ];
  if (recentFiles.length) {
    lines.push("", "recently modified:", ...recentFiles.map((f) => `  ${f}`));
  }
  return { text: lines.join("\n"), data };
}

/**
 * Generate (or load from cache) a compact repository overview used in the
 * system prompt. Cache lives in `.tcli/cache/overview.json`.
 */
export function getRepoOverview(
  cwd: string,
  config: Config,
  opts: { force?: boolean } = {},
): RepoOverview {
  if (!config.context.overview.enabled) {
    return {
      text: "",
      data: {
        cwd,
        isGitRepo: false,
        languages: [],
        fileCount: 0,
        dirCount: 0,
        scanned: 0,
        truncated: false,
        tree: [],
        recentFiles: [],
        hasReadme: false,
        hasInstructions: false,
      },
      cached: false,
      generatedAt: new Date().toISOString(),
    };
  }
  if (!opts.force) {
    const cached = readCache(cwd, config);
    if (cached) return { text: cached.text, data: cached.data, cached: true, generatedAt: cached.createdAt };
  }
  const generated = generateOverview(cwd, config);
  writeCache(cwd, config, generated.text, generated.data);
  return { text: generated.text, data: generated.data, cached: false, generatedAt: new Date().toISOString() };
}
