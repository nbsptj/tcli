# tcli architecture

This document describes how the pieces fit together. The requirements document
is in [`requirements.md`](requirements.md); the README covers usage.

## Design principles

1. **Kernel/UI separation.** The agent core emits an `AgentEvent` stream and
   never imports the TUI. The same kernel runs headless in tests and CI.
2. **One side-effect channel.** Filesystem, process and network access happen
   only through tools. Every tool has a Zod schema, a side-effect kind and
   permission metadata.
3. **Pure, testable policy.** `decidePermission()` has no filesystem or UI
   access; symlink/sensitive classification is computed by the engine before
   the decision.
4. **Visible state.** Tool calls, diffs, usage, todos, compaction and permission
   decisions are explicit events, persisted where recovery matters.
5. **Fail closed.** Ambiguous permissions, unavailable sandboxes, stale files,
   malformed model tool calls and non-TTY confirmations do not silently proceed.

## Module map

```
src/
  cli.ts                 argv parsing, modes, wiring, JSON output
  types.ts               provider-agnostic messages/tools/usage
  config/                Zod schema, defaults, layered merge, provider resolution
  providers/             OpenAI-compatible, Anthropic, Ollama, mock, SSE, retry
  agent/                 loop, events, prompts, hooks, subagents
  tools/                 registry + read/write/edit/glob/grep/bash/git/todo/web/task
  permissions/           danger classifier, pure policy, engine, audit, sensitive
  context/               snapshots, checkpoints, instructions, overview, refs, compression
  session/               JSONL store, replay, list, export
  mcp/                   stdio / streamable HTTP / legacy SSE clients + manager
  custom/tools.ts        local TypeScript tool modules
  commands/              init, custom Markdown slash commands
  ignore/                gitignore-compatible matcher
  sandbox/               seatbelt/bubblewrap command builders
  ui/                    ANSI, screen diffing, keys, editor, transcript, TUI, headless
  log/, telemetry/       structured logs, crash reports, opt-in telemetry
```

## Agent loop

```
run(userInput):
  expand @references, append user message
  loop:
    compact context if over budget
    provider.stream(messages + tools)
      → text/reasoning deltas
      → tool calls (JSON arguments accumulated and parsed)
    append assistant message
    check step/token/cost/timeout budgets
    if no tool calls: stop
    execute tool calls:
      phase 1 (ordered): validate → preTool hook → permission decision/confirmation
      phase 2: contiguous read-only calls in parallel (max 4);
               write/exec calls serially — results still fed back in call order
      append one tool message per call, audit outcome, postTool hook
```

Guarantees:

- Every assistant tool call receives exactly one tool message, including budget
  stops, permission denials and interrupts. This keeps resumed transcripts valid.
- Read-only calls can run concurrently, but their results are fed to the model in
  the original call order.
- `Agent.cancel()` aborts the provider stream and the current tool's signal;
  `bash` kills the child process group (`kill(-pid)` with escalation).
- A provider retry only happens before visible output. Replaying after partial
  text would duplicate content.

## Permission pipeline

```
PermissionEngine.build request
  ├─ tool.kind (read/write/exec/network)
  ├─ resolved paths, symlink-realpath workspace boundary
  ├─ sensitive path patterns + content peek (read_file)
  └─ preview (command or unified diff)
        ↓
decidePermission(request, policy, sessionGrants)   [pure]
  1. read-only mode hard deny
  2. dangerous command classifier (block; allowlist downgrades to ask)
  3. outside workspace → ask
  4. sensitive → ask
  5. session grants (command prefix/path/host)
  6. configured rules, last match wins
  7. kind defaults + workspace-write nuance
        ↓
engine.authorize()
  allow → execute
  deny  → feed denial back as tool result (no side effect)
  ask   → TUI modal / terminal prompt / --yes allowlist / deny if non-TTY
  edit  → re-classify the edited command, re-evaluate, execute only if safe
        ↓
AuditLog (JSONL, redacted) + outcome record
```

Rules match tool name globs and optional command prefixes or path/host globs.
Arrays are merged defaults < user < project, so later (project) rules win.

## Context engineering

- `AGENTS.md` / `TCLI.md` are discovered from the git root down to the cwd and
  injected into the system prompt (size capped).
- The repository overview (tree, languages, package manager, test/build/lint,
  recent files) is generated once and cached in `.tcli/cache/overview.json`.
- `@file` / `@dir` references are expanded before the message is stored; the
  expansion is workspace-confined, binary-checked, capped and redacted.
- `SnapshotStore` records the hash of every read. `write_file`/`edit_file`
  require a prior read and reject writes if the on-disk hash changed.
- `CheckpointStore` backs up content before each mutation; `/undo` restores it,
  refusing if a human changed the file afterward unless forced.
- Compaction keeps leading system/instruction messages, summarizes older turns
  with the active model (extractive fallback), retains the most recent user turns
  and a list of recently read files, and records a replayable compaction event.

## Session format

`~/.tcli/sessions/<id>.jsonl`, append-only:

```jsonl
{"type":"meta","version":1,"id":"20261031-001058-f7ec","cwd":"/repo","provider":"deepseek","model":"deepseek-chat","traceId":"trace_…","title":"Fix auth"}
{"type":"message","at":"…","message":{"role":"user","content":"…"}}
{"type":"message","at":"…","message":{"role":"assistant","content":"","toolCalls":[{"id":"call_1","name":"read_file","arguments":{"path":"a.ts"}}]}}
{"type":"message","at":"…","message":{"role":"tool","toolCallId":"call_1","toolName":"read_file","content":"…"}}
{"type":"usage","at":"…","usage":{"inputTokens":120,"outputTokens":30,"cacheReadTokens":0,"cacheWriteTokens":0}}
{"type":"snapshot","at":"…","snapshot":{"path":"/repo/a.ts","hash":"…","size":10,"mtimeMs":1,"readAt":"…"}}
{"type":"compaction","at":"…","summary":"…","keepMessages":8,"beforeTokens":50000,"afterTokens":12000}
```

On load, a malformed final line is ignored (crash safety). Compaction events are
applied in order, producing the summary system message plus the retained tail.
Sessions are resumed in place; new messages append to the same file. Checkpoint
backups live in `~/.tcli/sessions/<id>/`.

## Providers

Adapters normalize:

- messages (system/user/assistant/tool), tool calls and tool results
- streaming text, reasoning, tool-call deltas and usage
- stop reasons and HTTP/SSE errors

`streamWithRetry` retries 429/5xx/network errors with exponential backoff and
honors `Retry-After`, but only before output is committed. Malformed tool-call
JSON is repaired conservatively (fences/trailing commas); if repair fails it is
a retryable provider error rather than executing bad input.

## Extensions

- **MCP:** stdio JSON-RPC, streamable HTTP (POST JSON/SSE, session headers) and
  legacy HTTP+SSE. Tools are discovered, schema-validated with Ajv, namespaced
  `mcp__server__tool`, and default to ask.
- **Hooks:** shell commands with JSON stdin and TCLI_* env. preToolUse can deny,
  ask or modify args; postToolUse can format/lint after edits.
- **Custom commands:** Markdown with optional frontmatter, `$ARGUMENTS`, `$1..$9`.
- **Custom tools:** opt-in TypeScript modules, JSON Schema or Zod parameters,
  permissioned like built-in tools.
- **Sandbox:** command wrappers for macOS seatbelt / Linux bubblewrap.

## Failure behavior

| Situation | Behavior |
| --- | --- |
| provider 5xx/429 | bounded backoff; clear error if retries exhaust |
| malformed tool JSON | retryable provider error; never execute |
| tool throws | error message returned as tool result; loop continues |
| permission denied | no side effect; denial fed to model; audited |
| non-TTY confirmation | deny with an actionable reason |
| stale file | refuse write; ask the model to re-read |
| interrupt/timeout | process tree killed; session remains resumable |
| crash during append | partial JSONL line ignored on resume; crash log path printed |
| MCP server down | warning; remaining tools still available |
| sandbox unavailable | fail closed (no unsandboxed fallback) |
