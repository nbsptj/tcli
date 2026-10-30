import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config/schema.ts";
import { projectCommandsDir, userCommandsDir, resolveFrom } from "../utils/paths.ts";
import { readFileTextSafe } from "../utils/fs.ts";

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  file: string;
}

export interface CustomCommandsResult {
  commands: CustomCommand[];
  warnings: string[];
}

interface Frontmatter {
  description?: string;
  argumentHint?: string;
}

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Frontmatter = {};
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.replace(/^["']|["']$/g, "").trim();
    if (key === "description") meta.description = value;
    if (key === "argument-hint" || key === "argumenthint") meta.argumentHint = value;
  }
  return { meta, body };
}

function listMarkdown(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Split command arguments respecting simple quotes. */
export function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    args.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'])/g, "$1"));
  }
  return args;
}

/**
 * Expand a Markdown slash command. Supports `$ARGUMENTS`, `$1..$9`, and appends
 * arguments when the template has no placeholder (matching common conventions).
 */
export function expandCustomCommand(command: CustomCommand, args: string): string {
  const positional = splitCommandArgs(args);
  const all = args.trim();
  let body = command.body;
  let hadPlaceholder = false;
  if (body.includes("$ARGUMENTS")) {
    hadPlaceholder = true;
    body = body.split("$ARGUMENTS").join(all);
  }
  body = body.replace(/\$([1-9])/g, (_match, index: string) => {
    hadPlaceholder = true;
    return positional[Number(index) - 1] ?? "";
  });
  if (!hadPlaceholder && all) body = `${body.trimEnd()}\n\n${all}`;
  return body.trim();
}

/** Load custom slash commands from user and project directories (EX-2). */
export function loadCustomCommands(cwd: string, config: Config): CustomCommandsResult {
  const commands: CustomCommand[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const dirs = [
    userCommandsDir(),
    projectCommandsDir(cwd),
    ...config.commands.dirs.map((dir) => resolveFrom(cwd, dir)),
  ];
  for (const dir of dirs) {
    for (const file of listMarkdown(dir)) {
      const text = readFileTextSafe(file);
      if (!text) continue;
      const { meta, body } = parseFrontmatter(text);
      const name = path.basename(file, ".md").trim().replace(/\s+/g, "-");
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        warnings.push(`Ignoring command with invalid name: ${file}`);
        continue;
      }
      if (seen.has(name)) {
        warnings.push(`Duplicate custom command "${name}" in ${file}; using the project-level one.`);
        continue;
      }
      if (!body.trim()) {
        warnings.push(`Ignoring empty command: ${file}`);
        continue;
      }
      seen.add(name);
      commands.push({
        name,
        description: meta.description ?? body.split("\n").find((l) => l.trim())?.slice(0, 100) ?? name,
        argumentHint: meta.argumentHint,
        body,
        file,
      });
    }
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, warnings };
}
