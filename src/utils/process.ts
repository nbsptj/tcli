import { stripAnsi } from "./strings.ts";
import { asError } from "./errors.ts";

export interface ChildHandle {
  pid: number;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface RunCommandOptions {
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  detached?: boolean;
  onSpawn?: (child: ChildHandle) => void;
  stripAnsiOutput?: boolean;
}

export interface StreamCapture {
  text: string;
  totalBytes: number;
  truncated: boolean;
}

export interface RunCommandResult {
  exitCode: number;
  signalCode: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

/** Kill a child and (on POSIX) its whole process group. */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    /* no process group */
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<StreamCapture> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (kept < maxBytes) {
        const take = Math.min(value.byteLength, maxBytes - kept);
        chunks.push(value.subarray(0, take));
        kept += take;
        if (take < value.byteLength) truncated = true;
      } else if (value.byteLength > 0) {
        truncated = true;
      }
    }
  } catch {
    /* stream closed by a killed child */
  }
  const merged = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), totalBytes: total, truncated };
}

/**
 * Run a non-interactive command, capturing capped output, enforcing a timeout
 * and killing the entire process tree on timeout/abort.
 *
 * The child is started in its own process group (POSIX `setsid`) so `kill(-pid)`
 * reaches grandchildren spawned by shells and build tools.
 */
export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const started = performance.now();
  const maxBytes = opts.maxBytes ?? 51_200;
  let timedOut = false;
  let aborted = false;
  let child: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  const detached = opts.detached ?? process.platform !== "win32";
  try {
    child = Bun.spawn({
      cmd: opts.cmd,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached,
    });
  } catch (err) {
    const message = asError(err).message;
    return {
      exitCode: 127,
      signalCode: null,
      stdout: "",
      stderr: message,
      output: message,
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: Math.round(performance.now() - started),
    };
  }

  opts.onSpawn?.({ pid: child.pid, kill: (sig) => killProcessTree(child.pid, (sig as NodeJS.Signals) ?? "SIGKILL") });

  const onAbort = () => {
    aborted = true;
    killProcessTree(child.pid, "SIGTERM");
    // Escalate shortly after in case the process ignores SIGTERM.
    setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 800).unref?.();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 800).unref?.();
    }, opts.timeoutMs);
    timer.unref?.();
  }

  // Feed stdin without blocking the output readers.
  if (opts.stdin !== undefined && child.stdin) {
    try {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } catch {
      /* child may have exited immediately */
    }
  }

  const stdoutPromise = readCapped(child.stdout, maxBytes + 1);
  const stderrPromise = readCapped(child.stderr, maxBytes + 1);
  let exitCode = 0;
  try {
    exitCode = await child.exited;
  } catch {
    exitCode = 1;
  }
  const [stdoutCapture, stderrCapture] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  const clean = (text: string) => (opts.stripAnsiOutput === false ? text : stripAnsi(text));
  let stdout = clean(stdoutCapture.text);
  let stderr = clean(stderrCapture.text);
  if (stdoutCapture.truncated) stdout += "\n… [stdout truncated]";
  if (stderrCapture.truncated) stderr += "\n… [stderr truncated]";
  const output = [stdout, stderr].filter((s) => s.length > 0).join("\n");

  return {
    exitCode: aborted ? 130 : timedOut ? 124 : exitCode,
    signalCode: child.signalCode as NodeJS.Signals | null,
    stdout,
    stderr,
    output,
    timedOut,
    aborted,
    truncated: stdoutCapture.truncated || stderrCapture.truncated,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Locate an executable without spawning a shell. */
export function which(bin: string): string | null {
  return Bun.which(bin);
}
