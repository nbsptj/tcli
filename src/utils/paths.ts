import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

export function homeDir(): string {
  return process.env.HOME || homedir();
}

/** Root for all tcli user state (`~/.tcli` unless TCLI_HOME is set). */
export function tcliHome(): string {
  const override = process.env.TCLI_HOME?.trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(homeDir(), ".tcli");
}

export function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return path.join(homeDir(), p.slice(2));
  return p;
}

export function userConfigPath(): string {
  return path.join(tcliHome(), "config.json");
}

export function userCommandsDir(): string {
  return path.join(tcliHome(), "commands");
}

export function userToolsDir(): string {
  return path.join(tcliHome(), "tools");
}

export function projectDir(cwd: string): string {
  return path.join(cwd, ".tcli");
}

export function projectConfigPath(cwd: string): string {
  return path.join(projectDir(cwd), "config.json");
}

export function projectCommandsDir(cwd: string): string {
  return path.join(projectDir(cwd), "commands");
}

export function projectToolsDir(cwd: string): string {
  return path.join(projectDir(cwd), "tools");
}

export function sessionsDir(): string {
  return path.join(tcliHome(), "sessions");
}

export function logsDir(): string {
  return path.join(tcliHome(), "logs");
}

export function auditDir(): string {
  return path.join(tcliHome(), "audit");
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsDir(), sessionId);
}

export function sessionFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.jsonl`);
}

export function resolveFrom(base: string, p: string): string {
  return path.resolve(base, expandHome(p));
}

/** Convert to the POSIX-style separators used in tool output and patterns. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** True when child is equal to or inside parent (lexical check). */
export function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Realpath of the deepest existing ancestor, with the remaining path segments
 * appended. Used to detect symlink escapes for paths that do not exist yet.
 */
export function realpathDeep(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(p);
}

export function displayPath(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
  return toPosix(p);
}

/** Paths that are inside the workspace after resolving symlinks. */
export function isWithinWorkspace(workspace: string, candidate: string): boolean {
  const realWs = realpathDeep(workspace);
  const realCandidate = realpathDeep(candidate);
  return isSubPath(realWs, realCandidate);
}

export function workspaceRelative(workspace: string, candidate: string): string {
  return toPosix(path.relative(workspace, candidate));
}

/** Expand a user supplied path relative to cwd, without resolving symlinks. */
export function resolveUserPath(cwd: string, input: string): string {
  return path.resolve(cwd, expandHome(input));
}

export function tildePath(p: string): string {
  const home = homeDir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return `~/${toPosix(p.slice(home.length + 1))}`;
  return toPosix(p);
}

export function uniqueTempName(dir: string, base: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(dir, `.${base}.tcli-${process.pid}-${rand}.tmp`);
}
