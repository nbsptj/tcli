import type { PermissionsConfig } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";
import { stackOf } from "../utils/errors.ts";
import { AuditLog } from "./audit.ts";
import { detectDangerousCommand } from "./dangerous.ts";
import { decidePermission, grantForRequest, isAutoApprovedForYes } from "./policy.ts";
import type {
  Asker,
  AuthorizeResult,
  Decision,
  PermissionRequest,
  SessionGrant,
} from "./types.ts";

/**
 * Stateful wrapper around the pure policy: owns session grants, the
 * confirmation UI callback, `--yes` policy and audit logging.
 */
export class PermissionEngine {
  readonly permissions: PermissionsConfig;
  readonly workspace: string;
  audit: AuditLog;
  private readonly logger: Logger;
  private readonly grants: SessionGrant[] = [];
  private asker?: Asker;
  private yesMode = false;

  constructor(opts: {
    permissions: PermissionsConfig;
    workspace: string;
    audit: AuditLog;
    logger: Logger;
  }) {
    this.permissions = opts.permissions;
    this.workspace = opts.workspace;
    this.audit = opts.audit;
    this.logger = opts.logger;
  }

  setAsker(asker: Asker | undefined): void {
    this.asker = asker;
  }

  /** Re-bind audit records to a new session (used by /resume and /clear). */
  setSession(sessionId: string): void {
    this.audit = this.audit.withSession(sessionId);
  }

  setYesMode(enabled: boolean): void {
    this.yesMode = enabled;
  }

  isYesMode(): boolean {
    return this.yesMode;
  }

  decide(req: PermissionRequest): Decision {
    return decidePermission(req, { permissions: this.permissions, workspace: this.workspace }, this.grants);
  }

  activeGrants(): readonly SessionGrant[] {
    return this.grants;
  }

  clearGrants(): void {
    this.grants.length = 0;
  }

  private addGrant(grant: SessionGrant): void {
    this.grants.push(grant);
  }

  async authorize(
    req: PermissionRequest,
    opts: { sessionId?: string; signal?: AbortSignal; forceAsk?: boolean } = {},
  ): Promise<AuthorizeResult> {
    const started = performance.now();
    let decision = this.decide(req);
    if (opts.forceAsk && decision.action === "allow") {
      decision = {
        ...decision,
        action: "ask",
        reason: "a preToolUse hook requested explicit confirmation",
      };
    }
    const elapsed = () => Math.round(performance.now() - started);
    const finish = (
      allowed: boolean,
      approvedBy: AuthorizeResult["approvedBy"],
      finalDecision: Decision,
      editedInput?: Record<string, unknown>,
    ): AuthorizeResult => {
      this.audit.record({
        event: "decision",
        tool: req.tool,
        kind: req.kind,
        input: req.input,
        decision: finalDecision.action === "deny" ? "deny" : "allow",
        approvedBy,
        reason: finalDecision.reason,
        durationMs: elapsed(),
      });
      this.logger.info("permission decision", {
        sessionId: opts.sessionId,
        tool: req.tool,
        decision: finalDecision.action,
        approvedBy,
        reason: finalDecision.reason,
      });
      return {
        allowed,
        decision: finalDecision,
        approvedBy: allowed ? approvedBy : "none",
        editedInput,
        durationMs: elapsed(),
      };
    };

    if (decision.action === "allow") {
      return finish(true, decision.source === "grant" ? "grant" : "policy", decision);
    }
    if (decision.action === "deny") return finish(false, "none", decision);

    if (this.yesMode) {
      const safeForYes =
        !opts.forceAsk &&
        isAutoApprovedForYes(req, this.permissions.autoApproveYes) &&
        !req.outsideWorkspace &&
        !req.sensitive &&
        decision.source !== "danger";
      if (safeForYes) {
        const allowDecision: Decision = {
          action: "allow",
          reason: "--yes auto-approved a whitelisted tool",
          source: "yes",
        };
        return finish(true, "yes", allowDecision);
      }
      const denied: Decision = {
        action: "deny",
        reason: `${decision.reason}. Non-interactive --yes mode only auto-approves the configured allowlist (${this.permissions.autoApproveYes.join(", ")}).`,
        source: decision.source,
        rule: decision.rule,
      };
      return finish(false, "none", denied);
    }

    if (!this.asker) {
      const denied: Decision = {
        action: "deny",
        reason: `${decision.reason}, but no interactive confirmation is available (stdin is not a terminal). Re-run interactively or configure an allow rule.`,
        source: decision.source,
        rule: decision.rule,
      };
      return finish(false, "none", denied);
    }

    let answer;
    try {
      answer = await withAbort(this.asker({ ...req, decision, preview: req.preview }), opts.signal);
    } catch (err) {
      const denied: Decision = {
        action: "deny",
        reason: `confirmation failed: ${err instanceof Error ? err.message : String(err)}`,
        source: decision.source,
      };
      this.logger.debug("confirmation error", { error: String(err), stack: stackOf(err) });
      if (opts.signal?.aborted) {
        return finish(false, "none", { ...decision, action: "deny", reason: "confirmation interrupted" });
      }
      return finish(false, "none", denied);
    }

    switch (answer.type) {
      case "yes":
        return finish(true, "user", decision);
      case "always": {
        const grant = grantForRequest(req, this.workspace);
        this.addGrant(grant);
        const allowed: Decision = {
          ...decision,
          action: "allow",
          reason: `allowed for this session (${grant.tool}${grant.match ? `: ${grant.match}` : ""})`,
        };
        return finish(true, "user", allowed);
      }
      case "edit": {
        const edited = answer.editedCommand?.trim();
        if (req.kind !== "exec" || !edited) {
          return finish(false, "none", { ...decision, action: "deny", reason: "edit is only supported for shell commands" });
        }
        const danger = this.permissions.dangerous.enabled
          ? detectDangerousCommand(edited, this.permissions.dangerous.extra)
          : null;
        if (danger && !this.permissions.dangerous.allow.some((entry) => edited.startsWith(entry))) {
          return finish(false, "none", {
            ...decision,
            action: "deny",
            reason: `edited command is dangerous (${danger.label}); refusing`,
          });
        }
        const newReq: PermissionRequest = {
          ...req,
          command: edited,
          input: { ...req.input, command: edited },
        };
        const reDecided = this.decide(newReq);
        if (reDecided.action === "deny") return finish(false, "none", reDecided);
        const allowed: Decision = {
          action: "allow",
          reason: "user edited and approved the command",
          source: "rule",
        };
        return finish(true, "edited", allowed, { ...req.input, command: edited });
      }
      case "no":
      default:
        return finish(false, "none", { ...decision, action: "deny", reason: "denied by user" });
    }
  }

  recordOutcome(req: PermissionRequest, ok: boolean, summary: string, durationMs: number): void {
    this.audit.record({
      event: "outcome",
      tool: req.tool,
      ok,
      summary,
      durationMs,
    });
  }
}


function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
