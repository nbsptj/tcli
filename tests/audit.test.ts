import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AuditLog } from "../src/permissions/audit.ts";
import { PermissionEngine } from "../src/permissions/engine.ts";
import type { PermissionRequest } from "../src/permissions/types.ts";
import { cleanup, makeRepo, tempDir, testConfig, testLogger } from "./helpers.ts";

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "write_file",
    kind: "write",
    input: { path: "a.txt", content: "OPENAI_API_KEY=sk-abcdefghijklmnop" },
    paths: [],
    outsideWorkspace: false,
    sensitive: false,
    ...overrides,
  };
}

describe("audit log", () => {
  test("records decisions and outcomes with redacted arguments", async () => {
    const dir = makeRepo({});
    const auditDir = tempDir("tcli-audit-");
    try {
      const config = testConfig({ permissions: { mode: "workspace-write" } });
      const audit = new AuditLog({
        enabled: true,
        dir: auditDir,
        logger: testLogger(),
        traceId: "trace_1",
        sessionId: "session_1",
      });
      const engine = new PermissionEngine({
        permissions: config.permissions,
        workspace: dir,
        audit,
        logger: testLogger(),
      });
      const req = request({ paths: [path.join(dir, "a.txt")] });
      const result = await engine.authorize(req);
      expect(result.allowed).toBe(true);
      engine.recordOutcome(req, true, "wrote a.txt", 12);
      const files = fs.readdirSync(auditDir);
      expect(files.length).toBe(1);
      const lines = fs.readFileSync(path.join(auditDir, files[0]!), "utf8").trim().split("\n");
      const entries = lines.map((line) => JSON.parse(line));
      expect(entries.length).toBe(2);
      expect(entries[0].event).toBe("decision");
      expect(entries[0].tool).toBe("write_file");
      expect(entries[0].decision).toBe("allow");
      expect(entries[0].traceId).toBe("trace_1");
      expect(entries[0].sessionId).toBe("session_1");
      expect(JSON.stringify(entries[0].input)).not.toContain("sk-abcdefghijklmnop");
      expect(entries[1].event).toBe("outcome");
      expect(entries[1].summary).toContain("wrote a.txt");
    } finally {
      cleanup(dir);
      cleanup(auditDir);
    }
  });

  test("dangerous commands are audited as denied", async () => {
    const dir = makeRepo({});
    const auditDir = tempDir("tcli-audit-");
    try {
      const config = testConfig();
      const audit = new AuditLog({ enabled: true, dir: auditDir, logger: testLogger(), traceId: "t" });
      const engine = new PermissionEngine({
        permissions: config.permissions,
        workspace: dir,
        audit,
        logger: testLogger(),
      });
      const req = request({
        tool: "bash",
        kind: "exec",
        command: "rm -rf /",
        input: { command: "rm -rf /" },
      });
      const result = await engine.authorize(req);
      expect(result.allowed).toBe(false);
      expect(result.decision.source).toBe("danger");
      const file = path.join(auditDir, fs.readdirSync(auditDir)[0]!);
      const entry = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n")[0]!);
      expect(entry.decision).toBe("deny");
      expect(entry.reason).toContain("dangerous");
    } finally {
      cleanup(dir);
      cleanup(auditDir);
    }
  });
});
