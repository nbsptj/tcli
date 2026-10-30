import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  decidePermission,
  describeRuleSuggestion,
  grantForRequest,
  grantMatches,
  isAutoApprovedForYes,
} from "../src/permissions/policy.ts";
import type { PermissionRequest, SessionGrant } from "../src/permissions/types.ts";
import { testConfig } from "./helpers.ts";

const workspace = "/tmp/ws";

function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "write_file",
    kind: "write",
    input: {},
    paths: [],
    outsideWorkspace: false,
    sensitive: false,
    ...overrides,
  };
}

describe("policy matching details", () => {
  test("path glob rules allow only matching paths", () => {
    const cfg = testConfig({
      permissions: {
        rules: [
          { tool: "write_file", match: "src/**", action: "allow" },
          { tool: "write_file", match: "src/**", action: "deny" },
          { tool: "write_file", match: "src/**", action: "allow" },
        ],
      },
    });
    expect(
      decidePermission(req({ paths: [path.join(workspace, "src/a.ts")] }), {
        permissions: cfg.permissions,
        workspace,
      }).action,
    ).toBe("allow");
    expect(
      decidePermission(req({ paths: [path.join(workspace, "docs/a.md")] }), {
        permissions: cfg.permissions,
        workspace,
      }).action,
    ).toBe("ask");
  });

  test("network rules can match the URL host", () => {
    const cfg = testConfig({
      permissions: { rules: [{ tool: "web_fetch", match: "example.com", action: "allow" }] },
    });
    const decision = decidePermission(
      req({
        tool: "web_fetch",
        kind: "network",
        input: { url: "https://example.com/page" },
        paths: [],
      }),
      { permissions: cfg.permissions, workspace },
    );
    expect(decision.action).toBe("allow");
    const other = decidePermission(
      req({ tool: "web_fetch", kind: "network", input: { url: "https://other.com" }, paths: [] }),
      { permissions: cfg.permissions, workspace },
    );
    expect(other.action).toBe("ask");
  });

  test("tool glob rules and wildcard apply", () => {
    const cfg = testConfig({ permissions: { rules: [{ tool: "mcp__*", action: "deny" }] } });
    expect(
      decidePermission(
        req({ tool: "mcp__x__read", kind: "read", paths: [] }),
        { permissions: cfg.permissions, workspace },
      ).action,
    ).toBe("deny");
  });

  test("workspaceOnly=false leaves outside reads to rules", () => {
    const cfg = testConfig({ permissions: { workspaceOnly: false } });
    expect(
      decidePermission(
        req({ tool: "read_file", kind: "read", paths: ["/etc/hosts"], outsideWorkspace: true }),
        { permissions: cfg.permissions, workspace },
      ).action,
    ).toBe("allow");
  });

  test("session grants support paths and hosts", () => {
    const grant: SessionGrant = { tool: "write_file", match: `${workspace}/a/**`, createdAt: 1 };
    expect(grantMatches(grant, req({ paths: [path.join(workspace, "a/b")] }), workspace)).toBe(true);
    expect(grantMatches(grant, req({ paths: [path.join(workspace, "b")] }), workspace)).toBe(false);

    const hostGrant: SessionGrant = { tool: "web_fetch", match: "example.com", createdAt: 1 };
    expect(
      grantMatches(
        hostGrant,
        req({ tool: "web_fetch", kind: "network", input: { url: "https://example.com/x" } }),
        workspace,
      ),
    ).toBe(true);

    const execGrant = grantForRequest(
      req({ tool: "bash", kind: "exec", command: "bun test src/x.test.ts", input: { command: "bun test src/x.test.ts" } }),
      workspace,
    );
    expect(execGrant.match).toBe("bun test");
    const pathGrant = grantForRequest(req({ paths: [path.join(workspace, "a.ts")] }), workspace);
    expect(pathGrant.match).toBe(path.join(workspace, "a.ts"));
    const host = grantForRequest(
      req({ tool: "web_fetch", kind: "network", input: { url: "https://example.com" } }),
      workspace,
    );
    expect(host.match).toBe("example.com");
  });

  test("yes allowlist and rule suggestions", () => {
    expect(isAutoApprovedForYes(req({ tool: "read_file", kind: "read" }), ["read_file"])).toBe(true);
    expect(isAutoApprovedForYes(req({ tool: "bash", kind: "exec" }), ["read_file"])).toBe(false);
    expect(
      describeRuleSuggestion(
        req({ tool: "bash", kind: "exec", command: "git commit -m x", input: { command: "git commit -m x" } }),
      ),
    ).toContain("git commit");
    expect(describeRuleSuggestion(req({ paths: [path.join(workspace, "a.ts")] }))).toContain("a.ts");
  });

  test("read-only mode allows reads and internal todo updates", () => {
    const cfg = testConfig({ permissions: { mode: "read-only" } });
    expect(
      decidePermission(
        req({ tool: "read_file", kind: "read", paths: [path.join(workspace, "a")] }),
        { permissions: cfg.permissions, workspace },
      ).action,
    ).toBe("allow");
    expect(
      decidePermission(req({ tool: "todo", kind: "read", paths: [] }), {
        permissions: cfg.permissions,
        workspace,
      }).action,
    ).toBe("allow");
  });

  test("disabled dangerous policy still asks for exec", () => {
    const cfg = testConfig({ permissions: { dangerous: { enabled: false, extra: [], allow: [] } } });
    expect(
      decidePermission(req({ tool: "bash", kind: "exec", command: "sudo ls", input: { command: "sudo ls" } }), {
        permissions: cfg.permissions,
        workspace,
      }).action,
    ).toBe("ask");
  });
});
