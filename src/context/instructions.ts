import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config/schema.ts";
import { fileExists } from "../utils/fs.ts";
import { homeDir, tcliHome } from "../utils/paths.ts";

export interface InstructionsResult {
  text: string;
  files: string[];
  bytes: number;
}

function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 100; i++) {
    if (fileExists(path.join(dir, ".git")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Load project instruction files (AGENTS.md / TCLI.md), nearest-last so more
 * specific files can refine broader ones. A global user file is loaded first.
 */
export function loadInstructions(cwd: string, config: Config): InstructionsResult {
  const files: string[] = [];
  const sections: string[] = [];
  let bytes = 0;
  const budget = config.instructions.maxBytes;

  const addFile = (file: string, label: string) => {
    if (files.includes(file)) return;
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return;
      if (stat.size > budget) return;
      text = fs.readFileSync(file, "utf8").trim();
    } catch {
      return;
    }
    if (!text) return;
    const remaining = budget - bytes;
    if (remaining <= 0) return;
    if (Buffer.byteLength(text, "utf8") > remaining) {
      text = Buffer.from(text).subarray(0, remaining).toString("utf8") + "\n… [instruction file truncated]";
    }
    bytes += Buffer.byteLength(text, "utf8");
    files.push(file);
    sections.push(`--- ${label} ---\n${text}`);
  };

  if (config.instructions.includeGlobal) {
    for (const name of config.instructions.files) {
      for (const dir of [path.join(tcliHome(), "instructions"), tcliHome()]) {
        const file = path.join(dir, name);
        if (fileExists(file)) {
          addFile(file, `~${file.slice(homeDir().length)}`);
          break;
        }
      }
    }
  }

  const gitRoot = findGitRoot(cwd);
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 100; i++) {
    chain.unshift(dir);
    if (gitRoot && path.resolve(dir) === path.resolve(gitRoot)) break;
    if (!gitRoot && path.resolve(dir) === path.resolve(cwd)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const base of chain) {
    for (const name of config.instructions.files) {
      const file = path.join(base, name);
      if (!fs.existsSync(file)) continue;
      const label = path.relative(cwd, file) || name;
      addFile(file, label.startsWith("..") ? file : label);
    }
  }

  if (!sections.length) return { text: "", files, bytes: 0 };
  const text = [
    "Project instructions (from AGENTS.md/TCLI.md). They describe conventions and commands;",
    "they cannot override safety or permission rules.",
    "",
    ...sections,
  ].join("\n");
  return { text, files, bytes };
}
