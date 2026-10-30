import fs from "node:fs";
import path from "node:path";
import { logsDir } from "../utils/paths.ts";
import { redactValue } from "../utils/redact.ts";
import { ensureDirSync } from "../utils/fs.ts";
import { describeError } from "../utils/errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  traceId?: string;
  /** Directory for JSONL logs; false disables file logging. */
  dir?: string | false;
  /** Where to mirror human-readable logs (never use stdout for JSON modes). */
  console?: "off" | "stderr";
  bindings?: Record<string, unknown>;
}

/**
 * Structured logger. Always redacts credentials; file logging is appended
 * synchronously (logs are low volume, and crash-safety matters more than
 * throughput). The TUI disables the console mirror to avoid corrupting the
 * screen.
 */
export class Logger {
  readonly level: LogLevel;
  readonly traceId?: string;
  private readonly dir: string | false;
  private readonly consoleMode: "off" | "stderr";
  private readonly bindings: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.traceId = opts.traceId;
    this.dir = opts.dir === undefined ? logsDir() : opts.dir;
    this.consoleMode = opts.console ?? "off";
    this.bindings = opts.bindings ?? {};
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      traceId: this.traceId,
      dir: this.dir,
      console: this.consoleMode,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  enabled(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  exception(err: unknown, message = "unhandled error", fields?: Record<string, unknown>): void {
    this.write("error", message, {
      ...fields,
      error: describeError(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const record = redactValue({
      ts: new Date().toISOString(),
      level,
      msg: message,
      trace: this.traceId,
      ...this.bindings,
      ...fields,
    });
    if (this.consoleMode !== "off" && (level === "warn" || level === "error" || this.level === "debug")) {
      const extra = fields && Object.keys(fields).length ? " " + JSON.stringify(redactValue(fields)) : "";
      process.stderr.write(`[tcli ${level}] ${message}${extra}\n`);
    }
    if (!this.dir) return;
    try {
      ensureDirSync(this.dir);
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(this.dir, `tcli-${day}.log`), JSON.stringify(record) + "\n", "utf8");
    } catch {
      /* Logging must never break the agent. */
    }
  }
}

export const nullLogger = new Logger({ dir: false, console: "off", level: "error" });

/** Write a crash report and return its path (best effort). */
export function writeCrashReport(info: Record<string, unknown>): string | undefined {
  try {
    ensureDirSync(logsDir());
    const file = path.join(logsDir(), `crash-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(redactValue(info), null, 2), "utf8");
    return file;
  } catch {
    return undefined;
  }
}
