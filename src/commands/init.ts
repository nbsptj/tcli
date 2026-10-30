import fs from "node:fs";
import path from "node:path";
import { ensureDirSync, readFileTextSafe, writeFileAtomicSync } from "../utils/fs.ts";
import { projectConfigPath } from "../utils/paths.ts";

export interface InitResult {
  created: string[];
  skipped: string[];
  gitignoreUpdated: boolean;
  notes: string[];
}

const CONFIG_TEMPLATE = {
  provider: "deepseek",
  model: "deepseek-chat",
  permissions: {
    mode: "default",
    rules: [],
  },
};

const AGENTS_TEMPLATE = `# Project instructions

<!-- These instructions are injected into tcli's system prompt. Keep them short and concrete. -->

## Commands

- Test: \`bun test\`
- Lint/typecheck: \`bun run typecheck\`
- Build: \`bun run build\`

## Conventions

- TypeScript strict mode; avoid \`any\`.
- Keep changes small and focused.
- Run the relevant tests before reporting completion.

## Do not

- Commit or push unless explicitly asked.
- Modify generated lockfiles by hand.
`;

function isIgnoredByGitignore(cwd: string): boolean {
  const gitignore = path.join(cwd, ".gitignore");
  const text = readFileTextSafe(gitignore);
  if (text === undefined) return false;
  return /^\s*\/?\.tcli\/?\s*$/m.test(text);
}

function ensureGitignore(cwd: string): { updated: boolean; created: boolean } {
  const file = path.join(cwd, ".gitignore");
  const text = readFileTextSafe(file);
  if (text === undefined) {
    writeFileAtomicSync(file, "# tcli local state\n.tcli/\n");
    return { updated: true, created: true };
  }
  if (isIgnoredByGitignore(cwd)) return { updated: false, created: false };
  const suffix = text.endsWith("\n") ? "" : "\n";
  writeFileAtomicSync(file, `${text}${suffix}\n# tcli local state\n.tcli/\n`);
  return { updated: true, created: false };
}

/**
 * `tcli init`: create project config and AGENTS.md without overwriting existing
 * files, and make sure local `.tcli/` state is gitignored (CF-2).
 */
export function initProject(cwd: string): InitResult {
  const result: InitResult = { created: [], skipped: [], gitignoreUpdated: false, notes: [] };
  ensureDirSync(path.join(cwd, ".tcli"));

  const configFile = projectConfigPath(cwd);
  if (fs.existsSync(configFile)) {
    result.skipped.push(configFile);
  } else {
    writeFileAtomicSync(configFile, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n");
    result.created.push(configFile);
  }

  const agents = path.join(cwd, "AGENTS.md");
  if (fs.existsSync(agents)) {
    result.skipped.push(agents);
  } else {
    writeFileAtomicSync(agents, AGENTS_TEMPLATE);
    result.created.push(agents);
  }

  const gitignore = ensureGitignore(cwd);
  result.gitignoreUpdated = gitignore.updated;
  if (gitignore.created) result.created.push(path.join(cwd, ".gitignore"));
  else if (gitignore.updated) result.notes.push("Added .tcli/ to .gitignore");

  result.notes.push("Next: set DEEPSEEK_API_KEY (or edit .tcli/config.json), then run `tcli`.");
  return result;
}
