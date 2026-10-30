import { describe, expect, test } from "bun:test";
import { parseSse } from "../src/providers/sse.ts";
import { OpenAiCompatibleProvider } from "../src/providers/openai.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { streamWithRetry } from "../src/providers/http.ts";
import { ProviderError } from "../src/utils/errors.ts";
import { startFakeOpenAi } from "./helpers.ts";
import type { StreamEvent } from "../src/providers/types.ts";
import { emptyUsage, type ChatMessage } from "../src/types.ts";

async function collect(gen: AsyncGenerator<StreamEvent, void, unknown>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function encoderStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const messages: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
];

describe("SSE parser", () => {
  test("handles arbitrary chunk boundaries, CRLF and multi-line data", async () => {
    const chunks = [
      "event: message\r",
      "\ndata: hel",
      "lo\n\n: comment\n\ndata: {\"a\":1}\n",
      "\ndata: line1\ndata: line2\n\n",
    ];
    const parsed = [];
    for await (const message of parseSse(encoderStream(chunks))) parsed.push(message);
    expect(parsed[0]).toEqual({ event: "message", data: "hello", id: undefined, retry: undefined });
    expect(parsed[1]!.data).toBe('{"a":1}');
    expect(parsed[2]!.data).toBe("line1\nline2");
  });

  test("decodes split multi-byte UTF-8", async () => {
    const bytes = new TextEncoder().encode("data: 你好\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    const parsed = [];
    for await (const message of parseSse(stream)) parsed.push(message);
    expect(parsed[0]!.data).toBe("你好");
  });
});

describe("OpenAI-compatible provider", () => {
  test("streams text, tool calls, usage and stop reason", async () => {
    const fake = startFakeOpenAi([
      {
        text: "need a file",
        toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }],
        finish: "tool_calls",
        usage: { input: 12, output: 7, cached: 3 },
      },
    ]);
    try {
      const provider = new OpenAiCompatibleProvider({
        id: "openai",
        type: "openai-compatible",
        model: "fake-model",
        baseUrl: fake.baseUrl,
        apiKey: "test",
        timeoutMs: 5000,
      });
      const events = await collect(
        provider.stream({
          messages,
          tools: [
            {
              name: "read_file",
              description: "read",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
          temperature: 0,
          maxTokens: 100,
          signal: new AbortController().signal,
        }),
      );
      expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("")).toBe("need a file");
      const tool = events.find((e) => e.type === "tool_call");
      expect(tool).toBeDefined();
      if (tool?.type === "tool_call") {
        expect(tool.toolCall.name).toBe("read_file");
        expect(tool.toolCall.arguments).toEqual({ path: "a.ts" });
      }
      const usage = events.find((e) => e.type === "usage");
      expect(usage).toBeDefined();
      if (usage?.type === "usage") {
        expect(usage.usage.inputTokens).toBe(12);
        expect(usage.usage.outputTokens).toBe(7);
        expect(usage.usage.cacheReadTokens).toBe(3);
      }
      expect(events.find((e) => e.type === "stop")).toEqual({ type: "stop", reason: "tool_use" });

      const request = fake.requests[0] as { model: string; stream: boolean; messages: unknown[]; tools: unknown[] };
      expect(request.model).toBe("fake-model");
      expect(request.stream).toBe(true);
      expect(request.tools.length).toBe(1);
      expect(request.messages.length).toBe(2);
    } finally {
      fake.close();
    }
  });

  test("reports HTTP errors as ProviderError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    });
    try {
      const provider = new OpenAiCompatibleProvider({
        id: "openai",
        type: "openai-compatible",
        model: "m",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "bad",
        timeoutMs: 5000,
      });
      await expect(
        collect(
          provider.stream({
            messages,
            tools: [],
            temperature: 0,
            maxTokens: 10,
            signal: new AbortController().signal,
          }),
        ),
      ).rejects.toThrow(/401/);
    } finally {
      server.stop(true);
    }
  });
});

describe("retry wrapper", () => {
  test("retries a retryable error before any output", async () => {
    const scripts: StreamEvent[][] = [
      [{ type: "error", error: new ProviderError("rate limited", { retryable: true, retryAfterMs: 0 }), retryable: true }],
      [{ type: "text", text: "recovered" }, { type: "usage", usage: emptyUsage() }, { type: "stop", reason: "end" }],
    ];
    let calls = 0;
    const provider = {
      id: "p",
      type: "mock",
      model: "m",
      async *stream() {
        const script = scripts[calls++]!;
        for (const event of script) yield event;
      },
    };
    const events = await collect(
      streamWithRetry(provider, {
        messages,
        tools: [],
        temperature: 0,
        maxTokens: 10,
        signal: new AbortController().signal,
      }),
    );
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "retry")).toBe(true);
    expect(events.some((e) => e.type === "text" && e.text === "recovered")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
  });

  test("does not retry after output has been committed", async () => {
    let calls = 0;
    const provider = {
      id: "p",
      type: "mock",
      model: "m",
      async *stream() {
        calls++;
        yield { type: "text" as const, text: "partial" };
        yield { type: "error" as const, error: new ProviderError("boom", { retryable: true }), retryable: true };
      },
    };
    const events = await collect(
      streamWithRetry(provider, {
        messages,
        tools: [],
        temperature: 0,
        maxTokens: 10,
        signal: new AbortController().signal,
      }),
    );
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("Anthropic provider", () => {
  test("parses content blocks, tool use and usage", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const encoder = new TextEncoder();
    let server: ReturnType<typeof Bun.serve>;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push((await req.json()) as Record<string, unknown>);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: string, data: unknown) =>
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            send("message_start", {
              type: "message_start",
              message: { usage: { input_tokens: 12, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } },
            });
            send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } });
            send("content_block_stop", { type: "content_block_stop", index: 0 });
            send("content_block_start", {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"path":"a' },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '.ts"}' },
            });
            send("content_block_stop", { type: "content_block_stop", index: 1 });
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 9 },
            });
            send("message_stop", { type: "message_stop" });
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const provider = new AnthropicProvider({
        id: "anthropic",
        type: "anthropic",
        model: "claude-test",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-ant",
        timeoutMs: 5000,
      });
      const events = await collect(
        provider.stream({
          messages: [
            { role: "system", content: "be nice" },
            { role: "user", content: "read a.ts" },
            { role: "tool", toolCallId: "t1", toolName: "read_file", content: "body" },
          ],
          tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
          temperature: 0,
          maxTokens: 100,
          signal: new AbortController().signal,
        }),
      );
      expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("")).toBe("hello ");
      const tool = events.find((e) => e.type === "tool_call");
      if (tool?.type === "tool_call") {
        expect(tool.toolCall.id).toBe("toolu_1");
        expect(tool.toolCall.arguments).toEqual({ path: "a.ts" });
      }
      const usage = events.find((e) => e.type === "usage");
      if (usage?.type === "usage") {
        expect(usage.usage.inputTokens).toBe(14);
        expect(usage.usage.cacheReadTokens).toBe(2);
        expect(usage.usage.outputTokens).toBe(9);
      }
      expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
      const request = requests[0]!;
      expect(request.system).toBe("be nice");
      expect((request.tools as Array<{ input_schema: unknown }>)[0]!.input_schema).toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});

describe("Ollama provider", () => {
  test("parses NDJSON streaming and tool calls", async () => {
    const encoder = new TextEncoder();
    let server: ReturnType<typeof Bun.serve>;
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "Hi " }, done: false }) + "\n"));
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    message: {
                      content: "",
                      tool_calls: [{ function: { name: "read_file", arguments: { path: "x" } } }],
                    },
                    done: false,
                  }) + "\n",
                ),
              );
              controller.enqueue(
                encoder.encode(JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 6 }) + "\n"),
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    });
    try {
      const provider = new OllamaProvider({
        id: "ollama",
        type: "ollama",
        model: "qwen",
        baseUrl: `http://127.0.0.1:${server.port}`,
        timeoutMs: 5000,
      });
      const events = await collect(
        provider.stream({ messages, tools: [], temperature: 0, maxTokens: 100, signal: new AbortController().signal }),
      );
      expect(events.some((e) => e.type === "text" && e.text === "Hi ")).toBe(true);
      const tool = events.find((e) => e.type === "tool_call");
      if (tool?.type === "tool_call") expect(tool.toolCall.arguments).toEqual({ path: "x" });
      const usage = events.find((e) => e.type === "usage");
      if (usage?.type === "usage") {
        expect(usage.usage.inputTokens).toBe(5);
        expect(usage.usage.outputTokens).toBe(6);
      }
      expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
    } finally {
      server.stop(true);
    }
  });
});

describe("mock provider", () => {
  test("does not repeat tool calls after a tool result", async () => {
    const provider = new MockProvider({ id: "mock", type: "mock", model: "mock", baseUrl: "mock://", timeoutMs: 1000 });
    const first = await collect(
      provider.stream({
        messages: [{ role: "user", content: 'run [[tool:bash {"command":"echo hi"}]]' }],
        tools: [],
        temperature: 0,
        maxTokens: 100,
        signal: new AbortController().signal,
      }),
    );
    expect(first.some((e) => e.type === "tool_call")).toBe(true);
    const second = await collect(
      provider.stream({
        messages: [
          { role: "user", content: 'run [[tool:bash {"command":"echo hi"}]]' },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "echo hi" } }] },
          { role: "tool", toolCallId: "c1", content: "hi" },
        ],
        tools: [],
        temperature: 0,
        maxTokens: 100,
        signal: new AbortController().signal,
      }),
    );
    expect(second.some((e) => e.type === "tool_call")).toBe(false);
    expect(second.some((e) => e.type === "text")).toBe(true);
  });
});
