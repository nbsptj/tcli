import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { cleanup, makeRepo, runCli, startFakeOpenAi, tempDir } from "./helpers.ts";

const homes: string[] = [];
const repos: string[] = [];

function home(): string {
  const dir = tempDir("tcli-cli-home-");
  homes.push(dir);
  return dir;
}

function repo(files: Record<string, string> = {}): string {
  const dir = makeRepo(files);
  repos.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) cleanup(dir);
  for (const dir of repos.splice(0)) cleanup(dir);
});

const fakeArgs = (baseUrl: string): string[] => [
  "--provider",
  "openai",
  "--model",
  "fake-model",
  "--base-url",
  baseUrl,
  "--api-key",
  "test-key",
];

describe("CLI headless", () => {
  test("runs a tool loop and emits structured JSON", async () => {
    const fake = startFakeOpenAi([
      { toolCalls: [{ name: "read_file", arguments: { path: "a.txt" } }], finish: "tool_calls" },
      { text: "The file is fine.", usage: { input: 30, output: 8 } },
    ]);
    const dir = repo({ "a.txt": "hello from file\n" });
    try {
      const result = await runCli([...fakeArgs(fake.baseUrl), "--yes", "--json", "read a.txt"], {
        cwd: dir,
        home: home(),
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(true);
      expect(payload.text).toBe("The file is fine.");
      expect(payload.provider).toBe("openai");
      expect(payload.model).toBe("fake-model");
      expect(payload.toolCalls.length).toBe(1);
      expect(payload.toolCalls[0].name).toBe("read_file");
      expect(payload.toolCalls[0].ok).toBe(true);
      expect(payload.toolCalls[0].denied).toBe(false);
      expect(fake.requests.length).toBe(2);
      const secondMessages = (fake.requests[1] as { messages: Array<{ role: string; content: string }> }).messages;
      const toolMessage = secondMessages.find((m) => m.role === "tool")!;
      expect(toolMessage.content).toContain("hello from file");
    } finally {
      fake.close();
    }
  });

  test("pipes stdin as context", async () => {
    const fake = startFakeOpenAi([{ text: "explained" }]);
    const dir = repo({});
    try {
      const result = await runCli([...fakeArgs(fake.baseUrl), "--json", "explain this"], {
        cwd: dir,
        home: home(),
        stdin: "TypeError: boom\nat line 1",
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(true);
      const messages = (fake.requests[0] as { messages: Array<{ role: string; content: string }> }).messages;
      const user = messages.find((m) => m.role === "user")!;
      expect(user.content).toContain("explain this");
      expect(user.content).toContain("<stdin-context>");
      expect(user.content).toContain("TypeError: boom");
    } finally {
      fake.close();
    }
  });

  test("--yes denies non-whitelisted writes and reports the denial", async () => {
    const fake = startFakeOpenAi([
      { toolCalls: [{ name: "write_file", arguments: { path: "created.txt", content: "nope" } }], finish: "tool_calls" },
      { text: "I could not write it." },
    ]);
    const dir = repo({});
    try {
      const result = await runCli([...fakeArgs(fake.baseUrl), "--yes", "--json", "write a file"], {
        cwd: dir,
        home: home(),
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.toolCalls[0].denied).toBe(true);
      expect(payload.permissionDenials).toBe(1);
      expect(fs.existsSync(path.join(dir, "created.txt"))).toBe(false);
    } finally {
      fake.close();
    }
  });

  test("workspace-write mode allows a file write without prompting", async () => {
    const fake = startFakeOpenAi([
      { toolCalls: [{ name: "write_file", arguments: { path: "created.txt", content: "yes" } }], finish: "tool_calls" },
      { text: "written" },
    ]);
    const dir = repo({});
    try {
      const result = await runCli(
        [...fakeArgs(fake.baseUrl), "--permission-mode", "workspace-write", "--json", "write a file"],
        { cwd: dir, home: home() },
      );
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.toolCalls[0].ok).toBe(true);
      expect(fs.readFileSync(path.join(dir, "created.txt"), "utf8")).toBe("yes");
    } finally {
      fake.close();
    }
  });

  test("--stream-json emits NDJSON events and a result", async () => {
    const fake = startFakeOpenAi([{ text: "streamed answer" }]);
    const dir = repo({});
    try {
      const result = await runCli([...fakeArgs(fake.baseUrl), "--stream-json", "hello"], {
        cwd: dir,
        home: home(),
      });
      expect(result.code).toBe(0);
      const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.some((e) => e.type === "text")).toBe(true);
      const final = lines.at(-1)!;
      expect(final.type).toBe("result");
      expect(final.ok).toBe(true);
      expect(final.text).toBe("streamed answer");
      const text = lines.filter((e) => e.type === "text").map((e) => e.text).join("");
      expect(text).toBe("streamed answer");
    } finally {
      fake.close();
    }
  });

  test("config errors are returned as JSON when --json is used", async () => {
    const result = await runCli(["--provider", "nope", "--json", "hi"], {
      cwd: repo({}),
      home: home(),
    });
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Unknown provider");
  });

  test("missing prompt is a usage error", async () => {
    const result = await runCli(["--json"], { cwd: repo({}), home: home() });
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("No prompt");
  });
});

describe("CLI sessions", () => {
  test("--continue and --resume reuse a session", async () => {
    const h = home();
    const dir = repo({});
    const first = await runCli(["--provider", "mock", "--model", "mock", "--json", "first task"], {
      cwd: dir,
      home: h,
    });
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    const second = await runCli(["--provider", "mock", "--model", "mock", "--continue", "--json", "second task"], {
      cwd: dir,
      home: h,
    });
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload.sessionId).toBe(firstPayload.sessionId);
    expect(secondPayload.ok).toBe(true);
    const third = await runCli(
      ["--provider", "mock", "--model", "mock", "--resume", firstPayload.sessionId, "--json", "third"],
      { cwd: dir, home: h },
    );
    expect(JSON.parse(third.stdout).sessionId).toBe(firstPayload.sessionId);
  });

  test("lists and exports sessions as Markdown", async () => {
    const h = home();
    const dir = repo({});
    const run = await runCli(["--provider", "mock", "--model", "mock", "--json", "export me"], {
      cwd: dir,
      home: h,
    });
    const id = JSON.parse(run.stdout).sessionId;
    const list = await runCli(["sessions", "list"], { cwd: dir, home: h });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
    const exported = await runCli(["sessions", "export", id, "--out", "-"], { cwd: dir, home: h });
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain("# export me");
    expect(exported.stdout).toContain("Mock provider");
  });

  test("renames a session", async () => {
    const h = home();
    const dir = repo({});
    const run = await runCli(["--provider", "mock", "--model", "mock", "--json", "rename me"], {
      cwd: dir,
      home: h,
    });
    const id = JSON.parse(run.stdout).sessionId;
    const renamed = await runCli(["sessions", "rename", id, "Better", "Title"], { cwd: dir, home: h });
    expect(renamed.code).toBe(0);
    const list = await runCli(["sessions", "list"], { cwd: dir, home: h });
    expect(list.stdout).toContain("Better Title");
    const exported = await runCli(["sessions", "export", id, "--out", "-"], { cwd: dir, home: h });
    expect(exported.stdout).toContain("# Better Title");
  });

  test("deletes a session with --yes", async () => {
    const h = home();
    const dir = repo({});
    const run = await runCli(["--provider", "mock", "--model", "mock", "--json", "delete me"], {
      cwd: dir,
      home: h,
    });
    const id = JSON.parse(run.stdout).sessionId;
    const deleted = await runCli(["sessions", "delete", id, "--yes"], { cwd: dir, home: h });
    expect(deleted.code).toBe(0);
    const list = await runCli(["sessions", "list"], { cwd: dir, home: h });
    expect(list.stdout).not.toContain(id);
  });
});

describe("CLI init/config", () => {
  test("init creates project files and config validates", async () => {
    const dir = repo({});
    const h = home();
    const init = await runCli(["init"], { cwd: dir, home: h });
    expect(init.code).toBe(0);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".tcli", "config.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".tcli/");
    const validate = await runCli(["config", "validate"], { cwd: dir, home: h });
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("Configuration valid");
    const show = await runCli(["config"], { cwd: dir, home: h });
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout).provider).toBe("deepseek");
  });
});
