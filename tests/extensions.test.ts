import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { HookRunner } from "../src/agent/hooks.ts";
import { testConfig, makeRepo, cleanup, testLogger, tempDir } from "./helpers.ts";
import { loadCustomTools } from "../src/custom/tools.ts";
import { loadCustomCommands, expandCustomCommand, splitCommandArgs } from "../src/commands/custom.ts";
import { initProject } from "../src/commands/init.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { makeContext } from "./helpers.ts";

describe("hooks", () => {
  test("preToolUse can deny, ask or modify input", async () => {
    const dir = makeRepo({});
    try {
      const config = testConfig();
      const logger = testLogger();
      const deny = new HookRunner({
        hooks: { ...config.hooks, preToolUse: [{ command: `echo '{"decision":"deny","reason":"blocked"}'` }] },
        cwd: dir,
        sessionId: "s",
        logger,
      });
      expect(await deny.preTool("bash", { command: "ls" })).toEqual({
        decision: "deny",
        reason: "blocked",
      });

      const modify = new HookRunner({
        hooks: { ...config.hooks, preToolUse: [{ command: `echo '{"input":{"path":"other.txt"}}'` }] },
        cwd: dir,
        sessionId: "s",
        logger,
      });
      expect(await modify.preTool("read_file", { path: "a.txt" })).toEqual({
        input: { path: "other.txt" },
      });

      const ask = new HookRunner({
        hooks: { ...config.hooks, preToolUse: [{ command: `echo '{"decision":"ask","reason":"look"}'` }] },
        cwd: dir,
        sessionId: "s",
        logger,
      });
      expect(await ask.preTool("bash", { command: "ls" })).toEqual({ decision: "ask", reason: "look" });
    } finally {
      cleanup(dir);
    }
  });

  test("exit code 2 blocks and matchers filter tools", async () => {
    const dir = makeRepo({});
    try {
      const config = testConfig();
      const runner = new HookRunner({
        hooks: {
          ...config.hooks,
          preToolUse: [{ matcher: "bash", command: "echo nope >&2; exit 2" }],
        },
        cwd: dir,
        sessionId: "s",
        logger: testLogger(),
      });
      const blocked = await runner.preTool("bash", { command: "ls" });
      expect(blocked.decision).toBe("deny");
      expect(blocked.reason).toContain("nope");
      expect(await runner.preTool("read_file", { path: "a" })).toEqual({});
    } finally {
      cleanup(dir);
    }
  });

  test("post and session hooks run with TCLI environment", async () => {
    const dir = makeRepo({});
    try {
      const config = testConfig();
      const runner = new HookRunner({
        hooks: {
          ...config.hooks,
          sessionStart: [{ command: "touch session-start" }],
          sessionEnd: [{ command: "touch session-end" }],
          postToolUse: [{ command: `[ "$TCLI_TOOL" = "read_file" ] && touch post-ran` }],
        },
        cwd: dir,
        sessionId: "s",
        logger: testLogger(),
      });
      await runner.sessionStart();
      await runner.postTool("read_file", {}, { ok: true, summary: "ok" });
      await runner.sessionEnd();
      expect(fs.existsSync(path.join(dir, "session-start"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "session-end"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "post-ran"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe("custom slash commands", () => {
  test("loads frontmatter and expands arguments", () => {
    const home = tempDir("tcli-cmd-home-");
    const original = process.env.TCLI_HOME;
    process.env.TCLI_HOME = home;
    const repo = makeRepo({
      ".tcli/commands/review.md": [
        "---",
        "description: Review changes",
        "argument-hint: <file>",
        "---",
        "Please review $1 with care.",
        "",
        "All args: $ARGUMENTS",
      ].join("\n"),
      ".tcli/commands/plain.md": "Do the thing.",
    });
    try {
      const result = loadCustomCommands(repo, testConfig());
      expect(result.commands.map((c) => c.name)).toEqual(["plain", "review"]);
      const review = result.commands.find((c) => c.name === "review")!;
      expect(review.description).toBe("Review changes");
      expect(expandCustomCommand(review, '"src/a.ts" extra')).toBe(
        'Please review src/a.ts with care.\n\nAll args: "src/a.ts" extra',
      );
      const plain = result.commands.find((c) => c.name === "plain")!;
      expect(expandCustomCommand(plain, "hello world")).toBe("Do the thing.\n\nhello world");
      expect(splitCommandArgs(`a "b c" 'd e'`)).toEqual(["a", "b c", "d e"]);
    } finally {
      cleanup(repo);
      cleanup(home);
      if (original === undefined) delete process.env.TCLI_HOME;
      else process.env.TCLI_HOME = original;
    }
  });
});

describe("custom tools", () => {
  test("loads JSON-schema and Zod modules and executes them", async () => {
    const home = tempDir("tcli-tools-home-");
    const original = process.env.TCLI_HOME;
    process.env.TCLI_HOME = home;
    const repo = makeRepo({
      ".tcli/tools/hello.ts": `
        export default {
          name: "hello",
          description: "Say hello",
          parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
          readOnly: true,
          execute(args) { return { content: "hello " + args.name }; }
        };
      `,
    });
    try {
      const config = testConfig({ customTools: { enabled: true, dirs: [] } });
      const result = await loadCustomTools({ cwd: repo, config, logger: testLogger() });
      expect(result.warnings).toEqual([]);
      expect(result.tools.length).toBe(1);
      const tool = result.tools[0]!;
      expect(tool.name).toBe("custom__hello");
      expect(tool.kind).toBe("read");
      const registry = new ToolRegistry();
      registry.register(tool);
      expect(registry.validate("custom__hello", {}).ok).toBe(false);
      const valid = registry.validate("custom__hello", { name: "world" });
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        const ctx = makeContext(repo, config);
        const output = await valid.tool.execute(valid.value, ctx);
        expect(output.content).toBe("hello world");
      }
      expect(registry.schemas()[0]!.parameters).toMatchObject({ type: "object" });
    } finally {
      cleanup(repo);
      cleanup(home);
      if (original === undefined) delete process.env.TCLI_HOME;
      else process.env.TCLI_HOME = original;
    }
  });

  test("is disabled by default and reports import errors", async () => {
    const home = tempDir("tcli-tools-home-");
    const original = process.env.TCLI_HOME;
    process.env.TCLI_HOME = home;
    const repo = makeRepo({
      ".tcli/tools/broken.ts": "export default { nope: true };",
    });
    try {
      const disabled = await loadCustomTools({ cwd: repo, config: testConfig(), logger: testLogger() });
      expect(disabled.tools).toEqual([]);
      const enabled = await loadCustomTools({
        cwd: repo,
        config: testConfig({ customTools: { enabled: true, dirs: [] } }),
        logger: testLogger(),
      });
      expect(enabled.tools).toEqual([]);
      expect(enabled.warnings[0]).toContain("execute");
    } finally {
      cleanup(repo);
      cleanup(home);
      if (original === undefined) delete process.env.TCLI_HOME;
      else process.env.TCLI_HOME = original;
    }
  });
});

describe("project init", () => {
  test("creates config, AGENTS.md and gitignore without overwriting", () => {
    const repo = makeRepo({ "AGENTS.md": "existing\n" });
    try {
      const first = initProject(repo);
      expect(first.created.some((f) => f.endsWith(".tcli/config.json"))).toBe(true);
      expect(first.skipped.some((f) => f.endsWith("AGENTS.md"))).toBe(true);
      expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe("existing\n");
      const gitignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
      expect(gitignore).toContain(".tcli/");
      const second = initProject(repo);
      expect(second.created).toEqual([]);
      expect(second.skipped.length).toBe(2);
    } finally {
      cleanup(repo);
    }
  });
});

describe("tool context helper", () => {
  test("makeContext provides stores", () => {
    const repo = makeRepo({});
    try {
      const ctx: ToolContext = makeContext(repo, testConfig());
      expect(ctx.cwd).toBe(repo);
      expect(ctx.snapshots).toBeDefined();
      expect(ctx.checkpoints).toBeDefined();
    } finally {
      cleanup(repo);
    }
  });
});
