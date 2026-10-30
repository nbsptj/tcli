import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { McpManager } from "../src/mcp/manager.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { cleanup, makeContext, makeRepo, testConfig, testLogger, tempDir } from "./helpers.ts";

const STDIO_SERVER = `
let buffer = "";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: true } },
      { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a","b"] } }
    ] } });
    return;
  }
  if (msg.method === "tools/call") {
    const args = msg.params && msg.params.arguments || {};
    if (msg.params.name === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + args.text }] } });
    } else if (msg.params.name === "fail") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] } });
    }
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (err) { process.stderr.write("bad json: " + err.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("MCP stdio", () => {
  test("initializes, discovers tools, validates schemas and calls tools", async () => {
    const repo = makeRepo({});
    const script = path.join(tempDir("tcli-mcp-"), "server.js");
    fs.writeFileSync(script, STDIO_SERVER);
    try {
      const config = testConfig({
        mcpServers: {
          fake: {
            enabled: true,
            command: process.execPath,
            args: [script],
            timeoutMs: 8000,
          },
        },
      });
      const manager = new McpManager({ config, workspace: repo, logger: testLogger() });
      const result = await manager.load();
      try {
        expect(result.warnings).toEqual([]);
        expect(result.tools.length).toBe(2);
        expect(result.clients).toBe(1);
        const echo = result.tools.find((t) => t.name === "mcp__fake__echo")!;
        expect(echo).toBeDefined();
        expect(echo.kind).toBe("read");
        const registry = new ToolRegistry();
        registry.register(echo);
        expect(registry.validate(echo.name, {}).ok).toBe(false);
        const valid = registry.validate(echo.name, { text: "hi" });
        expect(valid.ok).toBe(true);
        if (valid.ok) {
          const ctx = makeContext(repo, config);
          const output = await valid.tool.execute(valid.value, ctx);
          expect(output.content).toBe("echo:hi");
          expect(output.isError).toBeFalsy();
        }
        const add = result.tools.find((t) => t.name === "mcp__fake__add")!;
        const addValid = registry.validate(add.name, { a: 2, b: 3 });
        if (addValid.ok) {
          const ctx = makeContext(repo, config);
          const output = await addValid.tool.execute(addValid.value, ctx);
          expect(output.content).toBe("5");
        }
      } finally {
        await manager.close();
      }
    } finally {
      cleanup(repo);
      cleanup(path.dirname(script));
    }
  }, 20_000);

  test("reports connection failures as warnings", async () => {
    const repo = makeRepo({});
    try {
      const config = testConfig({
        mcpServers: {
          broken: { enabled: true, command: "/definitely/not/a/binary", timeoutMs: 1000 },
        },
      });
      const manager = new McpManager({ config, workspace: repo, logger: testLogger() });
      const result = await manager.load();
      expect(result.tools).toEqual([]);
      expect(result.warnings.length).toBe(1);
      await manager.close();
    } finally {
      cleanup(repo);
    }
  });
});

describe("MCP streamable HTTP", () => {
  test("initializes and calls a tool over HTTP", async () => {
    const repo = makeRepo({});
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        const body = (await req.json()) as { id?: number; method?: string; params?: unknown };
        if (!body.id) return new Response(null, { status: 202 });
        const respond = (result: unknown) =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
          });
        if (body.method === "initialize") {
          return respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http" } });
        }
        if (body.method === "tools/list") {
          return respond({
            tools: [
              {
                name: "lookup",
                description: "Lookup",
                inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
              },
            ],
          });
        }
        if (body.method === "tools/call") {
          return respond({ content: [{ type: "text", text: "result for " + (body.params as { arguments: { q: string } }).arguments.q }] });
        }
        return respond({});
      },
    });
    try {
      const config = testConfig({
        mcpServers: {
          http: {
            enabled: true,
            url: `http://127.0.0.1:${server.port}/mcp`,
            transport: "http",
            timeoutMs: 5000,
          },
        },
      });
      const manager = new McpManager({ config, workspace: repo, logger: testLogger() });
      const result = await manager.load();
      try {
        expect(result.warnings).toEqual([]);
        expect(result.tools.length).toBe(1);
        const registry = new ToolRegistry();
        registry.register(result.tools[0]!);
        const valid = registry.validate("mcp__http__lookup", { q: "hello" });
        expect(valid.ok).toBe(true);
        if (valid.ok) {
          const output = await valid.tool.execute(valid.value, makeContext(repo, config));
          expect(output.content).toBe("result for hello");
        }
      } finally {
        await manager.close();
      }
    } finally {
      server.stop(true);
      cleanup(repo);
    }
  });
});
