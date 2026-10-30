import type { Config } from "../config/schema.ts";
import type { ResolvedProvider } from "../config/load.ts";
import type { Logger } from "../log/logger.ts";
import type { Provider, ProviderDebugEvent } from "../providers/types.ts";
import { streamWithRetry } from "../providers/http.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type {
  AnyToolDefinition,
  SubagentRequest,
  SubagentResult,
  ToolContext,
  ToolDisplay,
  ToolPermissionInfo,
  ToolResult,
} from "../tools/types.ts";
import { TodoStore } from "../tools/todo-store.ts";
import type { SnapshotStore } from "../context/snapshots.ts";
import type { CheckpointStore } from "../context/checkpoint.ts";
import { classifySensitivePath } from "../permissions/sensitive.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import type { PermissionRequest, Decision } from "../permissions/types.ts";
import { describeRuleSuggestion } from "../permissions/policy.ts";
import type { SessionStore } from "../session/store.ts";
import type { LoadedSession } from "../session/types.ts";
import type { ChatMessage, StopReason, TodoItem, ToolCall, ToolInvocation, ToolOutcome, Usage } from "../types.ts";
import { addUsage, emptyUsage, totalTokens } from "../types.ts";
import { isWithinWorkspace, displayPath } from "../utils/paths.ts";
import { describeError, asError } from "../utils/errors.ts";
import { truncateOutput } from "../utils/truncate.ts";
import { truncateText } from "../utils/strings.ts";
import { redactSecrets } from "../utils/redact.ts";
import { estimateCost, estimateTokens, estimateMessagesTokens, priceFor } from "../utils/tokens.ts";
import { compactMessages, countMessageTokens } from "../context/compression.ts";
import { expandReferences } from "../context/references.ts";
import { getRepoOverview, type RepoOverview } from "../context/overview.ts";
import { loadInstructions, type InstructionsResult } from "../context/instructions.ts";
import { buildSummaryPrompt, buildSystemPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompts.ts";
import type { HookRunner } from "./hooks.ts";
import type { AgentEvent, AgentRunResult } from "./events.ts";

export interface AgentOptions {
  workspace: string;
  config: Config;
  provider: Provider;
  resolved: ResolvedProvider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  logger: Logger;
  snapshots: SnapshotStore;
  checkpoints: CheckpointStore;
  todo: TodoStore;
  session?: SessionStore;
  hooks?: HookRunner;
  initialMessages?: ChatMessage[];
  initialUsage?: Usage;
  overview?: RepoOverview;
  instructions?: InstructionsResult;
  depth?: number;
  isSubagent?: boolean;
  maxSteps?: number;
  verbose?: boolean;
  traceId?: string;
  sessionId?: string;
  systemPromptExtra?: string;
}

interface ModelTurn {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  aborted: boolean;
  error?: Error;
}

interface PreparedCall {
  call: ToolCall;
  tool?: AnyToolDefinition;
  input: Record<string, unknown>;
  invocation: ToolInvocation;
  request?: PermissionRequest;
  ready: boolean;
  blockedReason?: string;
  denied?: boolean;
}

interface ExecutedCall {
  prepared: PreparedCall;
  result: ToolResult;
  durationMs: number;
}

interface ToolQueues {
  todos: TodoItem[][];
  progress: string[];
}

const MAX_TOOL_CONCURRENCY = 4;

function clampDisplay(display: ToolDisplay | undefined): ToolDisplay | undefined {
  if (!display) return undefined;
  return {
    summary: display.summary ? truncateText(display.summary, 300) : undefined,
    diff: display.diff ? truncateText(display.diff, 30_000) : undefined,
    text: display.text ? truncateText(display.text, 20_000) : undefined,
  };
}

function formatDebug(event: ProviderDebugEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (event.kind === "request" && data) {
    return `→ ${String(data.provider ?? "provider")} ${String(data.url ?? "")}\n${truncateText(
      JSON.stringify(data.body ?? data, null, 2),
      8000,
    )}`;
  }
  if (event.kind === "response" && data) {
    return `← ${String(data.provider ?? "provider")} ${String(data.status ?? "")} ${String(data.url ?? "")}`;
  }
  return `← ${truncateText(JSON.stringify(event.data), 2000)}`;
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Provider-agnostic agent loop (AG-1):
 * model → tool calls → results fed back → repeat until no tool calls.
 *
 * Read-only tool calls run concurrently (in contiguous groups, preserving order
 * relative to writes), while write/exec calls run serially. Permissions are
 * requested before any execution, in call order.
 */
export class Agent {
  private readonly workspace: string;
  private readonly config: Config;
  private provider: Provider;
  private resolved: ResolvedProvider;
  private readonly tools: ToolRegistry;
  private readonly permissions: PermissionEngine;
  private readonly logger: Logger;
  private readonly session?: SessionStore;
  private readonly hooks?: HookRunner;
  private readonly snapshots: SnapshotStore;
  private readonly checkpoints: CheckpointStore;
  private readonly todo: TodoStore;
  private readonly verbose: boolean;
  private readonly depth: number;
  private readonly maxSteps: number;
  private readonly overview: RepoOverview;
  private readonly instructions: InstructionsResult;
  private readonly traceId: string;
  private readonly fallbackSessionId: string;
  private readonly systemPromptExtra?: string;
  private systemPrompt: string;
  private messages: ChatMessage[] = [];
  private totalUsage: Usage;
  private currentAbort?: AbortController;
  private running = false;
  private cancelled = false;
  private timedOut = false;

  constructor(opts: AgentOptions) {
    this.workspace = opts.workspace;
    this.config = opts.config;
    this.provider = opts.provider;
    this.resolved = opts.resolved;
    this.tools = opts.tools;
    this.permissions = opts.permissions;
    this.logger = opts.logger;
    this.session = opts.session;
    this.hooks = opts.hooks;
    this.snapshots = opts.snapshots;
    this.checkpoints = opts.checkpoints;
    this.todo = opts.todo;
    this.verbose = opts.verbose ?? opts.config.logging.level === "debug";
    this.depth = opts.depth ?? 0;
    this.maxSteps = opts.maxSteps ?? opts.config.maxSteps;
    this.traceId = opts.traceId ?? opts.session?.meta.traceId ?? "trace_unknown";
    this.fallbackSessionId = opts.sessionId ?? opts.session?.id ?? "no-session";
    this.systemPromptExtra = opts.systemPromptExtra;
    this.messages = (opts.initialMessages ?? []).map((m) => ({ ...m }));
    this.totalUsage = { ...(opts.initialUsage ?? opts.session?.usageTotal ?? emptyUsage()) };
    this.overview =
      opts.overview ??
      getRepoOverview(this.workspace, this.config);
    this.instructions = opts.instructions ?? loadInstructions(this.workspace, this.config);
    this.systemPrompt = this.buildPrompt();
  }

  private buildPrompt(): string {
    const base = buildSystemPrompt({
      cwd: this.workspace,
      config: this.config,
      provider: this.resolved.name,
      model: this.resolved.model,
      overview: this.overview,
      instructions: this.instructions,
      isSubagent: this.depth > 0,
    });
    return this.systemPromptExtra ? `${base}\n\n## Delegation\n${this.systemPromptExtra}` : base;
  }

  get model(): string {
    return this.resolved.model;
  }

  get providerName(): string {
    return this.resolved.name;
  }

  get usage(): Usage {
    return { ...this.totalUsage };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get contextWindow(): number {
    return this.resolved.contextWindow;
  }

  getMessages(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  getSnapshots(): SnapshotStore {
    return this.snapshots;
  }

  getCheckpoints(): CheckpointStore {
    return this.checkpoints;
  }

  usageCostUsd(): number | undefined {
    return this.costUsd();
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setProvider(provider: Provider, resolved: ResolvedProvider): void {
    this.provider = provider;
    this.resolved = resolved;
    this.systemPrompt = this.buildPrompt();
    this.session?.recordNote(`Model switched to ${resolved.name}/${resolved.model}`);
  }

  /** Interrupt the current generation and kill tool subprocess trees. */
  cancel(): void {
    this.cancelled = true;
    this.currentAbort?.abort();
  }

  private sessionId(): string {
    return this.session?.id ?? this.fallbackSessionId;
  }

  private costUsd(): number | undefined {
    return estimateCost(
      {
        inputTokens: this.totalUsage.inputTokens,
        outputTokens: this.totalUsage.outputTokens,
        cacheReadTokens: this.totalUsage.cacheReadTokens,
      },
      priceFor(this.resolved.model, this.resolved.price),
    );
  }

  private systemMessage(): ChatMessage {
    return { role: "system", content: this.systemPrompt };
  }

  private appendMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.session?.appendMessage(message);
  }

  private recordUsage(usage: Usage): void {
    this.totalUsage = addUsage(this.totalUsage, usage);
    this.session?.recordUsage(usage, this.resolved.model);
  }

  private usageEvent(usage: Usage): AgentEvent {
    return { type: "usage", usage, total: { ...this.totalUsage }, costUsd: this.costUsd() };
  }

  private recentFiles(): string[] {
    const files = this.snapshots
      .all()
      .sort((a, b) => b.readAt.localeCompare(a.readAt))
      .slice(-20)
      .map((s) => displayPath(s.path, this.workspace));
    return [...new Set(files)];
  }

  async *run(input: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<AgentEvent, AgentRunResult> {
    if (this.running) throw new Error("Agent is already running");
    this.running = true;
    this.cancelled = false;
    this.timedOut = false;
    const controller = new AbortController();
    this.currentAbort = controller;
    const onParentAbort = () => {
      this.cancelled = true;
      controller.abort();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onParentAbort();
      else opts.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (this.config.agent.timeoutMs > 0) {
      timeout = setTimeout(() => {
        this.timedOut = true;
        controller.abort();
      }, this.config.agent.timeoutMs);
    }
    const startedAt = performance.now();
    const expanded = expandReferences(input, { cwd: this.workspace, config: this.config });
    for (const warning of expanded.warnings) {
      yield { type: "notice", level: "warn", text: warning };
    }
    this.session?.ensureTitle(input, this.config.session.titleMaxLength);
    const userMessage: ChatMessage = {
      role: "user",
      content: expanded.text,
      at: new Date().toISOString(),
    };
    this.appendMessage(userMessage);

    let steps = 0;
    let lastText = "";
    let reason: StopReason = "end";
    const signal = controller.signal;

    try {
      for (;;) {
        if (steps >= this.maxSteps) {
          yield {
            type: "notice",
            level: "warn",
            text: `Reached the maximum of ${this.maxSteps} steps. Stopping; the task may be incomplete.`,
          };
          reason = "budget";
          break;
        }
        if (signal.aborted) {
          reason = "aborted";
          break;
        }

        yield* this.maybeCompact(signal);
        if (signal.aborted) {
          reason = "aborted";
          break;
        }

        steps++;
        yield { type: "step_start", step: steps };
        const turn = yield* this.callModel(signal);
        if (turn.text) lastText = turn.text;

        if (turn.error) {
          reason = "error";
          break;
        }
        if (turn.aborted) {
          reason = "aborted";
          break;
        }

        const budgetReason = this.checkBudget();
        if (budgetReason) {
          if (turn.toolCalls.length) {
            yield* this.appendSyntheticToolResults(turn.toolCalls, `Not executed: ${budgetReason}`);
          }
          yield { type: "notice", level: "warn", text: budgetReason };
          reason = "budget";
          break;
        }

        if (!turn.toolCalls.length) {
          if (turn.stopReason === "max_tokens") {
            yield {
              type: "notice",
              level: "warn",
              text: "The model hit its output token limit; the response may be incomplete.",
            };
            reason = "max_tokens";
          } else if (turn.stopReason === "refusal") {
            yield { type: "notice", level: "warn", text: "The model refused to continue." };
            reason = "refusal";
          } else {
            reason = "end";
          }
          break;
        }

        const executed = yield* this.executeToolCalls(turn.toolCalls, signal);
        if (executed.aborted) {
          reason = "aborted";
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        reason = "aborted";
      } else {
        reason = "error";
        yield { type: "error", message: describeError(err) };
      }
      this.logger.exception(err, "agent loop failed", { sessionId: this.sessionId() });
    } finally {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onParentAbort);
      this.currentAbort = undefined;
      this.running = false;
    }

    if (this.timedOut) {
      yield {
        type: "notice",
        level: "warn",
        text: `Agent timed out after ${Math.round(performance.now() - startedAt)}ms (limit ${this.config.agent.timeoutMs}ms).`,
      };
    } else if (this.cancelled && reason === "aborted") {
      yield { type: "notice", level: "info", text: "Interrupted by user. The session can continue." };
    }

    yield { type: "turn_end", reason, steps };
    yield { type: "done", reason, text: lastText };
    return { reason, text: lastText, usage: { ...this.totalUsage }, costUsd: this.costUsd() };
  }

  private checkBudget(): string | undefined {
    const maxTokens = this.config.agent.budget.maxTokens;
    if (maxTokens > 0 && totalTokens(this.totalUsage) >= maxTokens) {
      return `Token budget reached (${totalTokens(this.totalUsage)}/${maxTokens} tokens).`;
    }
    const maxCost = this.config.agent.budget.maxCostUsd;
    const cost = this.costUsd();
    if (maxCost > 0 && cost !== undefined && cost >= maxCost) {
      return `Cost budget reached ($${cost.toFixed(4)}/$${maxCost.toFixed(2)}).`;
    }
    return undefined;
  }

  private async *maybeCompact(signal: AbortSignal): AsyncGenerator<AgentEvent, void> {
    const budget = Math.max(1000, Math.floor(this.resolved.contextWindow * this.config.context.compactAt));
    const full = [this.systemMessage(), ...this.messages];
    const before = countMessageTokens(full);
    if (before <= budget) return;
    yield {
      type: "notice",
      level: "info",
      text: `Context is ~${before} tokens (budget ${budget}); compacting earlier turns…`,
    };
    const result = await compactMessages({
      messages: full,
      keepRecentTurns: this.config.context.keepRecentTurns,
      budgetTokens: budget,
      summarize: (transcript, sig) => this.summarize(transcript, sig),
      signal,
      recentFiles: this.recentFiles(),
      force: true,
      preserveSystemCount: 1,
    });
    if (!result.compacted) return;
    this.messages = result.messages.slice(1);
    this.session?.recordCompaction(
      result.summary ?? "",
      result.keptMessages,
      result.beforeTokens,
      result.afterTokens,
    );
    yield {
      type: "compaction",
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      summary: result.summary ?? "",
    };
    yield this.usageEvent(emptyUsage());
  }

  private async summarize(transcript: string, signal: AbortSignal): Promise<string> {
    let text = "";
    let usage = emptyUsage();
    const request = {
      messages: [
        { role: "system" as const, content: SUMMARY_SYSTEM_PROMPT },
        { role: "user" as const, content: buildSummaryPrompt(transcript) },
      ],
      tools: [],
      temperature: 0,
      maxTokens: Math.min(1600, this.resolved.maxTokens),
      signal,
      onDebug: this.verbose
        ? (event: ProviderDebugEvent) => this.logger.debug("summarizer provider", { event: event.kind })
        : undefined,
    };
    for await (const event of streamWithRetry(this.provider, request, { maxRetries: 1 })) {
      if (event.type === "text") text += event.text;
      else if (event.type === "usage") usage = addUsage(usage, event.usage);
      else if (event.type === "error") throw event.error;
    }
    if (usage.inputTokens || usage.outputTokens) this.recordUsage(usage);
    return text;
  }

  private async *callModel(signal: AbortSignal): AsyncGenerator<AgentEvent, ModelTurn> {
    let text = "";
    let reasoning = "";
    let stopReason: StopReason = "end";
    let usage = emptyUsage();
    let failure: Error | undefined;
    let aborted = false;
    const calls: ToolCall[] = [];
    const debugQueue: string[] = [];
    const onDebug = this.verbose
      ? (event: ProviderDebugEvent) => {
          debugQueue.push(formatDebug(event));
        }
      : undefined;
    const requestMessages = [this.systemMessage(), ...this.messages];
    const tools = this.tools.schemas();
    const request = {
      messages: requestMessages,
      tools,
      temperature: this.resolved.temperature,
      maxTokens: this.resolved.maxTokens,
      signal,
      onDebug,
    };
    try {
      for await (const event of streamWithRetry(this.provider, request, { maxRetries: 3, onDebug })) {
        while (debugQueue.length) {
          yield { type: "debug", text: debugQueue.shift()! };
        }
        if (signal.aborted) {
          aborted = true;
          break;
        }
        switch (event.type) {
          case "text":
            text += event.text;
            yield { type: "text", text: event.text };
            break;
          case "reasoning":
            reasoning += event.text;
            yield { type: "reasoning", text: event.text };
            break;
          case "tool_call":
            calls.push(event.toolCall);
            break;
          case "usage":
            usage = addUsage(usage, event.usage);
            break;
          case "retry":
            yield event;
            break;
          case "stop":
            stopReason = event.reason;
            break;
          case "error":
            failure = event.error;
            break;
          default:
            break;
        }
        if (failure) break;
      }
    } catch (err) {
      failure = asError(err);
    }
    while (debugQueue.length) yield { type: "debug", text: debugQueue.shift()! };

    if (signal.aborted) aborted = true;
    if (usage.inputTokens === 0 && usage.outputTokens === 0) {
      usage = {
        ...usage,
        inputTokens: estimateMessagesTokens(requestMessages) + Math.ceil(JSON.stringify(tools).length / 4),
        outputTokens: estimateTokens(text + reasoning),
      };
    }
    this.recordUsage(usage);
    const estimate = this.usageEvent(usage);

    if (aborted) {
      if (text || reasoning) {
        this.appendAssistantMessage(text, reasoning, []);
      }
      yield estimate;
      return { text, reasoning, toolCalls: [], usage, stopReason: "aborted", aborted: true };
    }
    if (failure) {
      const message = describeError(failure);
      yield { type: "error", message };
      if (text || reasoning) this.appendAssistantMessage(text, reasoning, []);
      yield estimate;
      return { text, reasoning, toolCalls: [], usage, stopReason: "error", aborted: false, error: failure };
    }

    const toolCalls = this.normalizeToolCalls(calls);
    if (toolCalls.length && stopReason === "end") stopReason = "tool_use";
    if (text || reasoning || toolCalls.length) {
      this.appendAssistantMessage(text, reasoning, toolCalls);
    }
    yield estimate;
    return { text, reasoning, toolCalls, usage, stopReason, aborted: false };
  }

  private appendAssistantMessage(text: string, reasoning: string, toolCalls: ToolCall[]): void {
    const message: ChatMessage = {
      role: "assistant",
      content: text,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      at: new Date().toISOString(),
    };
    this.appendMessage(message);
  }

  private normalizeToolCalls(calls: ToolCall[]): ToolCall[] {
    const used = new Set<string>();
    for (const message of this.messages) {
      for (const call of message.toolCalls ?? []) used.add(call.id);
    }
    const out: ToolCall[] = [];
    for (const [index, call] of calls.entries()) {
      if (!call.name) continue;
      let id = call.id;
      if (!id || used.has(id)) id = `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`;
      used.add(id);
      out.push({
        id,
        name: call.name,
        arguments:
          call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
            ? call.arguments
            : {},
      });
    }
    return out;
  }

  private makeToolContext(signal: AbortSignal, queues: ToolQueues): ToolContext {
    return {
      cwd: this.workspace,
      config: this.config,
      logger: this.logger,
      signal,
      snapshots: this.snapshots,
      checkpoints: this.checkpoints,
      todo: this.todo,
      sessionId: this.sessionId(),
      traceId: this.traceId,
      onTodo: (todos) => queues.todos.push(todos),
      onProgress: (text) => queues.progress.push(text),
      spawnSubagent: (req) => this.spawnSubagent(req, signal),
    };
  }

  private async preparePermission(
    tool: AnyToolDefinition,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ request: PermissionRequest; preview?: string }> {
    const info = (await (tool.permissionInfo as unknown as (
      i: Record<string, unknown>,
      c: ToolContext,
    ) => ToolPermissionInfo | Promise<ToolPermissionInfo>)(input, ctx)) ?? { paths: [] };
    const paths = info.paths ?? [];
    const reasons = [...(info.sensitiveReasons ?? [])];
    let sensitive = info.sensitive ?? false;
    for (const p of paths) {
      const classification = classifySensitivePath(p, this.workspace, this.config.permissions.sensitivePatterns);
      if (classification.sensitive) {
        sensitive = true;
        reasons.push(...classification.reasons);
      }
    }
    const outsideWorkspace = paths.some((p) => !isWithinWorkspace(this.workspace, p));
    let preview: string | undefined;
    if (tool.preview) {
      try {
        preview = await (tool.preview as unknown as (
          i: Record<string, unknown>,
          c: ToolContext,
        ) => string | Promise<string>)(input, ctx);
      } catch (err) {
        preview = `(preview unavailable: ${(err as Error).message})`;
      }
    }
    const request: PermissionRequest = {
      tool: tool.name,
      kind: tool.kind,
      input,
      command: info.command,
      paths,
      outsideWorkspace,
      sensitive,
      sensitiveReasons: reasons,
      preview: preview ? truncateText(preview, 20_000) : undefined,
    };
    return { request, preview };
  }

  private async *executeToolCalls(
    calls: ToolCall[],
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { aborted: boolean }> {
    const queues: ToolQueues = { todos: [], progress: [] };
    const ctx = this.makeToolContext(signal, queues);
    const prepared: PreparedCall[] = [];

    for (const call of calls) {
      const validation = this.tools.validate(call.name, call.arguments);
      if (!validation.ok) {
        const invocation: ToolInvocation = { id: call.id, name: call.name, input: call.arguments, kind: "read" };
        yield { type: "tool_start", invocation };
        prepared.push({
          call,
          input: call.arguments,
          invocation,
          ready: false,
          blockedReason: validation.error,
        });
        continue;
      }
      const tool = validation.tool;
      let input = validation.value;
      let invocation: ToolInvocation = { id: call.id, name: call.name, input, kind: tool.kind };
      let preview: string | undefined;
      if (tool.preview) {
        try {
          preview = await (tool.preview as unknown as (
            i: Record<string, unknown>,
            c: ToolContext,
          ) => string | Promise<string>)(input, ctx);
        } catch (err) {
          preview = `(preview unavailable: ${(err as Error).message})`;
        }
      }
      yield { type: "tool_start", invocation, preview: preview ? truncateText(preview, 20_000) : undefined };

      if (signal.aborted) {
        prepared.push({
          call,
          tool,
          input,
          invocation,
          ready: false,
          blockedReason: "Interrupted by user before execution.",
        });
        continue;
      }

      let hookAsk = false;
      if (this.hooks) {
        const hook = await this.hooks.preTool(tool.name, input, signal);
        if (hook.input) {
          const revalidated = this.tools.validate(tool.name, hook.input);
          if (!revalidated.ok) {
            prepared.push({
              call,
              tool,
              input,
              invocation,
              ready: false,
              blockedReason: `Hook provided invalid arguments: ${revalidated.error}`,
            });
            continue;
          }
          input = revalidated.value;
          invocation = { ...invocation, input };
        }
        if (hook.decision === "deny") {
          prepared.push({
            call,
            tool,
            input,
            invocation,
            ready: false,
            denied: true,
            blockedReason: `Blocked by preToolUse hook: ${hook.reason ?? "denied"}`,
          });
          continue;
        }
        if (hook.decision === "ask") hookAsk = true;
      }

      let request: PermissionRequest;
      try {
        const preparedPermission = await this.preparePermission(tool, input, ctx);
        request = preparedPermission.request;
      } catch (err) {
        prepared.push({
          call,
          tool,
          input,
          invocation,
          ready: false,
          blockedReason: `Failed to prepare permission request: ${(err as Error).message}`,
        });
        continue;
      }

      const initialDecision = this.permissions.decide(request);
      const auth = await this.permissions.authorize(request, {
        sessionId: this.sessionId(),
        signal,
        forceAsk: hookAsk,
      });
      if (
        initialDecision.action !== "allow" ||
        !auth.allowed ||
        auth.approvedBy !== "policy" ||
        hookAsk
      ) {
        yield {
          type: "permission",
          tool: tool.name,
          decision: auth.decision.action,
          allowed: auth.allowed,
          approvedBy: auth.approvedBy,
          reason: auth.decision.reason,
        };
      }
      if (auth.editedInput) {
        const revalidated = this.tools.validate(tool.name, auth.editedInput);
        if (!revalidated.ok) {
          prepared.push({
            call,
            tool,
            input,
            invocation,
            request,
            ready: false,
            blockedReason: `Edited arguments are invalid: ${revalidated.error}`,
          });
          continue;
        }
        input = revalidated.value;
        invocation = { ...invocation, input };
        request = { ...request, input, command: typeof input.command === "string" ? input.command : request.command };
      }
      if (!auth.allowed) {
        prepared.push({
          call,
          tool,
          input,
          invocation,
          request,
          ready: false,
          denied: true,
          blockedReason: `Permission denied for ${tool.name}: ${auth.decision.reason}. No side effect was performed.\n${describeRuleSuggestion(request)}`,
        });
        continue;
      }
      prepared.push({ call, tool, input, invocation, request, ready: true });
    }

    for (let index = 0; index < prepared.length; ) {
      const item = prepared[index]!;
      if (!item.ready || !item.tool) {
        const result: ToolResult = {
          content: item.blockedReason ?? "Tool was not executed.",
          isError: true,
          display: { summary: item.denied ? "denied" : "not executed" },
        };
        yield* this.finalizeToolResult({ prepared: item, result, durationMs: 0 }, queues);
        index++;
        continue;
      }
      if (signal.aborted) {
        const result: ToolResult = {
          content: "Interrupted by user; the tool was not executed.",
          isError: true,
          display: { summary: "interrupted" },
        };
        yield* this.finalizeToolResult({ prepared: item, result, durationMs: 0 }, queues);
        index++;
        continue;
      }
      if (item.tool.kind === "read") {
        const group: PreparedCall[] = [];
        while (
          index < prepared.length &&
          prepared[index]!.ready &&
          prepared[index]!.tool?.kind === "read" &&
          !signal.aborted
        ) {
          group.push(prepared[index]!);
          index++;
        }
        if (!group.length) {
          // Defensive: avoid an infinite loop if the first item was mutated.
          group.push(item);
          index++;
        }
        const results = await runPool(group, MAX_TOOL_CONCURRENCY, (pc) =>
          this.executeOne(pc, ctx),
        );
        for (const executed of results) {
          yield* this.finalizeToolResult(executed, queues);
        }
      } else {
        const executed = await this.executeOne(item, ctx);
        yield* this.finalizeToolResult(executed, queues);
        index++;
      }
    }

    return { aborted: signal.aborted };
  }

  private async executeOne(prepared: PreparedCall, ctx: ToolContext): Promise<ExecutedCall> {
    const started = performance.now();
    if (!prepared.tool) {
      return {
        prepared,
        result: { content: prepared.blockedReason ?? "Unknown tool", isError: true },
        durationMs: 0,
      };
    }
    try {
      const result = await (prepared.tool.execute as unknown as (
        i: Record<string, unknown>,
        c: ToolContext,
      ) => Promise<ToolResult>)(prepared.input, ctx);
      return {
        prepared,
        result: result ?? { content: "(tool returned no result)", isError: true },
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (ctx.signal.aborted) {
        return {
          prepared,
          result: { content: "Interrupted; the tool was aborted.", isError: true },
          durationMs: Math.round(performance.now() - started),
        };
      }
      this.logger.exception(err, `tool ${prepared.call.name} failed`, {
        sessionId: this.sessionId(),
        tool: prepared.call.name,
      });
      return {
        prepared,
        result: {
          content: `Tool "${prepared.call.name}" failed: ${describeError(err)}`,
          isError: true,
        },
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  private async *finalizeToolResult(
    executed: ExecutedCall,
    queues: ToolQueues,
  ): AsyncGenerator<AgentEvent, void> {
    const { prepared, result, durationMs } = executed;
    const truncated = truncateOutput(result.content || "(no output)", {
      maxLines: this.config.tools.limits.maxLines,
      maxBytes: this.config.tools.limits.maxBytes,
    });
    const content = truncated.text;
    const ok = !result.isError;
    const outcome: ToolOutcome = {
      invocation: prepared.invocation,
      ok,
      content,
      durationMs,
      denied: prepared.denied,
    };
    const message: ChatMessage = {
      role: "tool",
      content,
      toolCallId: prepared.call.id,
      toolName: prepared.call.name,
      isError: !ok,
      at: new Date().toISOString(),
    };
    this.appendMessage(message);
    if (prepared.request) {
      this.permissions.recordOutcome(prepared.request, ok, content.slice(0, 400), durationMs);
    }
    this.logger.debug("tool result", {
      sessionId: this.sessionId(),
      tool: prepared.call.name,
      ok,
      durationMs,
      denied: prepared.denied ?? false,
    });
    if (this.hooks && !prepared.denied && !prepared.blockedReason) {
      try {
        await this.hooks.postTool(
          prepared.call.name,
          prepared.input,
          { ok, summary: result.display?.summary ?? content.slice(0, 400) },
          undefined,
        );
      } catch {
        /* hooks must not break the loop */
      }
    }
    yield {
      type: "tool_result",
      outcome,
      display: clampDisplay(result.display),
    };
    while (queues.todos.length) {
      const todos = queues.todos.shift()!;
      this.session?.recordTodo(todos);
      yield { type: "todo", todos };
    }
    while (queues.progress.length) {
      yield { type: "notice", level: "info", text: queues.progress.shift()! };
    }
  }

  private async *appendSyntheticToolResults(
    calls: ToolCall[],
    reason: string,
  ): AsyncGenerator<AgentEvent, void> {
    for (const call of calls) {
      const validation = this.tools.validate(call.name, call.arguments);
      const invocation: ToolInvocation = {
        id: call.id,
        name: call.name,
        input: call.arguments,
        kind: validation.ok ? validation.tool.kind : "read",
      };
      const content = `Tool call not executed: ${reason}`;
      yield { type: "tool_start", invocation };
      const message: ChatMessage = {
        role: "tool",
        content,
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        at: new Date().toISOString(),
      };
      this.appendMessage(message);
      yield {
        type: "tool_result",
        outcome: {
          invocation,
          ok: false,
          content,
          durationMs: 0,
          denied: true,
        },
        display: { summary: "not executed" },
      };
    }
  }

  private async spawnSubagent(req: SubagentRequest, parentSignal: AbortSignal): Promise<SubagentResult> {
    const maxDepth = this.config.agent.subagents.maxDepth;
    if (this.depth >= maxDepth) {
      return {
        text: `Subagent depth limit reached (${maxDepth}); complete this part of the task directly.`,
        ok: false,
      };
    }
    if (parentSignal.aborted) return { text: "Subagent aborted.", ok: false };
    this.logger.info("subagent start", { sessionId: this.sessionId(), description: req.description });
    const child = new Agent({
      workspace: this.workspace,
      config: this.config,
      provider: this.provider,
      resolved: this.resolved,
      tools: this.tools,
      permissions: this.permissions,
      logger: this.logger,
      snapshots: this.snapshots,
      checkpoints: this.checkpoints,
      todo: new TodoStore(),
      hooks: this.hooks,
      depth: this.depth + 1,
      isSubagent: true,
      maxSteps: Math.min(req.maxSteps ?? this.config.agent.subagents.maxSteps, this.config.agent.subagents.maxSteps),
      initialMessages: [],
      initialUsage: emptyUsage(),
      overview: this.overview,
      instructions: this.instructions,
      verbose: this.verbose,
      traceId: this.traceId,
      sessionId: this.sessionId(),
      systemPromptExtra: `Delegated subtask: ${req.description}\n${req.prompt.slice(0, 1000)}`,
    });
    let text = "";
    let ok = false;
    let toolCalls = 0;
    try {
      for await (const event of child.run(req.prompt, { signal: parentSignal })) {
        if (event.type === "tool_start") toolCalls++;
        if (event.type === "done") {
          text = event.text;
          ok = event.reason === "end";
        }
      }
    } catch (err) {
      this.logger.exception(err, "subagent failed");
      return { text: `Subagent failed: ${describeError(err)}`, ok: false, usage: child.usage, toolCalls };
    }
    this.logger.info("subagent end", { sessionId: this.sessionId(), ok, toolCalls });
    return {
      text: text || "(subagent produced no report)",
      ok,
      usage: child.usage,
      toolCalls,
    };
  }
}

/** Convenience helper for resuming a loaded session into an Agent. */
export function sessionMessages(loaded: LoadedSession): ChatMessage[] {
  return loaded.messages;
}
