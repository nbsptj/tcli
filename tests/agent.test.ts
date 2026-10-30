import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createAgentHarness, collect, testConfig, makeRepo, cleanup, testLogger, makePermissions, tempDir } from "./helpers.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import { taskTool } from "../src/tools/task.ts";
import type { AnyToolDefinition, ToolDefinition } from "../src/tools/types.ts";
import { emptyUsage, type ChatMessage } from "../src/types.ts";
import type { StreamEvent } from "../src/providers/types.ts";
import { Agent } from "../src/agent/agent.ts";
import { SessionStore } from "../src/session/store.ts";
import { SnapshotStore } from "../src/context/snapshots.ts";
import { CheckpointStore } from "../src/context/checkpoint.ts";
import { TodoStore } from "../src/tools/todo-store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { getRepoOverview } from "../src/context/overview.ts";
import { loadInstructions } from "../src/context/instructions.ts";
import { ProviderError } from "../src/utils/errors.ts";

let testHome = "";
const originalHome = process.env.TCLI_HOME;

beforeEach(() => {
  testHome = tempDir("tcli-agent-home-");
  process.env.TCLI_HOME = testHome;
});

afterEach(() => {
  cleanup(testHome);
  if (originalHome === undefined) delete process.env.TCLI_HOME;
  else process.env.TCLI_HOME = originalHome;
});

function textTurn(text: string): StreamEvent[] {
  return [
    { type: "text", text },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { type: "stop", reason: "end" },
  ];
}

function toolTurn(name: string, args: Record<string, unknown>, id = "call_1"): StreamEvent[] {
  return [
    { type: "tool_call", toolCall: { id, name, arguments: args } },
    { type: "usage", usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { type: "stop", reason: "tool_use" },
  ];
}

function customTool(
  name: string,
  kind: "read" | "write",
  run: (input: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
  events?: { starts?: string[]; ends?: string[]; active?: { value: number; max: number } },
): AnyToolDefinition {
  const schema = z.strictObject({ id: z.string(), ms: z.number().min(0).max(5000).optional() });
  const tool: ToolDefinition<typeof schema> = {
    name,
    description: "test tool",
    schema,
    kind,
    permissionInfo: () => ({ paths: [] }),
    async execute(input, ctx) {
      if (events?.starts) events.starts.push(input.id);
      if (events?.active) {
        events.active.value++;
        events.active.max = Math.max(events.active.max, events.active.value);
      }
      try {
        return { content: await run(input as Record<string, unknown>, ctx.signal) };
      } finally {
        if (events?.ends) events.ends.push(input.id);
        if (events?.active) events.active.value--;
      }
    },
  };
  return tool as unknown as AnyToolDefinition;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("agent loop", () => {
  test("completes a text-only turn and records messages", async () => {
    const harness = createAgentHarness({ scripts: [textTurn("hello there")], autoSave: true });
    try {
      const { events, result } = await collect(harness.agent, "say hi");
      expect(result.reason).toBe("end");
      expect(result.text).toBe("hello there");
      const text = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("");
      expect(text).toBe("hello there");
      expect(harness.agent.getMessages().map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(harness.session.meta.title).toBe("say hi");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("executes a tool, feeds the result back and finishes", async () => {
    const harness = createAgentHarness({
      scripts: [toolTurn("read_file", { path: "a.txt" }), textTurn("all done")],
      tools: [readFileTool as unknown as AnyToolDefinition],
      files: { "a.txt": "file contents\n" },
      autoSave: true,
    });
    try {
      const { events, result } = await collect(harness.agent, "read a.txt");
      expect(result.reason).toBe("end");
      expect(result.text).toBe("all done");
      const started = events.filter((e) => e.type === "tool_start");
      expect(started.length).toBe(1);
      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      if (toolResult?.type === "tool_result") {
        expect(toolResult.outcome.ok).toBe(true);
        expect(toolResult.outcome.content).toContain("file contents");
      }
      const roles = harness.agent.getMessages().map((m) => m.role);
      expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
      const toolMessage = harness.agent.getMessages().find((m) => m.role === "tool")!;
      expect(toolMessage.toolCallId).toBe("call_1");
      expect(toolMessage.content).toContain("file contents");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("permission denial becomes a tool result and never runs the tool", async () => {
    let executed = false;
    const asker = async () => {
      return { type: "no" as const };
    };
    const harness = createAgentHarness({
      scripts: [toolTurn("write_file", { path: "a.txt", content: "danger" }), textTurn("ok, skipped")],
      tools: [writeFileTool as unknown as AnyToolDefinition],
      asker,
      autoSave: false,
    });
    try {
      const { events, result } = await collect(harness.agent, "write it");
      expect(result.text).toBe("ok, skipped");
      const permission = events.find((e) => e.type === "permission");
      expect(permission).toBeDefined();
      if (permission?.type === "permission") {
        expect(permission.allowed).toBe(false);
      }
      const toolResult = events.find((e) => e.type === "tool_result");
      if (toolResult?.type === "tool_result") {
        expect(toolResult.outcome.ok).toBe(false);
        expect(toolResult.outcome.denied).toBe(true);
        expect(toolResult.outcome.content).toContain("Permission denied");
      }
      expect(executed).toBe(false);
      expect(fs.existsSync(path.join(harness.dir, "a.txt"))).toBe(false);
    } finally {
      cleanup(harness.dir);
    }
  });

  test("invalid tool arguments are reported without a permission prompt", async () => {
    let asks = 0;
    const harness = createAgentHarness({
      scripts: [toolTurn("read_file", {}), textTurn("recovered")],
      tools: [readFileTool as unknown as AnyToolDefinition],
      asker: async () => {
        asks++;
        return { type: "yes" };
      },
    });
    try {
      const { events } = await collect(harness.agent, "bad call");
      expect(asks).toBe(0);
      const result = events.find((e) => e.type === "tool_result");
      if (result?.type === "tool_result") {
        expect(result.outcome.ok).toBe(false);
        expect(result.outcome.content).toContain("Invalid arguments");
      }
    } finally {
      cleanup(harness.dir);
    }
  });

  test("read-only tool calls in one batch run concurrently and keep result order", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const active = { value: 0, max: 0 };
    const slowRead = customTool(
      "slow_read",
      "read",
      async (input) => {
        await sleep(60);
        return `result-${input.id}`;
      },
      { starts, ends, active },
    );
    const harness = createAgentHarness({
      scripts: [
        [
          { type: "tool_call", toolCall: { id: "c1", name: "slow_read", arguments: { id: "one", ms: 60 } } },
          { type: "tool_call", toolCall: { id: "c2", name: "slow_read", arguments: { id: "two", ms: 60 } } },
          { type: "stop", reason: "tool_use" },
        ],
        textTurn("parallel done"),
      ],
      tools: [slowRead],
    });
    try {
      await collect(harness.agent, "run both");
      expect(active.max).toBe(2);
      expect(starts).toEqual(["one", "two"]);
      const toolMessages = harness.agent.getMessages().filter((m) => m.role === "tool");
      expect(toolMessages.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
      expect(toolMessages[0]!.content).toContain("result-one");
      expect(toolMessages[1]!.content).toContain("result-two");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("write tools execute serially in call order", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const active = { value: 0, max: 0 };
    const slowWrite = customTool(
      "slow_write",
      "write",
      async (input) => {
        await sleep(30);
        return `wrote-${input.id}`;
      },
      { starts, ends, active },
    );
    const harness = createAgentHarness({
      scripts: [
        [
          { type: "tool_call", toolCall: { id: "w1", name: "slow_write", arguments: { id: "a" } } },
          { type: "tool_call", toolCall: { id: "w2", name: "slow_write", arguments: { id: "b" } } },
          { type: "stop", reason: "tool_use" },
        ],
        textTurn("serial done"),
      ],
      tools: [slowWrite],
      config: testConfig({ permissions: { mode: "workspace-write" } }),
    });
    try {
      await collect(harness.agent, "write both");
      expect(active.max).toBe(1);
      expect(starts).toEqual(["a", "b"]);
      expect(ends).toEqual(["a", "b"]);
    } finally {
      cleanup(harness.dir);
    }
  });

  test("step limit stops the loop and keeps tool pairing intact", async () => {
    const noop = customTool("noop", "read", async () => "ok");
    const script = toolTurn("noop", { id: "x" });
    const harness = createAgentHarness({
      scripts: [script, script, script],
      tools: [noop],
      maxSteps: 2,
    });
    try {
      const { events, result } = await collect(harness.agent, "loop forever");
      expect(result.reason).toBe("budget");
      expect(events.some((e) => e.type === "notice" && e.text.includes("maximum"))).toBe(true);
      const messages = harness.agent.getMessages();
      const assistantCalls = messages.filter((m) => m.role === "assistant" && m.toolCalls?.length).length;
      const toolResults = messages.filter((m) => m.role === "tool").length;
      expect(assistantCalls).toBe(2);
      expect(toolResults).toBe(2);
    } finally {
      cleanup(harness.dir);
    }
  });

  test("token budget stops before executing the next tool batch", async () => {
    const noop = customTool("noop", "read", async () => "ok");
    const harness = createAgentHarness({
      scripts: [toolTurn("noop", { id: "x" })],
      tools: [noop],
      config: testConfig({ agent: { budget: { maxTokens: 5, maxCostUsd: 0 } } }),
    });
    try {
      const { events, result } = await collect(harness.agent, "do it");
      expect(result.reason).toBe("budget");
      expect(events.some((e) => e.type === "notice" && e.text.includes("Token budget"))).toBe(true);
      const messages = harness.agent.getMessages();
      expect(messages.filter((m) => m.role === "tool").length).toBe(1);
      expect(messages.find((m) => m.role === "tool")!.content).toContain("not executed");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("provider error ends the run and surfaces an error event", async () => {
    const harness = createAgentHarness({
      scripts: [
        [
          { type: "error", error: new ProviderError("model unavailable", { retryable: false }), retryable: false },
        ],
      ],
    });
    try {
      const { events, result } = await collect(harness.agent, "hello");
      expect(result.reason).toBe("error");
      expect(events.some((e) => e.type === "error" && e.message.includes("model unavailable"))).toBe(true);
    } finally {
      cleanup(harness.dir);
    }
  });

  test("compaction summarizes older turns and records a compaction event", async () => {
    const initialMessages: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      initialMessages.push({ role: "user", content: `old user ${i} `.repeat(30) });
      initialMessages.push({ role: "assistant", content: `old assistant ${i} `.repeat(30) });
    }
    const harness = createAgentHarness({
      scripts: [textTurn("CONDENSED"), textTurn("final answer")],
      initialMessages,
      config: testConfig({ context: { window: 1200, compactAt: 0.9, keepRecentTurns: 1 } }),
    });
    try {
      const { events, result } = await collect(harness.agent, "new request");
      expect(result.text).toBe("final answer");
      expect(events.some((e) => e.type === "compaction")).toBe(true);
      const messages = harness.agent.getMessages();
      expect(messages[0]!.role).toBe("system");
      expect(messages[0]!.content).toContain("CONDENSED");
      expect(messages.some((m) => m.role === "user" && m.content.startsWith("new request"))).toBe(true);
      expect(messages.some((m) => m.role === "user" && m.content.startsWith("old user 0"))).toBe(false);
    } finally {
      cleanup(harness.dir);
    }
  });

  test("task tool runs an isolated subagent and returns its report", async () => {
    const harness = createAgentHarness({
      scripts: [
        toolTurn("task", { description: "sub", prompt: "find it" }),
        textTurn("subagent report"),
        textTurn("parent final"),
      ],
      tools: [taskTool as unknown as AnyToolDefinition],
    });
    try {
      const { result } = await collect(harness.agent, "delegate");
      expect(result.text).toBe("parent final");
      const toolMessage = harness.agent.getMessages().find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("subagent report");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("abort returns reason aborted and keeps the partial assistant text", async () => {
    const dir = makeRepo({});
    const config = testConfig();
    const logger = testLogger();
    const permissions = makePermissions(dir, config);
    const session = SessionStore.create({ cwd: dir, provider: "slow", model: "slow", traceId: "t", autoSave: false });
    const slowProvider = {
      id: "slow",
      type: "mock",
      model: "slow",
      async *stream(req: import("../src/providers/types.ts").ProviderRequest) {
        yield { type: "text" as const, text: "partial answer" };
        for (let i = 0; i < 100; i++) {
          if (req.signal.aborted) throw new Error("aborted");
          await sleep(20);
        }
        yield { type: "stop" as const, reason: "end" as const };
      },
    };
    const agent = new Agent({
      workspace: dir,
      config,
      provider: slowProvider,
      resolved: {
        name: "slow",
        type: "mock",
        model: "slow",
        baseUrl: "mock://",
        timeoutMs: 1000,
        maxTokens: 100,
        temperature: 0,
        contextWindow: 10000,
        raw: { type: "mock" },
      },
      tools: new ToolRegistry(),
      permissions,
      logger,
      snapshots: new SnapshotStore(),
      checkpoints: new CheckpointStore(session.dir),
      todo: new TodoStore(),
      session,
      overview: getRepoOverview(dir, config),
      instructions: loadInstructions(dir, config),
      traceId: "t",
      sessionId: session.id,
    });
    try {
      const iterator = agent.run("slow task");
      let first = await iterator.next();
      while (!first.done && first.value.type !== "text") first = await iterator.next();
      expect(first.done).toBe(false);
      if (!first.done && first.value.type === "text") expect(first.value.text).toBe("partial answer");
      agent.cancel();
      let result: import("../src/agent/events.ts").AgentRunResult | undefined;
      const events: import("../src/agent/events.ts").AgentEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        events.push(next.value);
      }
      expect(result?.reason).toBe("aborted");
      expect(events.some((e) => e.type === "notice" && e.text.includes("Interrupted"))).toBe(true);
      const assistant = agent.getMessages().find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("partial answer");
    } finally {
      cleanup(dir);
    }
  });

  test("text-only empty usage is estimated", async () => {
    const harness = createAgentHarness({
      scripts: [[{ type: "text", text: "hello" }, { type: "stop", reason: "end" }]],
    });
    try {
      const { result } = await collect(harness.agent, "hi");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    } finally {
      cleanup(harness.dir);
    }
  });
});
