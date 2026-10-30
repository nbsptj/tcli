# tcli

**A coding agent that lives in your terminal.** Describe a task; tcli reads your
repository, runs commands, edits files, and verifies the result — with every
side effect visible and permissioned.

```
$ tcli "fix the failing auth tests"
› read_file   src/auth/session.ts
› bash        bun test
  ✓ 42 passed
✓ edited src/auth/session.ts  +12 -3
  verified with bun test (42 passed)
```

Built with **TypeScript + Bun**, no native TUI dependency, and a kernel that can
run headless (CI, pipes, tests) or behind the full-screen TUI.

---

## Highlights

- **Terminal-native workflow** — `tcli "task"`, `cmd | tcli "explain"`, or a
  multi-turn TUI. Streaming text, tool status, diffs and confirmations.
- **Permissioned by default** — reads are allowed; writes, shell commands and
  network calls ask. Dangerous operations (`rm -rf /`, `sudo`, force pushes,
  `curl | sh`, disk writes, fork bombs, …) are always denied to the agent.
- **Real tools** — line-numbered reads, exact-string edits with read-before-write
  and conflict detection, atomic writes, gitignore-aware glob/grep, timeouts and
  process-tree killing for shell commands.
- **Provider-agnostic** — OpenAI-compatible (OpenAI, DeepSeek, vLLM, OpenRouter,
  LM Studio, …), native Anthropic Messages API, and Ollama. Streaming tool calls,
  retries with backoff, usage and cost estimation.
- **Context that survives** — `@file`/`@dir` references with completion,
  `AGENTS.md`/`TCLI.md` injection, repository overview, automatic compaction,
  JSONL sessions, resume, checkpoints and `/undo`.
- **Extensible** — MCP servers (stdio, streamable HTTP and legacy SSE), shell
  hooks (pre/post tool, session start/end), custom Markdown slash commands and
  local TypeScript tools.
- **Auditable** — JSONL audit log of every side-effecting decision, redacted
  credentials, trace IDs and crash reports.
- **English / Chinese TUI chrome** (`ui.language`) with dark/light themes.

---

## Requirements

- [Bun](https://bun.sh) **1.2+**
- macOS 13+ or Linux (glibc/musl, WSL2). Windows native is a roadmap item; the
  headless CLI works where Bun + bash are available.
- An API key for a hosted provider, or Ollama/mock for offline use.

## Install / run

Published npm package: **`@nbsptj/tcli`** (Bun must be installed; the `tcli`
shebang runs Bun).

```bash
# global install
npm install -g @nbsptj/tcli
# or
bun add -g @nbsptj/tcli

tcli --version
tcli
```

From a clone:

```bash
bun install

# development
bun run dev                 # TUI
bun run dev "fix the tests" # single-shot

# single binary (dist/tcli)
bun run build
./dist/tcli --version
```

`package.json` exposes the `tcli` bin (the shebang runs Bun), so `bun link`
also works for local development.

## Quick start

```bash
export DEEPSEEK_API_KEY=...          # or OPENAI_API_KEY / ANTHROPIC_API_KEY
tcli init                            # project config + AGENTS.md + .gitignore
tcli                                 # interactive TUI
tcli "explain this error"            # single-shot, exits with a useful code
bun test 2>&1 | tcli "why does this fail?"
tcli --json --yes "summarize the auth flow"   # machine-readable result
```

Offline check without an API key:

```bash
tcli --provider mock --model mock "hello"
```

### Modes

| Mode | How |
| --- | --- |
| TUI | `tcli` on a TTY |
| Single-shot | `tcli "task"` (headless, inline permissions on a TTY) |
| Piped context | `cmd \| tcli "explain"` |
| Structured | `tcli --json ...`, `tcli --stream-json ...` |
| Resume | `tcli --continue` / `tcli --resume <id>` |
| Interactive with prompt | `tcli --interactive "task"` |

Exit codes: `0` success, `1` task/model failure, `2` usage/configuration error,
`130` interrupted.

---

## TUI

```
────────────────────────────────────────────────────────────────────────
  tcli 0.1.0 · deepseek/deepseek-chat · my-session-title
  ... transcript, streamed text, tool calls and diffs ...
  Plan 2/4
  ✓ read  ✓ edit  ▶ test  ○ report
────────────────────────────────────────────────────────────────────────
  › ask tcli…                                        @ file   / command
  ready · 12.3k tok · $0.0021 · plan 2/4 · sess 7f2a
  Enter send · Shift+Enter newline · Tab complete · Esc stop · Ctrl+C twice exit
```

| Key | Action |
| --- | --- |
| Enter | send |
| Shift+Enter / Ctrl+J | insert newline |
| Esc | close menu / interrupt the running turn |
| Ctrl+C | interrupt; press twice within 1.5s to exit |
| Ctrl+L | clear the view (context is kept) |
| Ctrl+D | exit when the prompt is empty |
| ↑ / ↓ | history (or menu navigation) |
| Tab | complete `@path` or `/command` |
| PgUp / PgDn | scroll transcript |
| Ctrl+U / Ctrl+K / Ctrl+W | delete to line start / end / previous word |

### Slash commands

| Command | Description |
| --- | --- |
| `/help` | commands, custom commands and keybindings |
| `/model [provider/model]` | switch model (picker when no argument) |
| `/clear` | start a fresh session and clear the view |
| `/resume [id]` | pick and restore a saved session |
| `/cost` | token usage and estimated cost |
| `/permissions` | policy, rules and session grants |
| `/undo` | roll back the last file edit checkpoint |
| `/init` | create project config + `AGENTS.md` |
| `/export` | write this session to `.tcli/exports/<id>.md` |
| `/rename <title>` | name the current session |
| `/verbose` | toggle reasoning/raw diagnostics |
| `/quit`, `/exit` | exit |

Custom commands are Markdown files in `.tcli/commands/` or
`~/.tcli/commands/`; they appear in the menu and support `$1`…`$9` and
`$ARGUMENTS`.

```markdown
---
description: Review a file for bugs
argument-hint: <file>
---
Review $1 for correctness, concurrency and error handling.
Report findings with file:line references.
```

---

## Tools

| Tool | What it does |
| --- | --- |
| `read_file` | line-numbered, paginated reads; binary/size limits; credential redaction; records a snapshot |
| `write_file` / `edit_file` | exact-string edit, unique-match enforcement, read-before-write, stale-file detection, atomic write, checkpoint |
| `glob` / `grep` | `.gitignore` + `.tcliignore`, nested ignore files, binary skipping, result caps |
| `bash` | non-interactive `bash -c`, 120s default timeout, cwd, filtered environment, process-group kill |
| `git_status` / `git_diff` | read-only git inspection (writes go through `bash` + confirmation) |
| `todo` | structured task list driving the plan panel |
| `web_fetch` / `web_search` | disabled by default; SSRF checks; results explicitly marked untrusted |
| `task` | isolated subagent with the same tools/permissions |
| `mcp__<server>__<tool>` | auto-registered MCP tools (JSON Schema validated) |
| `custom__<name>` | local custom tools (opt-in) |

All tool output is capped (2,000 lines / 50 KB by default) with an explicit
truncation marker. Every internal tool schema is defined once with Zod and
converted to JSON Schema for providers; MCP/custom schemas are validated with
Ajv.

---

## Permissions and security

Every side-effecting call goes through a **pure decision function**:

```
hard mode → dangerous command → workspace boundary → sensitive path
          → session grants → configured rules (last match wins) → defaults
```

Default policy:

| Kind | Default |
| --- | --- |
| read (`read_file`, `glob`, `grep`, `git_*`, `todo`) | allow |
| write (`write_file`, `edit_file`) | ask |
| exec (`bash`) | ask |
| network (`web_*`) | ask |
| MCP/custom | ask |

Permission modes: `default`, `read-only` (no writes/commands/network),
`workspace-write` (writes inside the workspace allowed; exec still asks).

Confirmation options: **y** allow once, **n** deny (default focus), **a** always
for this session, **e** edit the command before running. Session grants are
scoped to a command prefix / exact path / host, not “everything”.

Always denied to the agent (configurable only into a confirmation, never silent):

```
rm -rf /   rm -rf ~   rm -rf .        sudo *   su *
curl … | sh   wget … | sh             git push --force   git reset --hard   git clean -fdx
chmod -R 777   chown -R                mkfs*   dd if=* of=/dev/*   > /dev/sd*
:(){ :|:& };:                          kill -9 -1   shutdown   reboot
```

Additional protections:

- Workspace boundary is checked after **symlink resolution**; outside paths ask.
- `.env`, keys, PEMs and content containing credential patterns require
  confirmation and are redacted in output, logs and audit records.
- Writes are atomic (sibling temp file + fsync + rename).
- Tool output and web content are wrapped/marked as untrusted; the system prompt
  instructs the model never to follow instructions found inside data.
- `--yes` auto-approves **only** `permissions.autoApproveYes`; dangerous calls
  cannot be auto-approved. In a non-interactive run without `--yes`, calls that
  need confirmation are denied.
- Optional OS sandbox: `sandbox.mode = "read-only" | "workspace"` uses macOS
  `sandbox-exec` or Linux `bubblewrap`; network is off unless
  `sandbox.network=true`.
- `SE-5`/`SE-6`: audit log at `~/.tcli/audit/YYYY-MM.jsonl` contains time, tool,
  redacted args, decision, approver, reason and outcome summary.

> **Trust model:** the agent is not a sandbox by itself. Dangerous-command
> blocking and permissions reduce risk but cannot make untrusted code safe. The
> optional sandbox is defense in depth. Review diffs before approving writes and
> never put secrets in files the agent can read.

---

## Configuration

Layers (later wins):

```
defaults < ~/.tcli/config.json < .tcli/config.json < environment < CLI flags
```

Arrays concatenate (rules are evaluated in order, last match wins). Unknown keys
and invalid values produce a field-level error. `TCLI_HOME` overrides `~/.tcli`.

Common environment variables: `TCLI_PROVIDER`, `TCLI_MODEL`, `TCLI_BASE_URL`,
`TCLI_API_KEY`, `TCLI_MAX_STEPS`, `TCLI_TEMPERATURE`, `TCLI_PERMISSION_MODE`,
`TCLI_SANDBOX`, `TCLI_LOG_LEVEL`, `TCLI_THEME`, `TCLI_LANGUAGE`, `TCLI_HOME`.
Provider keys: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.

See [`docs/config.example.json`](docs/config.example.json) for a project config.
Minimal example:

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "permissions": {
    "rules": [
      { "tool": "bash", "match": "bun test*", "action": "allow" },
      { "tool": "bash", "match": "git status*", "action": "allow" }
    ]
  }
}
```

`tcli init` writes a starter config without overwriting existing files and adds
`.tcli/` to `.gitignore`. `tcli config` prints the merged config (secrets
redacted), `tcli config validate` checks it, `tcli config path` shows paths.

### Configuring the API endpoint (`baseUrl`)

The endpoint is configured **per provider** under `providers.<name>.baseUrl`,
not at the top level. It is the API root; tcli appends the protocol path
automatically. The effective value follows the normal precedence:
defaults < `~/.tcli/config.json` < `.tcli/config.json` < environment < CLI flags.

#### 1. CLI flags (temporary, no file edit)

```bash
npm run dev -- \
  --provider openai \
  --model gpt-4o-mini \
  --base-url https://api.example.com/v1 \
  --api-key sk-xxxx
```

With `npm run`, the extra `--` is required so the flags reach tcli. Without npm:

```bash
bun run src/cli.ts --provider openai --model gpt-4o-mini \
  --base-url https://api.example.com/v1 --api-key sk-xxxx
```

#### 2. Environment variables

```bash
export TCLI_PROVIDER=openai
export TCLI_MODEL=gpt-4o-mini
export TCLI_BASE_URL=https://api.example.com/v1
export OPENAI_API_KEY=sk-xxxx     # or TCLI_API_KEY=sk-xxxx
npm run dev
```

`TCLI_BASE_URL` and `TCLI_API_KEY` apply to the selected provider.

#### 3. Override a built-in provider

Edit `~/.tcli/config.json` (global) or `<repo>/.tcli/config.json` (project).
Because configuration layers deep-merge, you only need the fields you change:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "providers": {
    "openai": {
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  }
}
```

#### 4. Add a custom gateway provider

This is the recommended setup for OpenAI-compatible proxies/relays:

```json
{
  "provider": "gateway",
  "model": "gpt-4o-mini",
  "providers": {
    "gateway": {
      "type": "openai-compatible",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKeyEnv": "GATEWAY_API_KEY",
      "model": "gpt-4o-mini",
      "models": ["gpt-4o-mini", "claude-sonnet-4-20250514"],
      "timeoutMs": 120000,
      "headers": {
        "X-Organization": "my-team"
      }
    }
  }
}
```

```bash
export GATEWAY_API_KEY=sk-xxxx
npm run dev
```

Set `"apiKey": "sk-..."` instead of `apiKeyEnv` if you must keep the key in the
file — prefer environment variables so keys do not enter version control.

#### Endpoint rules by provider type

| `type` | tcli appends | Auth / notes | Typical `baseUrl` |
| --- | --- | --- | --- |
| `openai-compatible` | `/chat/completions` | `Authorization: Bearer <apiKey>` | `https://api.openai.com/v1` |
| `anthropic` | `/messages` | `x-api-key` + `anthropic-version` | `https://api.anthropic.com/v1` |
| `ollama` | `/api/chat` | no key required | `http://127.0.0.1:11434` |
| `mock` | none | offline deterministic provider | — |

Rules of thumb:

- Give the **API root** (usually ending in `/v1`). Do not append
  `/chat/completions` or `/messages` yourself; tcli adds them.
- Trailing slashes are trimmed. A full endpoint URL is accepted if it already
  ends with the protocol path, but the root form is clearer.
- An OpenAI-compatible gateway can serve Claude/Gemini/etc. models as long as the
  gateway translates them; keep `type: "openai-compatible"` in that case.
- `headers` are merged last and can override authentication headers expected by a
  non-standard gateway.
- `/model` only switches between configured provider/model pairs; it does not
  change `baseUrl`. Use config, environment or CLI flags to change the endpoint.
- `TCLI_HOME` changes the location of the global config directory.

Verify the merged configuration and the field names:

```bash
npm run dev -- config validate
npm run dev -- config path
npm run dev -- config | head -40
```

`config` prints the merged config with `apiKey` redacted. Invalid fields produce
an error with the exact path (for example `providers.gateway.baseUrl`).

### Providers

Built-in provider definitions: `deepseek`, `openai`, `anthropic`, `ollama`,
`mock`. Add or override one under `providers`:

```json
{
  "providers": {
    "local": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "LOCAL_API_KEY",
      "model": "qwen2.5-coder",
      "models": ["qwen2.5-coder"]
    },
    "anthropic": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "provider": "local",
  "model": "qwen2.5-coder"
}
```

`type` is one of `openai-compatible`, `anthropic`, `ollama`, `mock`. Per-provider
`options` can set `maxTokensParam`, `streamOptions: false`, `extraBody`,
`keepAlive`, etc. Custom `headers` support gateways.

---

## Sessions and context

- Sessions append incrementally to
  `~/.tcli/sessions/<id>.jsonl`; a crash loses at most a partial final line.
- Messages, usage, todos, file snapshots and compaction events are replayable.
- `--continue` resumes the latest session for the current workspace (falling back
  to the latest anywhere); `--resume [id]` selects one; the TUI has `/resume`.
- `tcli sessions list|export|rename|delete`.
- `/cost` shows tokens, cached tokens, estimated cost and the session path.
- `/undo` restores the content before the last edit using checkpoint backups.
- `@file` and `@dir` references are expanded with size caps and redaction;
  `@` completion is cached for responsiveness.
- `AGENTS.md` / `TCLI.md` are loaded from the git root down to the workspace and
  injected into the system prompt.
- When context approaches the model window, older turns are summarized and the
  recent turns are retained; compaction is recorded so resume rebuilds the same
  context.

---

## MCP

Add servers under `mcpServers`. Tools are auto-discovered and exposed as
`mcp__<server>__<tool>`, validated against their JSON Schema.

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {},
      "timeoutMs": 20000
    },
    "remote": {
      "enabled": true,
      "url": "http://127.0.0.1:7777/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

`transport` is `stdio` (command), `http` (streamable HTTP) or `sse` (legacy
HTTP+SSE). Broken servers are warnings, never fatal. MCP tools ask by default;
add a rule such as `{ "tool": "mcp__filesystem__read_file", "action": "allow" }`
if you want a read-only server auto-approved.

## Hooks

Shell hooks receive a JSON payload on stdin plus `TCLI_EVENT`, `TCLI_TOOL`,
`TCLI_SESSION_ID`, `TCLI_CWD`. A `preToolUse` hook can block (exit code 2 or
`{"decision":"deny"}`), request confirmation (`ask`), or replace arguments
(`input`).

```json
{
  "hooks": {
    "sessionStart": [{ "command": "echo session start >> .tcli/hooks.log" }],
    "preToolUse": [
      {
        "matcher": "bash",
        "command": "read payload; echo '{\"decision\":\"ask\",\"reason\":\"production server\"}'",
        "timeoutMs": 5000
      }
    ],
    "postToolUse": [{ "matcher": "edit_file", "command": "bun run fmt --silent" }]
  }
}
```

## Custom tools

Enable explicitly (modules execute in-process with the agent's privileges):

```json
{ "customTools": { "enabled": true } }
```

```ts
// .tcli/tools/hello.ts
export default {
  name: "hello",
  description: "Say hello",
  readOnly: true,
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args, { cwd, signal, logger }) {
    return { content: `hello ${args.name} from ${cwd}` };
  },
};
```

Tools appear as `custom__hello` and still go through the permission engine.
A Zod schema can be supplied as `parameters` instead of JSON Schema.

## Sandbox

```json
{ "sandbox": { "mode": "workspace", "network": false } }
```

- macOS: `sandbox-exec` seatbelt profile (reads allowed; writes only in the
  workspace and temp dirs; network opt-in).
- Linux: `bubblewrap` with a read-only root and workspace bind; `--unshare-net`
  unless network is enabled.
- If the backend is requested but unavailable, the command fails closed rather
  than running unsandboxed.

## Observability

- JSONL logs in `~/.tcli/logs/` (default level `info`; `debug` with
  `--verbose`).
- `--verbose` shows provider request/response and tool diagnostics.
- Every session has a trace ID; crash reports go to `~/.tcli/logs/crash-*.json`
  with the recovery path.
- Audit log in `~/.tcli/audit/` with redacted arguments.
- Telemetry is **off** by default; opt in with `telemetry.enabled` and an
  endpoint. It sends only version/OS/arch/duration/tool counts/token counts —
  never prompts, paths or output.

---

## Architecture

```text
┌──────────────────────────────┐
│ TUI / headless renderer      │  presentation only
└──────────────┬───────────────┘
               │ AgentEvent stream
┌──────────────▼───────────────┐
│ Agent core                   │  loop, budgets, compaction, cancellation
│  ├─ provider adapters        │  streaming + tool calls + retry
│  ├─ tool registry            │  Zod/Ajv validation, concurrency
│  ├─ permission engine        │  pure policy + confirmation + audit
│  ├─ context                  │  instructions, overview, refs, snapshots
│  └─ session store            │  JSONL + checkpoints
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ OS: filesystem, subprocess,  │  atomic writes, process-tree kill
│     optional sandbox         │
└──────────────────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the module map, event
flow, permission pipeline, session format and extension points.

## Development

```bash
bun install
bun run typecheck      # tsc --noEmit
bun test               # 189 tests across unit + e2e
bun test --coverage    # ~87% lines, ~81% functions (core modules > 70%)
bun run build          # dist/tcli single binary
```

Tests cover the permission policy, danger classifier, config layering, ignore
engine, tools, providers (mock SSE servers), agent loop/concurrency/abort/
compaction, sessions/checkpoints, context, MCP (stdio + HTTP), hooks, custom
extensions, UI primitives/TUI composition, and CLI end-to-end JSON/streaming.

### Publishing to npm

The package is published as **`@nbsptj/tcli`** (the unscoped `tcli` name is
already taken on npm). `package.json` already sets `publishConfig.access =
public` and the public npm registry.

```bash
# once per machine
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/

# verify package contents (must not include dist/tcli, .tcli, node_modules)
bun run typecheck && bun test
npm pack --dry-run --registry=https://registry.npmjs.org/

# publish (scoped packages must be public)
npm publish --registry=https://registry.npmjs.org/ --access public
```

Notes:

- `files` is an allowlist (`src`, `docs`, `README.md`, `LICENSE`); the 59 MB
  platform binary in `dist/` is intentionally excluded. Ship binaries through
  GitHub Releases instead.
- The default registry on some machines is a mirror (for example
  `registry.npmmirror.com`); publishing must target
  `https://registry.npmjs.org/` explicitly.
- If npm reports `EPERM` for `~/.npm/_cacache`, fix ownership or use a local
  cache: `npm --cache .npm-cache publish ...`.
- `prepublishOnly` runs `typecheck` and the full test suite.
- Bump the version (`npm version patch`) and push the tag after publishing.

## Status and limitations

Implemented: the P0/P1 scope of `docs/requirements.md`, plus most P2 work
(checkpoints, subagents, hooks, custom tools, MCP, sandbox, telemetry, basic
Chinese/English TUI chrome).

Not implemented (roadmap): image/screenshot input (CT-6), semantic code
indexing, team policy distribution, Windows-native TUI, auto-update, Web UI.
TUI chrome (welcome, status, hints, permission dialog) is localized; tool
output and built-in command descriptions remain English.
Web search via DuckDuckGo uses HTML scraping when no Brave/Tavily key is
configured and may be rate-limited. The TUI requires a POSIX terminal.

## License

MIT — see [LICENSE](LICENSE).
