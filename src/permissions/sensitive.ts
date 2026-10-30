import path from "node:path";
import { matchGlob } from "../utils/glob.ts";
import { toPosix } from "../utils/paths.ts";

export interface SensitiveResult {
  sensitive: boolean;
  reasons: string[];
}

/** Path-based credential detection (content is checked separately by tools). */
export function classifySensitivePath(absPath: string, workspace: string, patterns: string[]): SensitiveResult {
  const rel = toPosix(path.relative(workspace, absPath));
  const abs = toPosix(absPath);
  const base = path.basename(absPath);
  const reasons: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\\/g, "/");
    if (!pattern) continue;
    const hasSlash = pattern.includes("/");
    let matched = false;
    if (hasSlash) {
      const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern;
      matched =
        matchGlob(anchored, rel, { basename: true }) ||
        matchGlob(pattern, abs, { basename: true }) ||
        matchGlob(`**/${anchored}`, abs);
    } else {
      matched = matchGlob(pattern, base);
      if (!matched) matched = matchGlob(pattern, rel, { basename: true });
    }
    if (matched) reasons.push(`matched sensitive pattern "${raw}"`);
  }
  return { sensitive: reasons.length > 0, reasons };
}

/** Trivial helper for content-level checks used by read_file permission info. */
export function classifySensitiveContent(text: string): SensitiveResult {
  const reasons: string[] = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) reasons.push("private key material");
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) reasons.push("AWS access key");
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text)) reasons.push("API key");
  return { sensitive: reasons.length > 0, reasons };
}
