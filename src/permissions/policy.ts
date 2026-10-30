import path from "node:path";
import { matchGlob } from "../utils/glob.ts";
import { toPosix } from "../utils/paths.ts";
import type { PermissionsConfig } from "../config/schema.ts";
import type { Decision, PermissionRequest, PermissionRuleMatch, SessionGrant } from "./types.ts";
import { commandPrefix, detectDangerousCommand } from "./dangerous.ts";

export interface PolicyOptions {
  permissions: PermissionsConfig;
  workspace: string;
  /** Precompiled extra dangerous regex sources (config). */
  dangerPatterns?: string[];
}

function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === tool || pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) return false;
  return matchGlob(pattern, tool);
}

function matchCommandPattern(pattern: string, command: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed.includes("*")) return matchGlob(trimmed, command) || matchGlob(trimmed, command.split(/\s+/)[0] ?? "");
  const cmd = command.trim();
  return cmd === trimmed || cmd.startsWith(trimmed + " ") || cmd.startsWith(trimmed + "\t");
}

function matchPathPattern(pattern: string, req: PermissionRequest, workspace: string): boolean {
  const candidates = new Set<string>();
  for (const p of req.paths) {
    candidates.add(toPosix(p));
    const rel = toPosix(path.relative(workspace, p));
    if (rel && !rel.startsWith("..")) candidates.add(rel);
    candidates.add(path.basename(p));
  }
  const normalized = pattern.replace(/\\/g, "/");
  for (const candidate of candidates) {
    if (matchGlob(normalized, candidate)) return true;
    if (candidate.startsWith(normalized.replace(/\/+$/, "") + "/")) return true;
  }
  return false;
}

function ruleMatches(rule: PermissionRuleMatch, req: PermissionRequest, workspace: string): boolean {
  if (!toolMatches(rule.tool, req.tool)) return false;
  if (!rule.match) return true;
  if (req.kind === "exec") {
    if (!req.command) return false;
    return matchCommandPattern(rule.match, req.command);
  }
  if (req.kind === "network") {
    const urls = [req.input.url, req.input.query].filter((v): v is string => typeof v === "string");
    const host = urls.map((u) => {
      try {
        return new URL(u).host;
      } catch {
        return u;
      }
    });
    return host.some((h) => matchGlob(rule.match!, h)) || req.paths.some((p) => matchPathPattern(rule.match!, req, workspace));
  }
  if (req.paths.length) return matchPathPattern(rule.match, req, workspace);
  return false;
}

export function grantMatches(grant: SessionGrant, req: PermissionRequest, workspace: string): boolean {
  if (!toolMatches(grant.tool, req.tool)) return false;
  if (!grant.match) return true;
  if (req.kind === "exec") return req.command ? matchCommandPattern(grant.match, req.command) : false;
  if (req.kind === "network") {
    const url = typeof req.input.url === "string" ? req.input.url : "";
    try {
      if (new URL(url).host === grant.match) return true;
    } catch {
      /* not a URL */
    }
    return false;
  }
  return req.paths.some((p) => matchPathPattern(grant.match!, req, workspace));
}

export function grantForRequest(req: PermissionRequest, workspace: string): SessionGrant {
  const base = { tool: req.tool, createdAt: Date.now() };
  if (req.kind === "exec" && req.command) {
    return { ...base, match: commandPrefix(req.command) || undefined };
  }
  if (req.kind === "network") {
    const url = typeof req.input.url === "string" ? req.input.url : "";
    try {
      return { ...base, match: new URL(url).host };
    } catch {
      return base;
    }
  }
  if (req.paths.length === 1) return { ...base, match: toPosix(req.paths[0]!) };
  if (req.paths.length > 1) {
    const rel = toPosix(path.relative(workspace, req.paths[0]!));
    return { ...base, match: rel && !rel.startsWith("..") ? `**/${path.basename(req.paths[0]!)}` : undefined };
  }
  return base;
}

function defaultAction(kind: PermissionRequest["kind"], mode: PermissionsConfig["mode"]): { action: Decision["action"]; reason: string } {
  if (mode === "read-only") {
    return kind === "read"
      ? { action: "allow", reason: "read-only mode: reads are allowed" }
      : { action: "deny", reason: "read-only mode denies writes, commands and network access" };
  }
  if (kind === "read") return { action: "allow", reason: "read-only tool" };
  return { action: "ask", reason: `${kind} tool requires confirmation` };
}

/**
 * Pure permission decision function (SE-1): no filesystem, no UI, no state.
 *
 * Order: hard mode → dangerous commands → workspace boundary → sensitive paths
 * → session grants → configured rules (last match wins) → defaults.
 */
export function decidePermission(
  req: PermissionRequest,
  opts: PolicyOptions,
  grants: SessionGrant[] = [],
): Decision {
  const { permissions: perms, workspace } = opts;
  const mode = perms.mode;

  if (mode === "read-only" && (req.kind === "write" || req.kind === "exec" || req.kind === "network")) {
    if (req.tool === "todo") {
      // Internal task tracking has no external side effect.
    } else {
      return {
        action: "deny",
        reason: "read-only mode: writes, commands and network access are disabled",
        source: "mode",
      };
    }
  }

  if (perms.dangerous.enabled) {
    const danger =
      req.kind === "exec" && req.command
        ? detectDangerousCommand(req.command, [...perms.dangerous.extra, ...(opts.dangerPatterns ?? [])])
        : null;
    if (danger) {
      const allowListed = perms.dangerous.allow.some((entry) => matchCommandPattern(entry, req.command ?? ""));
      if (!allowListed) {
        return {
          action: "deny",
          reason: `Blocked dangerous command (${danger.label}): ${danger.detail}. It can still be run manually.`,
          source: "danger",
          dangerLabel: danger.label,
        };
      }
      return {
        action: "ask",
        reason: `Dangerous command (${danger.label}) is allowlisted; explicit confirmation required`,
        source: "danger",
        dangerLabel: danger.label,
      };
    }
  }

  if (req.outsideWorkspace && perms.workspaceOnly) {
    return {
      action: "ask",
      reason: "path resolves outside the workspace (symlinks are resolved)",
      source: "workspace",
    };
  }

  if (req.sensitive) {
    const why = req.sensitiveReasons?.length ? `: ${req.sensitiveReasons.join(", ")}` : "";
    return { action: "ask", reason: `sensitive path or credentials${why}`, source: "sensitive" };
  }

  for (const grant of [...grants].reverse()) {
    if (grantMatches(grant, req, workspace)) {
      return { action: "allow", reason: "allowed for this session", source: "grant" };
    }
  }

  let matched: PermissionRuleMatch | undefined;
  for (const rule of perms.rules) {
    if (ruleMatches(rule, req, workspace)) matched = rule;
  }
  if (matched) {
    return {
      action: matched.action,
      reason: matched.reason ?? `matched rule: ${matched.tool}${matched.match ? ` (${matched.match})` : ""}`,
      source: "rule",
      rule: { tool: matched.tool, match: matched.match, action: matched.action, reason: matched.reason },
    };
  }

  const fallback = defaultAction(req.kind, mode);
  if (
    mode === "workspace-write" &&
    fallback.action === "ask" &&
    req.kind === "write" &&
    !req.outsideWorkspace &&
    !req.sensitive
  ) {
    return {
      action: "allow",
      reason: "workspace-write mode: writes inside the workspace are allowed",
      source: "mode",
    };
  }
  return { action: fallback.action, reason: fallback.reason, source: "default" };
}

export function isAutoApprovedForYes(req: PermissionRequest, patterns: string[]): boolean {
  return patterns.some((pattern) => toolMatches(pattern, req.tool));
}

/** Rules that would be needed to make this call non-interactive (for diagnostics). */
export function describeRuleSuggestion(req: PermissionRequest): string {
  if (req.kind === "exec" && req.command) {
    const prefix = commandPrefix(req.command);
    return `Add to permissions.rules: { "tool": "${req.tool}", "match": "${prefix}*", "action": "allow" }`;
  }
  if (req.paths.length === 1) {
    return `Add to permissions.rules: { "tool": "${req.tool}", "match": "${path.basename(req.paths[0]!)}", "action": "allow" }`;
  }
  return `Add to permissions.rules: { "tool": "${req.tool}", "action": "allow" }`;
}
