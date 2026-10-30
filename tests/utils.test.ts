import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { matchGlob, globToRegExp, isGlob } from "../src/utils/glob.ts";
import { unifiedDiff, diffStat, formatDiffStat } from "../src/utils/diff.ts";
import { truncateOutput, truncateLine } from "../src/utils/truncate.ts";
import { redactSecrets, containsSecrets, redactValue } from "../src/utils/redact.ts";
import { estimateTokens, estimateCost, priceFor } from "../src/utils/tokens.ts";
import { formatBytes, formatDuration, formatTokens, formatCost, stripAnsi, fuzzyScore, toOneLine, shellQuote } from "../src/utils/strings.ts";
import { parseJsonLoose } from "../src/utils/json.ts";
import { filterEnv } from "../src/utils/env.ts";
import { isBinaryBuffer, hashBytes, readFileTextSafe, writeFileAtomicSync } from "../src/utils/fs.ts";
import { cleanup, tempDir } from "./helpers.ts";

describe("glob matching", () => {
  test("recursive and basename patterns", () => {
    expect(matchGlob("**/*.ts", "a.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/a.ts")).toBe(false);
    expect(matchGlob("*.ts", "src/a.ts", { basename: true })).toBe(true);
    expect(matchGlob("src/**/*.test.ts", "src/a/b/x.test.ts")).toBe(true);
    expect(matchGlob("src/**/*.test.ts", "src/x.test.ts")).toBe(true);
    expect(matchGlob("src/*", "src/a/b.ts")).toBe(false);
  });

  test("classes and braces", () => {
    expect(globToRegExp("file[0-9].ts").test("file7.ts")).toBe(true);
    expect(globToRegExp("file[!0-9].ts").test("file7.ts")).toBe(false);
    expect(matchGlob("*.{ts,js}", "x.ts")).toBe(true);
    expect(matchGlob("*.{ts,js}", "x.js")).toBe(true);
    expect(matchGlob("*.{ts,js}", "x.py")).toBe(false);
    expect(isGlob("a.ts")).toBe(false);
    expect(isGlob("a*.ts")).toBe(true);
  });
});

describe("unified diff", () => {
  test("simple modification", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { path: "x.txt" });
    expect(diff).toContain("--- a/x.txt");
    expect(diff).toContain("+++ b/x.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(unifiedDiff("same", "same")).toBe("");
  });

  test("new file and stats", () => {
    const diff = unifiedDiff("", "one\ntwo", { path: "new.txt" });
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+one");
    expect(diffStat("a\nb\nc", "a\nc\nd")).toEqual({ added: 1, removed: 1 });
    expect(formatDiffStat({ added: 2, removed: 1 })).toBe("+2 -1");
  });
});

describe("truncation", () => {
  test("keeps head and tail with a marker", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateOutput(text, { maxLines: 10, maxBytes: 10_000 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("line 0");
    expect(result.text).toContain("line 99");
    expect(result.text).toContain("truncated 90 lines");
  });

  test("byte truncation is UTF-8 safe", () => {
    const text = "你好世界".repeat(1000);
    const result = truncateOutput(text, { maxLines: 50_000, maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("\uFFFD");
  });

  test("small output is untouched", () => {
    const result = truncateOutput("hello", { maxLines: 10, maxBytes: 100 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello");
    expect(truncateLine("abcdef", 4)).toBe("abc…");
  });
});

describe("secret redaction", () => {
  test("redacts env assignments, JSON fields, bearer tokens", () => {
    const input = [
      "OPENAI_API_KEY=sk-abc123",
      'const x = { apiKey: "secret-value", normal: "ok" };',
      "Authorization: Bearer abc.def.ghi",
      "DATABASE_URL=postgres://user:hunter2@host/db",
      "const password = 'hunter2'",
    ].join("\n");
    const result = redactSecrets(input);
    expect(result.text).not.toContain("sk-abc123");
    expect(result.text).not.toContain("secret-value");
    expect(result.text).not.toContain("abc.def.ghi");
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("normal: \"ok\"");
    expect(result.count).toBeGreaterThanOrEqual(4);
    expect(containsSecrets(input)).toBe(true);
    expect(containsSecrets("const x = 1;")).toBe(false);
  });

  test("redactValue walks objects", () => {
    const value = redactValue({ apiKey: "secret", nested: { token: "abc" }, text: "PASSWORD=xyz" });
    expect(value.apiKey).toBe("***");
    expect(value.nested.token).toBe("***");
    expect(value.text).not.toContain("xyz");
  });
});

describe("tokens and formatting", () => {
  test("estimates tokens and costs", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
    const price = priceFor("deepseek-chat");
    expect(price).toBeDefined();
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price);
    expect(cost).toBeCloseTo(1.37, 2);
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, undefined)).toBeUndefined();
  });

  test("string formatters", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(toOneLine("a\n b")).toBe("a b");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(fuzzyScore("abc", "a-b-c")).not.toBeNull();
    expect(fuzzyScore("xyz", "abc")).toBeNull();
  });
});

describe("json parsing", () => {
  test("strips fences and repairs trailing commas", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    expect(parseJsonLoose('{"a":1,}').value).toEqual({ a: 1 });
    expect(parseJsonLoose("not json").ok).toBe(false);
  });
});

describe("env filtering", () => {
  test("removes credentials but keeps basics and passthrough", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/u",
      OPENAI_API_KEY: "sk",
      GITHUB_TOKEN: "t",
      MY_PASSWORD: "p",
      SAFE_VAR: "ok",
      SSH_AUTH_SOCK: "/tmp/agent",
    };
    const filtered = filterEnv(env);
    expect(filtered.PATH).toBe("/bin");
    expect(filtered.SSH_AUTH_SOCK).toBe("/tmp/agent");
    expect(filtered.SAFE_VAR).toBe("ok");
    expect(filtered.OPENAI_API_KEY).toBeUndefined();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    expect(filtered.MY_PASSWORD).toBeUndefined();
    const passthrough = filterEnv(env, ["GITHUB_TOKEN", "MY_*"]);
    expect(passthrough.GITHUB_TOKEN).toBe("t");
    expect(passthrough.MY_PASSWORD).toBe("p");
  });
});

describe("filesystem helpers", () => {
  test("binary detection and atomic writes", () => {
    const dir = tempDir();
    try {
      expect(isBinaryBuffer(Buffer.from("hello"))).toBe(false);
      expect(isBinaryBuffer(Buffer.from([0, 1, 2]))).toBe(true);
      const file = path.join(dir, "sub", "file.txt");
      writeFileAtomicSync(file, "hello");
      expect(readFileTextSafe(file)).toBe("hello");
      expect(hashBytes("hello")).toBe(hashBytes("hello"));
      const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tcli-"));
      expect(leftovers).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
