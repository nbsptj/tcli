import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createBuiltinTools, createToolRegistry } from "../src/tools/index.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createProvider } from "../src/providers/index.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { OpenAiCompatibleProvider } from "../src/providers/openai.ts";
import { ConfigError } from "../src/utils/errors.ts";
import { testConfig, testLogger } from "./helpers.ts";

const resolved = (type: "openai-compatible" | "anthropic" | "ollama" | "mock") => ({
  name: "x",
  type,
  model: "m",
  baseUrl: type === "anthropic" ? "https://api.anthropic.com/v1" : type === "ollama" ? "http://127.0.0.1:11434" : "https://example.com/v1",
  apiKey: "k",
  timeoutMs: 5000,
  maxTokens: 100,
  temperature: 0,
  contextWindow: 1000,
  raw: { type } as never,
});

describe("provider factory", () => {
  test("creates every provider type", () => {
    expect(createProvider(resolved("openai-compatible"))).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(createProvider(resolved("anthropic"))).toBeInstanceOf(AnthropicProvider);
    expect(createProvider(resolved("ollama"))).toBeInstanceOf(OllamaProvider);
    expect(createProvider(resolved("mock"))).toBeInstanceOf(MockProvider);
    expect(() => createProvider({ ...resolved("mock"), type: "nope" as never })).toThrow(ConfigError);
  });
});

describe("tool registry", () => {
  test("registers builtins conditionally and generates schemas", () => {
    const config = testConfig({
      tools: { web: { enabled: true } },
      agent: { subagents: { enabled: false } },
    });
    const tools = createBuiltinTools(config);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("task");
    const registry = createToolRegistry(config);
    expect(registry.names()).toContain("edit_file");
    expect(registry.schemas().every((s) => s.parameters.type === "object")).toBe(true);
    expect(registry.has("read_file")).toBe(true);
    expect(registry.get("read_file")?.kind).toBe("read");
    registry.unregister("read_file");
    expect(registry.has("read_file")).toBe(false);
  });

  test("rejects duplicate registrations and validates schemas", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "test_tool",
      description: "test",
      schema: z.strictObject({ value: z.string() }),
      kind: "read" as const,
      permissionInfo: () => ({ paths: [] }),
      execute: async () => ({ content: "ok" }),
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
    expect(registry.validate("missing", {}).ok).toBe(false);
    expect(registry.validate("test_tool", {}).ok).toBe(false);
    const valid = registry.validate("test_tool", { value: "x" });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value).toEqual({ value: "x" });
  });

  test("supports raw JSON Schema tools with Ajv validation", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "json_tool",
      description: "json",
      schema: z.record(z.string(), z.unknown()),
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
        additionalProperties: false,
      },
      validateInput: (input: unknown) => {
        const obj = input as { n?: unknown };
        return typeof obj?.n === "number"
          ? { ok: true, value: obj }
          : { ok: false, error: "n must be a number" };
      },
      kind: "exec",
      permissionInfo: () => ({ paths: [] }),
      execute: async () => ({ content: "ok" }),
    } as never);
    expect(registry.schemas()[0]!.parameters.properties).toBeDefined();
    expect(registry.validate("json_tool", { n: 1 }).ok).toBe(true);
    expect(registry.validate("json_tool", { n: "x" }).ok).toBe(false);
    void testLogger;
  });
});
