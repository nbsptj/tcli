import fs from "node:fs";
import { KeyParser, type Key } from "./keys.ts";
import { stdinIsTerminal } from "../utils/tty.ts";


export interface TerminalInputOptions {
  onKey: (key: Key) => void;
  /** Called after buffered input/escape sequences have been flushed. */
  onActivity?: () => void;
  onError?: (error: Error) => void;
  onEnd?: () => void;
}

/**
 * Raw terminal input. Bun does not expose `process.stdin.setRawMode`, so we use
 * `stty raw -echo` (restoring the saved settings on exit) and read bytes from
 * Bun's stdin stream. A short timer disambiguates a lone Esc from Alt+key.
 */
export class TerminalInput {
  private readonly options: TerminalInputOptions;
  private readonly parser = new KeyParser();
  private stream?: fs.ReadStream;
  private stopped = false;
  private savedStty?: string;
  private usingSetRawMode = false;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(options: TerminalInputOptions) {
    this.options = options;
  }

  get rawModeActive(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (!stdinIsTerminal()) {
      throw new Error("Interactive TUI requires a TTY on stdin");
    }
    try {
      const saved = Bun.spawnSync({
        cmd: ["stty", "-g"],
        stdin: "inherit",
        stdout: "pipe",
        stderr: "ignore",
      });
      if (saved.exitCode === 0) this.savedStty = saved.stdout.toString().trim();
    } catch {
      /* ignore */
    }
    const raw = Bun.spawnSync({
      cmd: ["stty", "raw", "-echo"],
      stdin: "inherit",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (raw.exitCode !== 0) throw new Error("Failed to put the terminal into raw mode (stty)");

    // Read fd 0 directly. Bun's `Bun.stdin.stream()` can already be locked by
    // Node-compat initialization (`process.stdin`), which made the TUI crash.
    const stream = fs.createReadStream(null as unknown as string, {
      fd: 0,
      autoClose: false,
      encoding: "utf8",
    });
    this.stream = stream;
    stream.on("data", (chunk) => {
      if (this.stopped) return;
      this.dispatch(this.parser.feed(typeof chunk === "string" ? chunk : String(chunk)));
      this.scheduleFlush();
    });
    stream.on("error", (err) => {
      if (!this.stopped) this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    stream.on("end", () => {
      if (!this.stopped) this.options.onEnd?.();
    });
  }

  private dispatch(keys: Key[]): void {
    for (const key of keys) this.options.onKey(key);
    this.options.onActivity?.();
  }

  private scheduleFlush(): void {
    if (!this.parser.hasPending() || this.parser.isPasting()) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.stopped) return;
      this.dispatch(this.parser.flushEscape());
    }, 25);
  }

  /** Synchronous terminal restoration safe to call from process "exit". */
  restoreSync(): void {
    if (this.usingSetRawMode) {
      try {
        (process.stdin as unknown as { setRawMode?: (on: boolean) => void }).setRawMode?.(false);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      if (this.savedStty) {
        Bun.spawnSync({ cmd: ["stty", this.savedStty], stdin: "inherit", stdout: "ignore", stderr: "ignore" });
      } else {
        Bun.spawnSync({ cmd: ["stty", "sane"], stdin: "inherit", stdout: "ignore", stderr: "ignore" });
      }
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    try {
      this.stream?.destroy();
    } catch {
      /* ignore */
    }
    this.stream = undefined;
    if (this.usingSetRawMode) {
      try {
        (process.stdin as unknown as { setRawMode?: (on: boolean) => void }).setRawMode?.(false);
      } catch {
        /* ignore */
      }
    } else {
      this.restoreSync();
    }
  }
}
