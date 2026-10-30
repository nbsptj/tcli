import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadInstructions } from "../src/context/instructions.ts";
import { getRepoOverview } from "../src/context/overview.ts";
import { expandReferences, PathCompleter } from "../src/context/references.ts";
import { compactMessages, countMessageTokens, extractiveSummary } from "../src/context/compression.ts";
import { cleanup, makeRepo, testConfig, tempDir } from "./helpers.ts";
import type { ChatMessage } from "../src/types.ts";

let home = "";
const originalHome = process.env.TCLI_HOME;

beforeEach(() => {
  home = tempDir("tcli-context-home-");
  process.env.TCLI_HOME = home;
});

afterEach(() => {
  cleanup(home);
  if (originalHome === undefined) delete process.env.TCLI_HOME;
  else process.env.TCLI_HOME = originalHome;
});

describe("project instructions", () => {
  test("loads parent and nested AGENTS.md / TCLI.md", () => {
    const root = makeRepo({
      "AGENTS.md": "root instructions",
      "TCLI.md": "root tcli rules",
      "pkg/AGENTS.md": "package instructions",
      "pkg/src/index.ts": "export {};\n",
    });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    try {
      const result = loadInstructions(path.join(root, "pkg"), testConfig());
      expect(result.files.length).toBe(3);
      expect(result.text).toContain("root instructions");
      expect(result.text).toContain("package instructions");
      expect(result.text).toContain("root tcli rules");
      expect(result.text.indexOf("root instructions")).toBeLessThan(result.text.indexOf("package instructions"));
    } finally {
      cleanup(root);
    }
  });
});

describe("repository overview", () => {
  test("detects package manager, languages and commands, then caches", () => {
    const root = makeRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc", lint: "eslint ." } }),
      "bun.lock": "",
      "tsconfig.json": "{}",
      "README.md": "# Demo",
      "AGENTS.md": "rules",
      "src/index.ts": "export const x = 1;\n",
      "src/util.ts": "export const y = 2;\n",
      "web/app.js": "console.log(1)\n",
    });
    try {
      const config = testConfig();
      const first = getRepoOverview(root, config);
      expect(first.text).toContain("package manager: bun");
      expect(first.text).toContain("test command: bun run test");
      expect(first.text).toContain("build command: bun run build");
      expect(first.text).toContain("TypeScript");
      expect(first.text).toContain("src/index.ts");
      expect(first.cached).toBe(false);
      const second = getRepoOverview(root, config);
      expect(second.cached).toBe(true);
      expect(second.text).toBe(first.text);
      const forced = getRepoOverview(root, config, { force: true });
      expect(forced.cached).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

describe("@ references", () => {
  test("inlines files, redacts secrets, lists directories and warns on missing/outside", () => {
    const root = makeRepo({
      "src/a.ts": 'const API_KEY = "sk-abcdefghijklmnop";\nexport const a = 1;\n',
      "src/b.ts": "export const b = 2;\n",
    });
    try {
      const config = testConfig();
      const result = expandReferences("explain @src/a.ts and @src/ and @missing.ts and @/etc/passwd", {
        cwd: root,
        config,
      });
      expect(result.text).toContain('<referenced-file path="src/a.ts">');
      expect(result.text).not.toContain("sk-abcdefghijklmnop");
      expect(result.text).toContain('<referenced-directory path="src">');
      expect(result.text).toContain("b.ts");
      expect(result.references.length).toBe(2);
      expect(result.warnings.some((w) => w.includes("missing.ts"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("outside the workspace"))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test("does not modify text without references", () => {
    const result = expandReferences("plain task", { cwd: tempDir(), config: testConfig() });
    expect(result.text).toBe("plain task");
    expect(result.references).toEqual([]);
  });

  test("path completer finds files and directories", () => {
    const root = makeRepo({
      "src/index.ts": "",
      "src/lib/helper.ts": "",
      "docs/readme.md": "",
      ".gitignore": "node_modules/\n",
      "node_modules/x/y.js": "",
    });
    try {
      const completer = new PathCompleter(root, { ttlMs: 60_000 });
      const all = completer.complete("");
      expect(all.some((item) => item.path === "src/" && item.isDir)).toBe(true);
      const src = completer.complete("src/");
      expect(src.some((item) => item.path === "src/index.ts")).toBe(true);
      expect(src.some((item) => item.path === "src/lib/")).toBe(true);
      const lib = completer.complete("src/li");
      expect(lib.some((item) => item.path === "src/lib/")).toBe(true);
      expect(completer.complete("")).not.toContainEqual({ path: "node_modules/", isDir: true });
    } finally {
      cleanup(root);
    }
  });
});

describe("context compression", () => {
  test("summarizes older turns and keeps the system prompt plus recent turns", async () => {
    const system: ChatMessage = { role: "system", content: "SYSTEM PROMPT" };
    const messages: ChatMessage[] = [system];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: `user request ${i} `.repeat(20) });
      messages.push({ role: "assistant", content: `assistant response ${i} `.repeat(20) });
    }
    const beforeTokens = countMessageTokens(messages);
    let sawTranscript = "";
    const result = await compactMessages({
      messages,
      keepRecentTurns: 2,
      budgetTokens: 50,
      signal: new AbortController().signal,
      summarize: async (transcript) => {
        sawTranscript = transcript;
        return "CONDENSED SUMMARY";
      },
      recentFiles: ["src/a.ts"],
      force: true,
      preserveSystemCount: 1,
    });
    expect(result.compacted).toBe(true);
    expect(sawTranscript).toContain("user request 0");
    expect(result.messages[0]!.content).toBe("SYSTEM PROMPT");
    expect(result.messages[1]!.content).toContain("CONDENSED SUMMARY");
    expect(result.messages[1]!.content).toContain("src/a.ts");
    expect(result.messages.some((m) => m.content.startsWith("user request 7"))).toBe(true);
    expect(result.messages.some((m) => m.content.startsWith("user request 0"))).toBe(false);
    expect(result.afterTokens).toBeLessThan(beforeTokens);
  });

  test("falls back to an extractive summary when the summarizer fails", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first request" },
      { role: "assistant", content: "did work" },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent answer" },
    ];
    const result = await compactMessages({
      messages,
      keepRecentTurns: 1,
      budgetTokens: 1,
      signal: new AbortController().signal,
      summarize: async () => {
        throw new Error("provider down");
      },
      force: true,
      preserveSystemCount: 1,
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("first request");
    const extract = extractiveSummary(messages.slice(1), ["a.ts"]);
    expect(extract).toContain("Tools used");
  });
});
