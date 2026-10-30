import { isatty } from "node:tty";

/**
 * TTY detection that avoids touching `process.stdin` (accessing it can
 * initialize Bun's Node-compat stdin and lock the stream). `isatty` and
 * `stty -g` both fail harmlessly in pipes/CI.
 */
export function stdinIsTerminal(): boolean {
  try {
    if (isatty(0)) return true;
  } catch {
    /* ignore */
  }
  try {
    const result = Bun.spawnSync({
      cmd: ["stty", "-g"],
      stdin: "inherit",
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function stdoutIsTerminal(): boolean {
  if (process.stdout.isTTY) return true;
  try {
    return isatty(1);
  } catch {
    return false;
  }
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function terminalSize(): TerminalSize {
  const columns = process.stdout.columns;
  const rows = process.stdout.rows;
  if (typeof columns === "number" && columns > 0 && typeof rows === "number" && rows > 0) {
    return { columns, rows };
  }
  try {
    const result = Bun.spawnSync({
      cmd: ["stty", "size"],
      stdin: "inherit",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const [r, c] = result.stdout.toString().trim().split(/\s+/).map(Number);
      if (Number.isFinite(r) && Number.isFinite(c) && r! > 0 && c! > 0) {
        return { rows: r!, columns: c! };
      }
    }
  } catch {
    /* fall through */
  }
  return { columns: 80, rows: 24 };
}
