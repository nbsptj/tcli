import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveProvider, missingApiKeyHint } from "../src/config/load.ts";
import { deepMerge } from "../src/config/merge.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { ConfigError } from "../src/utils/errors.ts";
import { cleanup, tempDir, testConfig } from "./helpers.ts";

let home = "";
const originalHome = process.env.TCLI_HOME;

beforeEach(() => {
  home = tempDir("tcli-config-home-");
  process.env.TCLI_HOME = home;
});

afterEach(() => {
  cleanup(home);
  if (originalHome === undefined) delete process.env.TCLI_HOME;
  else process.env.TCLI_HOME = originalHome;
});

function writeConfig(dir: string, name: string, value: unknown): void {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

describe("configuration", () => {
  test("defaults validate", () => {
    expect(() => ConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow();
    expect(DEFAULT_CONFIG.provider).toBe("deepseek");
    expect(DEFAULT_CONFIG.permissions.mode).toBe("default");
  });

  test("deep merge concatenates arrays and overrides scalars", () => {
    const merged = deepMerge(
      { a: 1, list: [1], nested: { x: 1, y: 2 } },
      { a: 2, list: [2], nested: { y: 3 } },
    ) as { a: number; list: number[]; nested: { x: number; y: number } };
    expect(merged).toEqual({ a: 2, list: [1, 2], nested: { x: 1, y: 3 } });
  });

  test("layers user, project, environment and CLI overrides", () => {
    writeConfig(home, "config.json", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 10,
      permissions: { autoApproveYes: ["read_file"] },
    });
    const cwd = tempDir("tcli-config-ws-");
    try {
      writeConfig(path.join(cwd, ".tcli"), "config.json", {
        model: "gpt-4.1-mini",
        maxSteps: 12,
        permissions: { autoApproveYes: ["glob"], rules: [{ tool: "bash", match: "git status", action: "allow" }] },
      });
      const loaded = loadConfig({
        cwd,
        env: { ...process.env, TCLI_MAX_STEPS: "15", TCLI_TEMPERATURE: "0.3" },
        cli: { maxSteps: 20, model: "gpt-4.1" },
      });
      expect(loaded.sources.length).toBe(2);
      expect(loaded.config.provider).toBe("openai");
      expect(loaded.config.model).toBe("gpt-4.1");
      expect(loaded.config.maxSteps).toBe(20);
      expect(loaded.config.temperature).toBe(0.3);
      expect(loaded.config.permissions.autoApproveYes).toEqual([
        "read_file",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "todo",
        "read_file",
        "glob",
      ]);
      expect(loaded.config.permissions.rules.some((r) => r.match === "git status")).toBe(true);
    } finally {
      cleanup(cwd);
    }
  });

  test("environment selects a provider and its default model", () => {
    const loaded = loadConfig({
      cwd: tempDir(),
      env: { ...process.env, TCLI_PROVIDER: "anthropic" },
    });
    expect(loaded.config.provider).toBe("anthropic");
    expect(loaded.config.model).toBe("claude-sonnet-4-20250514");
  });

  test("invalid config reports the field path", () => {
    const cwd = tempDir();
    try {
      writeConfig(path.join(cwd, ".tcli"), "config.json", { maxSteps: -5, permissions: { mode: "nope" } });
      expect(() => loadConfig({ cwd, env: { ...process.env } })).toThrow(ConfigError);
      try {
        loadConfig({ cwd, env: { ...process.env } });
      } catch (err) {
        expect((err as Error).message).toContain("maxSteps");
        expect((err as Error).message).toContain("permissions.mode");
      }
    } finally {
      cleanup(cwd);
    }
  });

  test("unknown provider is rejected", () => {
    const cwd = tempDir();
    try {
      expect(() => loadConfig({ cwd, env: { ...process.env }, cli: { provider: "nope" } })).toThrow(/Unknown provider/);
    } finally {
      cleanup(cwd);
    }
  });

  test("$schema is accepted for editor tooling", () => {
    const cwd = tempDir();
    try {
      writeConfig(path.join(cwd, ".tcli"), "config.json", { $schema: "https://example.com/tcli.json", model: "x" });
      const loaded = loadConfig({ cwd, env: { ...process.env }, cli: { provider: "mock" } });
      expect(loaded.config.model).toBe("mock");
    } finally {
      cleanup(cwd);
    }
  });

  test("resolveProvider resolves keys and prices", () => {
    const config = testConfig({ provider: "deepseek", model: "deepseek-chat" });
    const resolved = resolveProvider(config, "deepseek", "deepseek-chat", { DEEPSEEK_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(resolved.contextWindow).toBe(config.context.window);
    expect(missingApiKeyHint(resolved)).toBeUndefined();

    const missing = resolveProvider(config, "deepseek", "deepseek-chat", {} as NodeJS.ProcessEnv);
    expect(missingApiKeyHint(missing)).toContain("DEEPSEEK_API_KEY");
  });

  test("ollama and mock need no API key", () => {
    const config = testConfig();
    expect(missingApiKeyHint(resolveProvider(config, "ollama", "x", {} as NodeJS.ProcessEnv))).toBeUndefined();
    expect(missingApiKeyHint(resolveProvider(config, "mock", "mock", {} as NodeJS.ProcessEnv))).toBeUndefined();
  });
});
