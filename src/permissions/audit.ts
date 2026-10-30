import path from "node:path";
import { appendLineSync, ensureDirSync } from "../utils/fs.ts";
import { auditDir } from "../utils/paths.ts";
import { redactValue } from "../utils/redact.ts";
import type { Logger } from "../log/logger.ts";
import type { PermissionAction } from "../types.ts";

export interface AuditDecisionEntry {
  event: "decision";
  ts: string;
  traceId?: string;
  sessionId?: string;
  tool: string;
  kind: string;
  input: Record<string, unknown>;
  decision: PermissionAction;
  approvedBy: string;
  reason: string;
  durationMs?: number;
}

export interface AuditOutcomeEntry {
  event: "outcome";
  ts: string;
  traceId?: string;
  sessionId?: string;
  tool: string;
  ok: boolean;
  summary: string;
  durationMs?: number;
}

export type AuditEntry = AuditDecisionEntry | AuditOutcomeEntry;

/**
 * Append-only JSONL audit log (SE-6). Credentials are redacted before writing;
 * auditing failures are logged but never interrupt a tool call.
 */
export class AuditLog {
  readonly enabled: boolean;
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly traceId?: string;
  private readonly sessionId?: string;

  constructor(opts: {
    enabled: boolean;
    dir?: string;
    logger: Logger;
    traceId?: string;
    sessionId?: string;
  }) {
    this.enabled = opts.enabled;
    this.dir = opts.dir ? path.resolve(opts.dir) : auditDir();
    this.logger = opts.logger;
    this.traceId = opts.traceId;
    this.sessionId = opts.sessionId;
  }

  withSession(sessionId: string): AuditLog {
    return new AuditLog({
      enabled: this.enabled,
      dir: this.dir,
      logger: this.logger,
      traceId: this.traceId,
      sessionId,
    });
  }

  record(entry: Omit<AuditDecisionEntry, "ts" | "traceId" | "sessionId"> | Omit<AuditOutcomeEntry, "ts" | "traceId" | "sessionId">): void {
    if (!this.enabled) return;
    try {
      ensureDirSync(this.dir);
      const month = new Date().toISOString().slice(0, 7);
      const record = redactValue({
        ...entry,
        ts: new Date().toISOString(),
        traceId: this.traceId,
        sessionId: this.sessionId,
      });
      if (record.event === "outcome") {
        record.summary = String(record.summary).slice(0, 1000);
      }
      appendLineSync(path.join(this.dir, `${month}.jsonl`), JSON.stringify(record));
    } catch (err) {
      this.logger.warn("failed to write audit log", { error: String(err) });
    }
  }
}
