import path from "node:path";
import { which } from "../utils/process.ts";

export type SandboxMode = "off" | "read-only" | "workspace";

export interface SandboxOptions {
  mode: SandboxMode;
  network: boolean;
  cwd: string;
}

export interface SandboxCommand {
  cmd: string[];
  error?: string;
}

function escapeProfileString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * macOS seatbelt profile: deny by default, allow reading everywhere (builds
 * need headers), allow writes only in the workspace and temp dirs, and allow
 * network only when opted in.
 */
export function buildMacSandboxProfile(opts: SandboxOptions): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
  ];
  if (opts.mode === "workspace") {
    lines.push(
      `(allow file-write* (subpath "${escapeProfileString(opts.cwd)}") (subpath "/private/tmp") (subpath "/tmp") (literal "/dev/null"))`,
    );
  } else {
    lines.push('(allow file-write* (literal "/dev/null"))');
  }
  if (opts.network) lines.push("(allow network-outbound)");
  return lines.join("\n");
}

/** Linux bubblewrap arguments (pure builder, testable without bwrap installed). */
export function buildLinuxSandboxArgs(opts: SandboxOptions): string[] {
  const args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--chdir", opts.cwd];
  if (!opts.network) args.push("--unshare-net");
  if (opts.mode === "workspace") args.push("--bind", opts.cwd, opts.cwd);
  return args;
}

/**
 * Wrap a shell command for optional OS sandboxing (SE-7).
 *
 * Returns a clear error instead of silently running unsandboxed when the
 * requested sandbox backend is unavailable.
 */
export function wrapSandboxedCommand(command: string, opts: SandboxOptions): SandboxCommand {
  if (opts.mode === "off") return { cmd: ["bash", "-c", command] };
  if (process.platform === "darwin") {
    const sandboxExec = which("sandbox-exec");
    if (!sandboxExec) {
      return { cmd: [], error: "Sandbox requested but macOS sandbox-exec is not available." };
    }
    return { cmd: [sandboxExec, "-p", buildMacSandboxProfile(opts), "bash", "-c", command] };
  }
  if (process.platform === "linux") {
    const bwrap = which("bwrap");
    if (!bwrap) {
      return {
        cmd: [],
        error: "Sandbox requested but bubblewrap (bwrap) is not installed. Install bubblewrap or set sandbox.mode=off.",
      };
    }
    return { cmd: [...buildLinuxSandboxArgs(opts), "bash", "-c", command] };
  }
  return { cmd: [], error: `Sandboxing is not supported on ${process.platform}; set sandbox.mode=off.` };
}

/** Resolve a workspace path for display in sandbox diagnostics. */
export function sandboxCwd(cwd: string): string {
  return path.resolve(cwd);
}
