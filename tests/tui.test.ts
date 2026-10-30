import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Tui } from "../src/ui/tui.ts";
import type { ConfirmationRequest } from "../src/permissions/types.ts";
import { cleanup, createAgentHarness, makeRepo, testConfig, testLogger, tempDir } from "./helpers.ts";
import { SessionStore } from "../src/session/store.ts";
import { PathCompleter } from "../src/context/references.ts";

let home = "";
const originalHome = process.env.TCLI_HOME;

beforeEach(() => {
  home = tempDir("tcli-tui-home-");
  process.env.TCLI_HOME = home;
});

afterEach(() => {
  cleanup(home);
  if (originalHome === undefined) delete process.env.TCLI_HOME;
  else process.env.TCLI_HOME = originalHome;
});

function createTui(files: Record<string, string> = {}) {
  const harness = createAgentHarness({ scripts: [], files });
  const config = testConfig();
  const tui = new Tui({
    agent: harness.agent,
    config,
    permissions: harness.permissions,
    session: harness.session,
    workspace: harness.dir,
    colorMode: "none",
    theme: "dark",
    logger: testLogger(),
    warnings: ["test warning"],
    customCommands: [
      {
        name: "polish",
        description: "Polish code",
        argumentHint: "<path>",
        body: "Polish $1",
        file: "/tmp/polish.md",
      },
    ],
    pathCompleter: new PathCompleter(harness.dir),
    createAgent: () => harness.agent,
    write: () => {},
  });
  (tui as unknown as { seedTranscript: () => void }).seedTranscript();
  (tui as unknown as { screen: { setSize: (w: number, h: number) => void } }).screen.setSize(100, 30);
  return { tui, harness };
}

function frame(tui: Tui): string {
  const composed = (
    tui as unknown as { compose: () => { lines: Array<Array<{ text: string }>> } }
  ).compose();
  return composed.lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

describe("TUI model", () => {
  test("welcome frame contains header, input and status", () => {
    const { tui, harness } = createTui({ "a.ts": "export {};\n" });
    try {
      const text = frame(tui);
      expect(text).toContain("tcli");
      expect(text).toContain("› ");
      expect(text).toContain("ready");
      expect(text).toContain("sess");
      expect(text).toContain("test warning");
      expect(text).toContain("Permissions:");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("typing updates the editor and path completion menu", () => {
    const { tui, harness } = createTui({ "src/a.ts": "", "src/b.ts": "" });
    try {
      const handle = (tui as unknown as { handleKey: (key: unknown) => void }).handleKey.bind(tui);
      handle({ type: "char", char: "h" });
      handle({ type: "char", char: "i" });
      expect((tui as unknown as { editor: { text: string } }).editor.text).toBe("hi");
      handle({ type: "newline" });
      handle({ type: "char", char: "x" });
      expect((tui as unknown as { editor: { text: string } }).editor.text).toBe("hi\nx");
      handle({ type: "backspace" });
      handle({ type: "char", char: "@" });
      handle({ type: "char", char: "s" });
      const menu = (tui as unknown as { menu?: { items: Array<{ label: string }> } }).menu;
      expect(menu).toBeDefined();
      expect(menu!.items.some((item) => item.label.includes("src/"))).toBe(true);
      expect(frame(tui)).toContain("@");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("permission modal renders and can be denied by default", async () => {
    const { tui, harness } = createTui();
    try {
      const request: ConfirmationRequest = {
        tool: "bash",
        kind: "exec",
        input: { command: "npm test" },
        command: "npm test",
        paths: [],
        outsideWorkspace: false,
        sensitive: false,
        preview: "$ npm test\n\nExit: ask",
        decision: { action: "ask", reason: "exec tool requires confirmation", source: "default" },
      };
      const promise = (tui as unknown as { askPermission: (r: ConfirmationRequest) => Promise<unknown> }).askPermission(request);
      const text = frame(tui);
      expect(text).toContain("Permission required");
      expect(text).toContain("npm test");
      expect(text).toContain("[n] deny");
      expect(text).toContain("[e] edit command");
      (tui as unknown as { finishConfirm: (a: unknown) => void }).finishConfirm({ type: "no" });
      expect(await promise).toEqual({ type: "no" });
      expect(frame(tui)).not.toContain("Permission required");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("picker modal selects an item", async () => {
    const { tui, harness } = createTui();
    try {
      const promise = (
        tui as unknown as { picker: (title: string, items: unknown[]) => Promise<{ label: string } | undefined> }
      ).picker("Select model", [{ label: "a/model" }, { label: "b/model" }]);
      expect(frame(tui)).toContain("Select model");
      const handleModal = (tui as unknown as { handleModalKey: (key: unknown) => void }).handleModalKey.bind(tui);
      handleModal({ type: "down" });
      handleModal({ type: "enter" });
      const selected = await promise;
      expect(selected?.label).toBe("b/model");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("slash commands help, rename, cost and permissions", async () => {
    const { tui, harness } = createTui();
    try {
      const execute = (tui as unknown as { executeCommand: (line: string) => Promise<void> }).executeCommand.bind(tui);
      await execute("/help");
      expect(frame(tui)).toContain("Commands");
      await execute("/rename My session");
      expect(harness.session.meta.title).toBe("My session");
      expect(frame(tui)).toContain('Session renamed to "My session"');
      await execute("/cost");
      expect(frame(tui)).toContain("Estimated cost");
      await execute("/permissions");
      expect(frame(tui)).toContain("Rules (last match wins)");
      await execute("/doesnotexist");
      expect(frame(tui)).toContain("Unknown command");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("todo panel and scroll state", () => {
    const { tui, harness } = createTui();
    try {
      (tui as unknown as { todos: unknown[] }).todos = [
        { content: "first step", status: "completed" },
        { content: "second step", status: "in_progress" },
      ];
      const text = frame(tui);
      expect(text).toContain("Plan 1/2");
      expect(text).toContain("second step");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("Chinese language localizes core chrome", () => {
    const harness = createAgentHarness({ scripts: [] });
    try {
      const tui = new Tui({
        agent: harness.agent,
        config: testConfig({ ui: { language: "zh", color: "auto", theme: "dark", scrollbackLines: 5000 } }),
        permissions: harness.permissions,
        session: harness.session,
        workspace: harness.dir,
        colorMode: "none",
        theme: "dark",
        logger: testLogger(),
        warnings: [],
        customCommands: [],
        createAgent: () => harness.agent,
        write: () => {},
      });
      (tui as unknown as { seedTranscript: () => void }).seedTranscript();
      (tui as unknown as { screen: { setSize: (w: number, h: number) => void } }).screen.setSize(100, 30);
      const text = frame(tui);
      expect(text).toContain("工作区");
      expect(text).toContain("就绪");
      expect(text).toContain("Enter 发送");
    } finally {
      cleanup(harness.dir);
    }
  });

  test("small terminal still composes", () => {
    const { tui, harness } = createTui();
    try {
      (tui as unknown as { screen: { setSize: (w: number, h: number) => void } }).screen.setSize(30, 8);
      const text = frame(tui);
      expect(text).toContain("tcli");
      expect(text.length).toBeGreaterThan(0);
      (tui as unknown as { screen: { setSize: (w: number, h: number) => void } }).screen.setSize(19, 4);
      expect(() => frame(tui)).not.toThrow();
    } finally {
      cleanup(harness.dir);
    }
  });
});
