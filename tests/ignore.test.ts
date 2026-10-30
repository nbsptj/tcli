import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { IgnoreMatcher } from "../src/ignore/matcher.ts";
import { walkFiles } from "../src/utils/fs.ts";
import { cleanup, makeRepo, writeFiles } from "./helpers.ts";

describe("ignore matcher", () => {
  test("root gitignore semantics", () => {
    const dir = makeRepo({
      ".gitignore": [
        "node_modules/",
        "dist",
        "*.log",
        "!important.log",
        "/secret.txt",
        "src/generated/",
        "**/coverage/",
      ].join("\n"),
      "node_modules/a.js": "",
      "dist/out.js": "",
      "a.log": "",
      "important.log": "",
      "secret.txt": "",
      "src/secret.txt": "",
      "src/generated/x.js": "",
      "coverage/x.html": "",
      "src/coverage/y.html": "",
    });
    try {
      const matcher = new IgnoreMatcher(dir);
      expect(matcher.isIgnored(path.join(dir, "node_modules/a.js"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "dist/out.js"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "a.log"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "important.log"))).toBe(false);
      expect(matcher.isIgnored(path.join(dir, "secret.txt"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "src/secret.txt"))).toBe(false);
      expect(matcher.isIgnored(path.join(dir, "src/generated/x.js"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "coverage/x.html"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "src/coverage/y.html"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, ".git/config"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "src/index.ts"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("nested gitignore and .tcliignore", () => {
    const dir = makeRepo({
      ".gitignore": "root.tmp\n",
      ".tcliignore": "extra/\n",
      "src/.gitignore": "*.tmp\nlocal/\n",
      "src/a.tmp": "",
      "src/b.ts": "",
      "root.tmp": "",
      "other/a.tmp": "",
      "extra/e.txt": "",
      "src/local/l.txt": "",
    });
    try {
      const matcher = new IgnoreMatcher(dir);
      expect(matcher.isIgnored(path.join(dir, "src/a.tmp"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "other/a.tmp"))).toBe(false);
      expect(matcher.isIgnored(path.join(dir, "extra/e.txt"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "src/local/l.txt"))).toBe(true);
      expect(matcher.isIgnored(path.join(dir, "src/b.ts"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("walkFiles prunes ignored directories", () => {
    const dir = makeRepo({
      ".gitignore": "node_modules/\n",
      "node_modules/pkg/index.js": "",
      "src/a.ts": "",
      "README.md": "",
    });
    try {
      const matcher = new IgnoreMatcher(dir);
      const files = [...walkFiles(dir, { shouldIgnore: matcher.shouldIgnore })].map((f) => f.rel).sort();
      expect(files).toEqual([".gitignore", "README.md", "src/a.ts"]);
    } finally {
      cleanup(dir);
    }
  });
});
