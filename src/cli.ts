#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import {
  loadConfig,
  missingApiKeyHint,
  resolveProvider,
  type CliConfigOverrides,
} from "./config/index.ts";
import type { Config } from "./config/schema.ts";
import { ConfigError, TcliError, UsageError, describeError } from "./utils/errors.ts";
import { detectColorMode, type ColorMode } from "./ui/ansi.ts";
import { HeadlessRenderer } from "./ui/headless.ts";
import { createProvider } from "./providers/index.ts";
import { createTerminalAsker, promptLine } from "./ui/prompts.ts";
import { Tui } from "./ui/tui.ts";
import { Logger, writeCrashReport } from "./log/logger.ts";
import { TCLI_VERSION, type Usage } from "./types.ts";
import { formatRelativeTime, truncateText } from "./utils/strings.ts";
import { redactValue } from "./utils/redact.ts";
import { readFileTextSafe } from "./utils/fs.ts";
import { stdinIsTerminal, stdoutIsTerminal } from "./utils/tty.ts";
import {
  auditDir,
  displayPath,
  logsDir,
  projectConfigPath,
  resolveFrom,
  userConfigPath,
} from "./utils/paths.ts";
import { AuditLog } from "./permissions/audit.ts";
import { PermissionEngine } from "./permissions/engine.ts";
import { SnapshotStore } from "./context/snapshots.ts";
import { CheckpointStore } from "./context/checkpoint.ts";
import { loadInstructions } from "./context/instructions.ts";
import { getRepoOverview } from "./context/overview.ts";
import { PathCompleter } from "./context/references.ts";
import { TodoStore } from "./tools/todo-store.ts";
import { createToolRegistry } from "./tools/index.ts";
import type { AnyToolDefinition } from "./tools/types.ts";
import { loadCustomTools } from "./custom/tools.ts";
import { McpManager } from "./mcp/manager.ts";
import { HookRunner } from "./agent/hooks.ts";
import { Agent } from "./agent/agent.ts";
import { listSessions, readSession, SessionStore, deleteSession, sessionToMarkdown, latestSession, generateTraceId } from "./session/index.ts";
import type { LoadedSession } from "./session/types.ts";
import { loadCustomCommands, type CustomCommand } from "./commands/custom.ts";
import { initProject } from "./commands/init.ts";
import { reportTelemetry } from "./telemetry/index.ts";

interface CliArgs {
  prompt: string[];
  help: boolean;
  version: boolean;
  continueSession: boolean;
  resume: boolean;
  resumeId?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  yes: boolean;
  json: boolean;
  streamJson: boolean;
  verbose: boolean;
  color?: "auto" | "always" | "never";
  permissionMode?: "default" | "read-only" | "workspace-write";
  sandbox?: "off" | "read-only" | "workspace";
  cwd?: string;
  interactive: boolean;
  noSave: boolean;
}

const HELP = `tcli ${TCLI_VERSION} — terminal coding agent

Usage:
  tcli [options] [prompt]
  tcli                         start the interactive TUI
  tcli "fix the failing tests" single-shot task, then exit
  cmd | tcli "explain this"    pipe stdin as context
  tcli init                    create project config + AGENTS.md
  tcli config [path|validate]  show/validate merged configuration
  tcli sessions [list]         list saved sessions
  tcli sessions export <id>    export a session to Markdown
  tcli sessions rename <id> <title>  rename a session
  tcli sessions delete <id>    delete a session (requires --yes or prompt)

Options:
  -c, --continue               continue the most recent session
  -r, --resume[=<id>]          resume a session (most recent if no id)
  -m, --model <name>           model name
  -p, --provider <name>        provider from config (default: deepseek)
      --base-url <url>         override provider base URL
      --api-key <key>          override API key (prefer environment variables)
      --max-steps <n>          maximum agent steps (default 40)
      --max-tokens <n>         maximum output tokens per model call
      --temperature <n>        sampling temperature (0-2)
      --permission-mode <m>    default | read-only | workspace-write
      --sandbox <m>            off | read-only | workspace
  -y, --yes                    auto-approve only the configured allowlist
      --json                   final structured JSON result (headless)
      --stream-json            NDJSON event stream (headless)
      --verbose                raw provider/tool diagnostics
      --color <mode>           auto | always | never
      --no-color               disable color
      --interactive            force the TUI (requires a TTY)
      --no-save                do not persist this session
      --cwd <dir>              workspace directory
  -h, --help                   show this help
  -v, --version                print version

Permissions:
  Reads are allowed by default; writes, shell commands and network calls ask.
  Dangerous commands (rm -rf /, sudo, force push, curl | sh, ...) are always
  blocked for the agent. Configure rules in ~/.tcli/config.json or
  .tcli/config.json. Use --yes only with an explicit allowlist.

Environment:
  DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / TCLI_API_KEY
  TCLI_HOME, TCLI_PROVIDER, TCLI_MODEL, TCLI_BASE_URL, TCLI_LOG_LEVEL
`;

function takeValue(argv: string[], index: number, inline: string | undefined, name: string): { value: string; next: number } {
  if (inline !== undefined) return { value: inline, next: index };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new UsageError(`Option ${name} requires a value`);
  return { value, next: index + 1 };
}

function parseNumber(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: [],
    help: false,
    version: false,
    continueSession: false,
    resume: false,
    yes: false,
    json: false,
    streamJson: false,
    verbose: false,
    interactive: false,
    noSave: false,
  };
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (endOfOptions || raw === "-" || !raw.startsWith("-")) {
      args.prompt.push(raw);
      continue;
    }
    if (raw === "--") {
      endOfOptions = true;
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    switch (name) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "-c":
      case "--continue":
        args.continueSession = true;
        break;
      case "-r":
      case "--resume": {
        args.resume = true;
        if (inline) args.resumeId = inline;
        else {
          const next = argv[i + 1];
          if (next && !next.startsWith("-") && /^\d{8}-\d{6}-[A-Za-z0-9]+$/.test(next)) {
            args.resumeId = next;
            i++;
          }
        }
        break;
      }
      case "-m":
      case "--model": {
        const taken = takeValue(argv, i, inline, name);
        args.model = taken.value;
        i = taken.next;
        break;
      }
      case "-p":
      case "--provider": {
        const taken = takeValue(argv, i, inline, name);
        args.provider = taken.value;
        i = taken.next;
        break;
      }
      case "--base-url": {
        const taken = takeValue(argv, i, inline, name);
        args.baseUrl = taken.value;
        i = taken.next;
        break;
      }
      case "--api-key": {
        const taken = takeValue(argv, i, inline, name);
        args.apiKey = taken.value;
        i = taken.next;
        break;
      }
      case "--max-steps": {
        const taken = takeValue(argv, i, inline, name);
        args.maxSteps = Math.round(parseNumber(taken.value, name, 1, 1000));
        i = taken.next;
        break;
      }
      case "--max-tokens": {
        const taken = takeValue(argv, i, inline, name);
        args.maxTokens = Math.round(parseNumber(taken.value, name, 1, 1_000_000));
        i = taken.next;
        break;
      }
      case "--temperature": {
        const taken = takeValue(argv, i, inline, name);
        args.temperature = parseNumber(taken.value, name, 0, 2);
        i = taken.next;
        break;
      }
      case "--permission-mode": {
        const taken = takeValue(argv, i, inline, name);
        if (!["default", "read-only", "workspace-write"].includes(taken.value)) {
          throw new UsageError("--permission-mode must be default|read-only|workspace-write");
        }
        args.permissionMode = taken.value as CliArgs["permissionMode"];
        i = taken.next;
        break;
      }
      case "--sandbox": {
        const taken = takeValue(argv, i, inline, name);
        if (!["off", "read-only", "workspace"].includes(taken.value)) {
          throw new UsageError("--sandbox must be off|read-only|workspace");
        }
        args.sandbox = taken.value as CliArgs["sandbox"];
        i = taken.next;
        break;
      }
      case "--color": {
        const taken = takeValue(argv, i, inline, name);
        if (!["auto", "always", "never"].includes(taken.value)) {
          throw new UsageError("--color must be auto|always|never");
        }
        args.color = taken.value as CliArgs["color"];
        i = taken.next;
        break;
      }
      case "--no-color":
        args.color = "never";
        break;
      case "--cwd": {
        const taken = takeValue(argv, i, inline, name);
        args.cwd = taken.value;
        i = taken.next;
        break;
      }
      case "-y":
      case "--yes":
        args.yes = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--stream-json":
        args.streamJson = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--interactive":
        args.interactive = true;
        break;
      case "--no-save":
        args.noSave = true;
        break;
      default:
        throw new UsageError(`Unknown option: ${raw}`);
    }
  }
  if (args.json && args.streamJson) throw new UsageError("--json and --stream-json are mutually exclusive");
  if (args.continueSession && args.resume) throw new UsageError("--continue and --resume are mutually exclusive");
  return args;
}

function stdinIsTTY(): boolean {
  return stdinIsTerminal();
}

function stdoutIsTTY(): boolean {
  return stdoutIsTerminal();
}

async function readPipedStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
      if (text.length > 400_000) break;
    }
    text += decoder.decode();
  } catch {
    /* empty stdin */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return text;
}

function projectIgnoreWarning(cwd: string): string | undefined {
  if (!fs.existsSync(path.join(cwd, ".tcli"))) return undefined;
  const gitignore = readFileTextSafe(path.join(cwd, ".gitignore"));
  if (!gitignore) return "Project .tcli/ exists but is not gitignored. Run `tcli init` or add .tcli/ to .gitignore.";
  if (!/^\s*\/?\.tcli\/?\s*$/m.test(gitignore)) {
    return "Project .tcli/ is not gitignored. Run `tcli init` or add .tcli/ to .gitignore.";
  }
  return undefined;
}

function colorModeFor(args: CliArgs, config?: Config): ColorMode {
  const setting = args.color ?? config?.ui.color ?? "auto";
  return detectColorMode(process.stdout, setting);
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "init") return runInit(argv.slice(1));
  if (argv[0] === "config") return runConfig(argv.slice(1));
  if (argv[0] === "sessions") return runSessions(argv.slice(1));
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`tcli ${TCLI_VERSION}\n`);
    return 0;
  }
  return await runMain(args);
}

async function runMain(args: CliArgs): Promise<number> {
  const cwd = path.resolve(args.cwd ? resolveFrom(process.cwd(), args.cwd) : process.cwd());
  const cwdStat = fs.statSync(cwd, { throwIfNoEntry: false });
  if (!cwdStat?.isDirectory()) throw new UsageError(`Workspace is not a directory: ${cwd}`);

  const stdinTTY = stdinIsTTY();
  const stdoutTTY = stdoutIsTTY();
  const dumbTerminal = process.env.TERM === "dumb" || process.platform === "win32";

  let prompt = args.prompt.join(" ").trim();
  let stdinContext = "";
  if (!stdinTTY) {
    const piped = (await readPipedStdin()).replace(/\u0000/g, "");
    if (piped.trim()) {
      const capped = truncateText(piped, 200_000, "\n… [stdin truncated]");
      if (prompt) stdinContext = capped;
      else prompt = capped;
    }
  }
  if (stdinContext) {
    prompt = `${prompt}\n\n<stdin-context>\n${stdinContext}\n</stdin-context>`;
  }

  const interactive =
    !args.json &&
    !args.streamJson &&
    ((args.interactive && stdinTTY && stdoutTTY) || (!prompt && stdinTTY && stdoutTTY && !dumbTerminal));
  if (args.interactive && (!stdinTTY || !stdoutTTY)) {
    throw new UsageError("--interactive requires a TTY on stdin and stdout");
  }
  if (!interactive && !prompt) {
    throw new UsageError(
      stdinTTY
        ? "No prompt provided. Pass a task, pipe stdin, or run `tcli` without arguments for the TUI."
        : "No prompt provided and stdin is empty.",
    );
  }
  if (interactive && dumbTerminal) {
    throw new UsageError("The TUI is unavailable on this terminal; provide a prompt for headless mode.");
  }

  const cliOverrides: CliConfigOverrides = {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    maxSteps: args.maxSteps,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    logLevel: args.verbose ? "debug" : undefined,
    permissionMode: args.permissionMode,
    color: args.color,
    sandbox: args.sandbox,
  };
  const loadedConfig = loadConfig({ cwd, cli: cliOverrides });
  const config = loadedConfig.config;
  if (args.noSave) config.session.autoSave = false;

  let loaded: LoadedSession | undefined;
  let session: SessionStore;
  let resumeWarning: string | undefined;
  if (args.continueSession || args.resume) {
    let summaryId = args.resumeId;
    if (!summaryId) {
      const latest = latestSession(cwd) ?? listSessions({ limit: 1 })[0];
      if (latest) {
        summaryId = latest.id;
        if (path.resolve(latest.cwd) !== cwd) {
          resumeWarning = `Resumed session was created in ${latest.cwd}; continuing in ${cwd}.`;
        }
      }
    }
    if (summaryId) {
      const resumed = SessionStore.resume(summaryId, { autoSave: config.session.autoSave });
      session = resumed.store;
      loaded = resumed.loaded;
    } else {
      resumeWarning = "No saved session found; starting a new session.";
      session = SessionStore.create({
        cwd,
        provider: config.provider,
        model: config.model,
        traceId: generateTraceId(),
        autoSave: config.session.autoSave,
        titleMaxLength: config.session.titleMaxLength,
      });
    }
  } else {
    session = SessionStore.create({
      cwd,
      provider: config.provider,
      model: config.model,
      traceId: generateTraceId(),
      autoSave: config.session.autoSave,
      titleMaxLength: config.session.titleMaxLength,
    });
  }

  // Continue with the model recorded in the session unless the user overrode it.
  if (loaded && !args.provider && !args.model && config.providers[loaded.meta.provider]) {
    config.provider = loaded.meta.provider;
    config.model = loaded.meta.model;
  }

  const traceId = session.meta.traceId;
  const logDirectory = config.logging.dir ? resolveFrom(cwd, config.logging.dir) : logsDir();
  const logger = new Logger({
    level: config.logging.level,
    traceId,
    dir: config.logging.file ? logDirectory : false,
    console: interactive ? "off" : "stderr",
  });
  const warnings: string[] = [...loadedConfig.warnings];
  if (resumeWarning) warnings.push(resumeWarning);
  const ignoreWarning = projectIgnoreWarning(cwd);
  if (ignoreWarning) warnings.push(ignoreWarning);

  let resolved;
  try {
    resolved = resolveProvider(config, config.provider, config.model);
  } catch (err) {
    throw err instanceof TcliError ? err : new ConfigError(describeError(err));
  }
  const keyHint = missingApiKeyHint(resolved);
  if (keyHint) warnings.push(keyHint);

  const registry = createToolRegistry(config);
  const mcp = new McpManager({ config, workspace: cwd, logger });
  try {
    const mcpResult = await mcp.load();
    warnings.push(...mcpResult.warnings);
    for (const tool of mcpResult.tools) {
      try {
        registry.register(tool);
      } catch (err) {
        warnings.push(`Failed to register MCP tool "${tool.name}": ${describeError(err)}`);
      }
    }
    const custom = await loadCustomTools({ cwd, config, logger });
    warnings.push(...custom.warnings);
    for (const tool of custom.tools) {
      try {
        registry.register(tool);
      } catch (err) {
        warnings.push(`Failed to register custom tool "${tool.name}": ${describeError(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`Tool initialization warning: ${describeError(err)}`);
    logger.warn("tool initialization failed", { error: describeError(err) });
  }

  const customCommands: CustomCommand[] = [];
  try {
    const loadedCommands = loadCustomCommands(cwd, config);
    customCommands.push(...loadedCommands.commands);
    warnings.push(...loadedCommands.warnings);
  } catch (err) {
    warnings.push(`Failed to load custom commands: ${describeError(err)}`);
  }

  const audit = new AuditLog({
    enabled: config.permissions.audit.enabled,
    dir: config.permissions.audit.dir ? resolveFrom(cwd, config.permissions.audit.dir) : auditDir(),
    logger,
    traceId,
    sessionId: session.id,
  });
  const permissions = new PermissionEngine({
    permissions: config.permissions,
    workspace: cwd,
    audit,
    logger,
  });
  if (args.yes) permissions.setYesMode(true);

  let overview;
  try {
    overview = getRepoOverview(cwd, config);
  } catch (err) {
    logger.warn("repository overview failed", { error: describeError(err) });
    overview = { text: "", data: {} as never, cached: false, generatedAt: new Date().toISOString() };
  }

  const buildAgent = (
    targetSession: SessionStore,
    targetLoaded?: LoadedSession,
  ): { agent: Agent; hooks: HookRunner } => {
    const currentResolved = resolveProvider(config, config.provider, config.model);
    const provider = createProvider(currentResolved);
    const snapshots = new SnapshotStore((record) => targetSession.recordSnapshot(record));
    if (targetLoaded) snapshots.restore(targetLoaded.snapshots);
    const checkpoints = new CheckpointStore(targetSession.dir, (info) =>
      targetSession.recordCheckpoint(info),
    );
    const todo = new TodoStore();
    todo.restore(targetLoaded?.todos);
    const hooks = new HookRunner({
      hooks: config.hooks,
      cwd,
      sessionId: targetSession.id,
      logger,
    });
    const instructions = loadInstructions(cwd, config);
    const agent = new Agent({
      workspace: cwd,
      config,
      provider,
      resolved: currentResolved,
      tools: registry,
      permissions,
      logger,
      snapshots,
      checkpoints,
      todo,
      session: targetSession,
      hooks,
      initialMessages: targetLoaded?.messages ?? [],
      initialUsage: targetLoaded?.usage,
      overview,
      instructions,
      maxSteps: args.maxSteps ?? config.maxSteps,
      verbose: config.logging.level === "debug",
      traceId: targetSession.meta.traceId,
      sessionId: targetSession.id,
    });
    return { agent, hooks };
  };

  const initial = buildAgent(session, loaded);
  try {
    await initial.hooks.sessionStart();
  } catch (err) {
    logger.warn("sessionStart hook failed", { error: describeError(err) });
  }

  const colorMode = colorModeFor(args, config);
  const theme = config.ui.theme;
  let exitCode = 0;
  let finalReason = "unknown";
  let finalText = "";
  let finalSession = session;
  let outcomeUsage: Usage = initial.agent.usage;
  let toolCallCount = 0;

  try {
    if (interactive) {
      for (const warning of warnings) logger.warn("startup warning", { warning });
      const tui = new Tui({
        agent: initial.agent,
        config,
        permissions,
        session,
        workspace: cwd,
        colorMode,
        theme,
        logger,
        warnings,
        initialPrompt: prompt || undefined,
        loaded,
        customCommands,
        pathCompleter: new PathCompleter(cwd),
        createAgent: (targetSession, targetLoaded) => {
          const built = buildAgent(targetSession, targetLoaded);
          void built.hooks.sessionStart().catch((err: unknown) => {
            logger.warn("sessionStart hook failed", { error: describeError(err) });
          });
          return built.agent;
        },
        onExit: async (tuiSession) => {
          finalSession = tuiSession;
          try {
            const endHooks = new HookRunner({
              hooks: config.hooks,
              cwd,
              sessionId: tuiSession.id,
              logger,
            });
            await endHooks.sessionEnd();
          } catch (err) {
            logger.warn("sessionEnd hook failed", { error: describeError(err) });
          }
          void reportTelemetry(config, {
            reason: "ui_exit",
            success: true,
            durationMs: 0,
            toolCalls: 0,
            inputTokens: initial.agent.usage.inputTokens,
            outputTokens: initial.agent.usage.outputTokens,
            provider: initial.agent.providerName,
            model: initial.agent.model,
          });
        },
      });
      await tui.start();
      exitCode = await tui.wait();
      finalReason = exitCode === 0 ? "end" : exitCode === 130 ? "aborted" : "error";
      outcomeUsage = initial.agent.usage;
    } else {
      const asker = args.yes ? undefined : createTerminalAsker({ colorMode, theme });
      permissions.setAsker(asker);
      if (!asker && !args.yes) {
        warnings.push(
          "No interactive terminal for confirmations; calls that require approval will be denied. Use an allow rule, --permission-mode workspace-write, or --yes with an allowlist for non-interactive runs.",
        );
      }
      for (const warning of warnings) process.stderr.write(`! ${warning}\n`);

      const renderer = new HeadlessRenderer({
        colorMode,
        theme,
        emitText: !args.json && !args.streamJson,
        showActivity: !args.json && !args.streamJson,
        verbose: args.verbose,
      });
      const toolCalls: Array<{ name: string; ok: boolean; denied: boolean; summary?: string; durationMs: number }> = [];
      let permissionDenials = 0;
      let errorMessage: string | undefined;
      let usage: Usage = initial.agent.usage;
      let costUsd: number | undefined;
      let lastText = "";
      let finalStop = "error";
      let interrupted = 0;
      const onSigint = () => {
        interrupted++;
        if (interrupted >= 2) process.exit(130);
        initial.agent.cancel();
      };
      process.on("SIGINT", onSigint);
      const startedAt = performance.now();
      try {
        for await (const event of initial.agent.run(prompt)) {
          if (args.streamJson) {
            process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
          }
          renderer.handle(event);
          switch (event.type) {
            case "tool_result":
              toolCalls.push({
                name: event.outcome.invocation.name,
                ok: event.outcome.ok,
                denied: event.outcome.denied === true,
                summary: event.display?.summary,
                durationMs: event.outcome.durationMs,
              });
              break;
            case "permission":
              if (!event.allowed) permissionDenials++;
              break;
            case "usage":
              usage = event.total;
              costUsd = event.costUsd;
              break;
            case "error":
              errorMessage = event.message;
              break;
            case "done":
              lastText = event.text;
              finalStop = event.reason;
              break;
            default:
              break;
          }
        }
        renderer.finish();
        usage = initial.agent.usage;
        costUsd = initial.agent.usageCostUsd();
        finalReason = finalStop;
        finalText = lastText;
        outcomeUsage = usage;
        toolCallCount = toolCalls.length;
        exitCode = finalStop === "end" ? 0 : finalStop === "aborted" ? 130 : 1;
        const durationMs = Math.round(performance.now() - startedAt);
        if (args.json || args.streamJson) {
          const payload = {
            ok: finalStop === "end" && !errorMessage,
            version: TCLI_VERSION,
            sessionId: session.id,
            traceId,
            cwd,
            provider: initial.agent.providerName,
            model: initial.agent.model,
            reason: finalStop,
            text: lastText,
            exitCode,
            durationMs,
            usage,
            costUsd,
            toolCalls,
            permissionDenials,
            error: errorMessage,
            warnings,
          };
          if (args.streamJson) {
            process.stdout.write(JSON.stringify({ type: "result", ts: new Date().toISOString(), ...payload }) + "\n");
          } else {
            process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
          }
        }
      } finally {
        process.off("SIGINT", onSigint);
        asker?.close();
        permissions.setAsker(undefined);
      }
    }

    if (!interactive) {
      try {
        const endHooks = new HookRunner({
          hooks: config.hooks,
          cwd,
          sessionId: finalSession.id,
          logger,
        });
        await endHooks.sessionEnd();
      } catch (err) {
        logger.warn("sessionEnd hook failed", { error: describeError(err) });
      }
      void reportTelemetry(config, {
        reason: finalReason,
        success: exitCode === 0,
        durationMs: 0,
        toolCalls: toolCallCount,
        inputTokens: outcomeUsage.inputTokens,
        outputTokens: outcomeUsage.outputTokens,
        provider: initial.agent.providerName,
        model: initial.agent.model,
      });
    }
    return exitCode;
  } finally {
    await mcp.close().catch(() => undefined);
    initial.agent.cancel();
  }
}

async function runInit(argv: string[]): Promise<number> {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) throw new UsageError("--cwd requires a value");
      cwd = path.resolve(cwd, value);
    } else if (arg.startsWith("--cwd=")) {
      cwd = path.resolve(cwd, arg.slice("--cwd=".length));
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: tcli init [--cwd <dir>]\n");
      return 0;
    } else {
      throw new UsageError(`Unknown option for init: ${arg}`);
    }
  }
  const result = initProject(cwd);
  process.stdout.write(`tcli initialized in ${cwd}\n`);
  if (result.created.length) {
    process.stdout.write(`Created:\n${result.created.map((f) => `  ${displayPath(f, cwd)}`).join("\n")}\n`);
  }
  if (result.skipped.length) {
    process.stdout.write(`Kept existing:\n${result.skipped.map((f) => `  ${displayPath(f, cwd)}`).join("\n")}\n`);
  }
  if (result.notes.length) process.stdout.write(result.notes.join("\n") + "\n");
  return 0;
}

async function runConfig(argv: string[]): Promise<number> {
  let cwd = process.cwd();
  let action = "show";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) throw new UsageError("--cwd requires a value");
      cwd = path.resolve(cwd, value);
    } else if (arg.startsWith("--cwd=")) {
      cwd = path.resolve(cwd, arg.slice("--cwd=".length));
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: tcli config [path|validate] [--cwd <dir>]\n");
      return 0;
    } else if (arg === "path") {
      action = "path";
    } else if (arg === "validate") {
      action = "validate";
    } else if (arg === "show") {
      action = "show";
    } else {
      throw new UsageError(`Unknown option for config: ${arg}`);
    }
  }
  if (action === "path") {
    process.stdout.write(`user:    ${userConfigPath()}\nproject: ${projectConfigPath(cwd)}\n`);
    return 0;
  }
  const loaded = loadConfig({ cwd });
  if (action === "validate") {
    process.stdout.write("Configuration valid.\n");
    if (loaded.sources.length) process.stdout.write(`Sources: ${loaded.sources.join(", ")}\n`);
    for (const warning of loaded.warnings) process.stderr.write(`! ${warning}\n`);
    return 0;
  }
  process.stdout.write(JSON.stringify(redactValue(loaded.config), null, 2) + "\n");
  for (const warning of loaded.warnings) process.stderr.write(`! ${warning}\n`);
  return 0;
}

function formatSessionRow(summary: ReturnType<typeof listSessions>[number]): string {
  const model = `${summary.provider}/${summary.model}`;
  return [
    summary.id.padEnd(22),
    formatRelativeTime(summary.updatedAt).padEnd(12),
    model.padEnd(32),
    truncateText(summary.title, 60),
  ].join("  ");
}

async function runSessions(argv: string[]): Promise<number> {
  let action = "list";
  let id: string | undefined;
  let titleParts: string[] = [];
  let out: string | undefined;
  let yes = false;
  let cwd = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage:\n  tcli sessions [list] [--json]\n  tcli sessions export <id> [--out <file>|-]\n  tcli sessions rename <id> <title>\n  tcli sessions delete <id> [--yes]\n",
      );
      return 0;
    }
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--json") json = true;
    else if (arg === "--out") {
      out = argv[++i];
      if (out === undefined) throw new UsageError("--out requires a value");
    } else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) throw new UsageError("--cwd requires a value");
      cwd = path.resolve(cwd, value);
    } else if (arg === "list" || arg === "export" || arg === "delete" || arg === "rename") action = arg;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option for sessions: ${arg}`);
    else if (!id) id = arg;
    else if (action === "rename") titleParts.push(arg);
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }
  if (action === "list") {
    const sessions = listSessions({ limit: 100 });
    if (json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
      return 0;
    }
    if (!sessions.length) {
      process.stdout.write("No saved sessions.\n");
      return 0;
    }
    process.stdout.write("ID                      UPDATED      MODEL                             TITLE\n");
    for (const summary of sessions) process.stdout.write(formatSessionRow(summary) + "\n");
    return 0;
  }
  if (action === "export") {
    if (!id) throw new UsageError("sessions export requires a session id");
    const loaded = readSession(id);
    const markdown = sessionToMarkdown(loaded);
    if (out === "-") {
      process.stdout.write(markdown);
      return 0;
    }
    const target = out ? path.resolve(cwd, out) : path.join(cwd, ".tcli", "exports", `${id}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, "utf8");
    process.stdout.write(`Exported ${id} to ${target}\n`);
    return 0;
  }
  if (action === "rename") {
    if (!id) throw new UsageError("sessions rename requires a session id");
    const title = titleParts.join(" ").trim();
    if (!title) throw new UsageError("sessions rename requires a new title");
    const { store } = SessionStore.resume(id, { autoSave: true });
    store.setTitle(title);
    process.stdout.write(`Renamed session ${id} to "${title}".\n`);
    return 0;
  }
  if (action === "delete") {
    if (!id) throw new UsageError("sessions delete requires a session id");
    if (!yes) {
      const answer = await promptLine(`Delete session ${id}? [y/N] `);
      if (!answer || !/^y(es)?$/i.test(answer)) {
        process.stdout.write("Aborted.\n");
        return 1;
      }
    }
    deleteSession(id);
    process.stdout.write(`Deleted session ${id}.\n`);
    return 0;
  }
  return 0;
}

function wantsJsonOutput(argv: string[]): boolean {
  return argv.includes("--json");
}

function wantsStreamOutput(argv: string[]): boolean {
  return argv.includes("--stream-json");
}

if (import.meta.main) {
  void (async () => {
    try {
      const code = await main(process.argv.slice(2));
      process.exitCode = code;
    } catch (err) {
      const code = err instanceof TcliError ? err.exitCode : 1;
      const message = describeError(err);
      if (wantsStreamOutput(process.argv.slice(2))) {
        process.stdout.write(JSON.stringify({ type: "error", message, exitCode: code }) + "\n");
      } else if (wantsJsonOutput(process.argv.slice(2))) {
        process.stdout.write(JSON.stringify({ ok: false, error: message, exitCode: code }, null, 2) + "\n");
      } else {
        process.stderr.write(`tcli: ${message}\n`);
        if (err instanceof UsageError) process.stderr.write("Run \`tcli --help\` for usage.\n");
      }
      if (!(err instanceof TcliError)) {
        const report = writeCrashReport({
          error: message,
          stack: err instanceof Error ? err.stack : undefined,
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          version: TCLI_VERSION,
        });
        if (report) process.stderr.write(`Crash report: ${report}\n`);
      }
      process.exitCode = code;
    }
  })();
}

export { main, parseArgs };
