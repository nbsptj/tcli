import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigSchema, type Config } from "../src/config/schema.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { deepMerge } from "../src/config/merge.ts";
import { Logger } from "../src/log/logger.ts";
import { SnapshotStore } from "../src/context/snapshots.ts";
import { CheckpointStore } from "../src/context/checkpoint.ts";
import { TodoStore } from "../src/tools/todo-store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext, ToolDefinition, AnyToolDefinition } from "../src/tools/types.ts";
import { PermissionEngine } from "../src/permissions/engine.ts";
import { AuditLog } from "../src/permissions/audit.ts";
import { SessionStore } from "../src/session/store.ts";
import { Agent } from "../src/agent/agent.ts";
import { createProvider } from "../src/providers/index.ts";
import type { Provider, ProviderRequest, StreamEvent } from "../src/providers/types.ts";
import type { ResolvedProvider } from "../src/config/load.ts";
import type { ChatMessage } from "../src/types.ts";
import type { Asker } from "../src/permissions/types.ts";
import { getRepoOverview } from "../src/context/overview.ts";
import { loadInstructions } from "../src/context/instructions.ts";

export const ROOT = path.resolve(import.meta.dir, "..");

export function tempDir(prefix = "tcli-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

export function makeRepo(files: Record<string, string> = {}): string {
  const dir = tempDir("tcli-repo-");
  writeFiles(dir, files);
  return dir;
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(deepMerge(structuredClone(DEFAULT_CONFIG), overrides));
}

export function testLogger(): Logger {
  return new Logger({ dir: false, console: "off", level: "error" });
}

export function makeContext(
  cwd: string,
  config: Config,
  opts: { sessionId?: string; signal?: AbortSignal; hooks?: Partial<ToolContext> } = {},
): ToolContext {
  const sessionId = opts.sessionId ?? `test-${randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(cwd, ".tcli", "sessions", sessionId);
  const logger = testLogger();
  return {
    cwd,
    config,
    logger,
    signal: opts.signal ?? new AbortController().signal,
    snapshots: new SnapshotStore(),
    checkpoints: new CheckpointStore(sessionDir),
    todo: new TodoStore(),
    sessionId,
    traceId: "trace_test",
    ...opts.hooks,
  };
}

export function makePermissions(
  cwd: string,
  config: Config,
  asker?: Asker,
  opts: { yes?: boolean; auditDir?: string } = {},
): PermissionEngine {
  const logger = testLogger();
  const audit = new AuditLog({
    enabled: false,
    dir: opts.auditDir,
    logger,
    traceId: "trace_test",
    sessionId: "test-session",
  });
  const engine = new PermissionEngine({
    permissions: config.permissions,
    workspace: cwd,
    audit,
    logger,
  });
  if (asker) engine.setAsker(asker);
  if (opts.yes) engine.setYesMode(true);
  return engine;
}

/** Scripted provider: each model call consumes one script. */
export class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly type = "mock";
  readonly model = "fake-model";
  readonly requests: ProviderRequest[] = [];
  private readonly scripts: StreamEvent[][];

  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.requests.push(req);
    const script = this.scripts.shift();
    if (!script) {
      yield { type: "text", text: "(scripted provider exhausted)" };
      yield { type: "stop", reason: "end" };
      return;
    }
    for (const event of script) {
      if (event.type === "text" && req.signal.aborted) return;
      yield event;
    }
  }
}

export function resolvedFor(provider: Provider, config: Config): ResolvedProvider {
  return {
    name: provider.id,
    type: "mock",
    model: provider.model,
    baseUrl: "mock://",
    timeoutMs: 5000,
    maxTokens: 1024,
    temperature: 0,
    contextWindow: config.context.window,
    raw: { type: "mock" },
  };
}

export interface AgentHarness {
  agent: Agent;
  dir: string;
  session: SessionStore;
  permissions: PermissionEngine;
  registry: ToolRegistry;
  provider: ScriptedProvider;
  snapshots: SnapshotStore;
  checkpoints: CheckpointStore;
  todo: TodoStore;
  asker: Asker | undefined;
}

export function createAgentHarness(opts: {
  scripts: StreamEvent[][];
  files?: Record<string, string>;
  tools?: AnyToolDefinition[];
  config?: Config;
  asker?: Asker;
  autoSave?: boolean;
  initialMessages?: ChatMessage[];
  maxSteps?: number;
  yes?: boolean;
}): AgentHarness {
  const dir = makeRepo(opts.files ?? {});
  const config = opts.config ?? testConfig();
  const provider = new ScriptedProvider(opts.scripts);
  const logger = testLogger();
  const registry = new ToolRegistry();
  for (const tool of opts.tools ?? []) registry.register(tool as ToolDefinition<never>);
  const permissions = makePermissions(dir, config, opts.asker, { yes: opts.yes });
  const session = SessionStore.create({
    cwd: dir,
    provider: provider.id,
    model: provider.model,
    traceId: "trace_test",
    autoSave: opts.autoSave ?? false,
  });
  const snapshots = new SnapshotStore();
  const checkpoints = new CheckpointStore(session.dir);
  const todo = new TodoStore();
  const agent = new Agent({
    workspace: dir,
    config,
    provider,
    resolved: resolvedFor(provider, config),
    tools: registry,
    permissions,
    logger,
    snapshots,
    checkpoints,
    todo,
    session,
    initialMessages: opts.initialMessages,
    overview: getRepoOverview(dir, config),
    instructions: loadInstructions(dir, config),
    maxSteps: opts.maxSteps,
    verbose: false,
    traceId: "trace_test",
    sessionId: session.id,
  });
  return { agent, dir, session, permissions, registry, provider, snapshots, checkpoints, todo, asker: opts.asker };
}

export async function collect(
  agent: Agent,
  prompt: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ events: import("../src/agent/events.ts").AgentEvent[]; result: import("../src/agent/events.ts").AgentRunResult }> {
  const events: import("../src/agent/events.ts").AgentEvent[] = [];
  const iterator = agent.run(prompt, opts);
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }
  return { events, result: next.value };
}

export async function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; home?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = opts.home ?? tempDir("tcli-home-");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TCLI_HOME: home,
    ...(opts.env ?? {}),
  };
  const proc = Bun.spawn({
    cmd: [process.execPath, path.join(ROOT, "src", "cli.ts"), ...args],
    cwd: opts.cwd ?? ROOT,
    env,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export interface FakeCompletion {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finish?: "stop" | "tool_calls" | "length";
  usage?: { input: number; output: number; cached?: number };
}

export interface FakeOpenAi {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close: () => void;
}

export function startFakeOpenAi(responses: FakeCompletion[]): FakeOpenAi {
  const requests: Array<Record<string, unknown>> = [];
  let index = 0;
  const encoder = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      const response = responses[Math.min(index++, responses.length - 1)] ?? { text: "done" };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          send({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          if (response.text) {
            for (let i = 0; i < response.text.length; i += 17) {
              send({ choices: [{ index: 0, delta: { content: response.text.slice(i, i + 17) }, finish_reason: null }] });
            }
          }
          for (const [toolIndex, tool] of (response.toolCalls ?? []).entries()) {
            const id = `call_${toolIndex}`;
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: toolIndex, id, type: "function", function: { name: tool.name, arguments: "" } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
            const args = JSON.stringify(tool.arguments);
            for (let i = 0; i < args.length; i += 9) {
              send({
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: toolIndex, function: { arguments: args.slice(i, i + 9) } }] },
                    finish_reason: null,
                  },
                ],
              });
            }
          }
          const finish =
            response.finish ?? (response.toolCalls?.length ? "tool_calls" : response.text && response.text.length > 0 ? "stop" : "stop");
          send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
          const usage = response.usage ?? { input: 20, output: 10 };
          send({
            choices: [],
            usage: {
              prompt_tokens: usage.input,
              completion_tokens: usage.output,
              prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
            },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    close: () => server.stop(true),
  };
}

export function streamEvents(events: import("../src/providers/types.ts").StreamEvent[]): ScriptedProvider {
  return new ScriptedProvider([events]);
}

export { createProvider };
