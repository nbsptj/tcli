/**
 * Dangerous command classification.
 *
 * This is intentionally a denylist of catastrophic operations, not a sandbox.
 * The agent never executes a denied command on the user's behalf; the user can
 * copy it and run it manually.
 */

export interface DangerMatch {
  label: string;
  detail: string;
  /** The command fragment that triggered the rule. */
  fragment: string;
}

interface Segment {
  text: string;
  first: string;
  args: string[];
}

function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n|\r|\|)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment))) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}

function normalizeSegment(segment: string): Segment {
  let text = segment.trim().replace(/^[({!]\s*/, "");
  let tokens = tokenize(text);
  // Strip leading environment assignments and wrappers, but never sudo/su.
  for (let i = 0; i < 8; i++) {
    const first = tokens[0];
    if (!first) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      tokens.shift();
      continue;
    }
    if (["command", "builtin", "exec", "time", "nohup"].includes(first)) {
      tokens.shift();
      continue;
    }
    if (first === "env") {
      tokens.shift();
      while (tokens[0]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift();
      continue;
    }
  }
  text = tokens.join(" ");
  return { text, first: tokens[0] ?? "", args: tokens.slice(1) };
}

const PROTECTED_ROOTS = new Set([
  "/",
  "/usr",
  "/etc",
  "/var",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/System",
  "/Library",
  "/Applications",
  "/Users",
  "/home",
  "/root",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
]);

function isDangerousRmTarget(target: string): boolean {
  const t = target.trim();
  if (!t) return false;
  const cleaned = t.replace(/^["']|["']$/g, "");
  if (["/", ".", "..", "~", "~", "$HOME", "${HOME}", "*", "/*", "./*", "~/*", "~/", ".", ".*"].includes(cleaned)) {
    return true;
  }
  if (cleaned.startsWith("~/") && cleaned === "~/") return true;
  if (/^\$\{?HOME\}?(?:\/?\*?)?$/.test(cleaned)) return true;
  if (PROTECTED_ROOTS.has(cleaned.replace(/\/+$/, ""))) return true;
  return false;
}

function checkRm(seg: Segment): DangerMatch | null {
  if (seg.first !== "rm") return null;
  const flags = seg.args.filter((a) => a.startsWith("-"));
  const targets = seg.args.filter((a) => !a.startsWith("-"));
  const recursive = flags.some((f) => f === "--recursive" || /^-[^-]*[rR]/.test(f));
  const force = flags.some((f) => f === "--force" || /^-[^-]*f/.test(f));
  if (!recursive && !force) return null;
  for (const target of targets) {
    if (!isDangerousRmTarget(target)) continue;
    return {
      label: "recursive delete of a protected path",
      detail: `rm with ${recursive ? "recursive" : ""}${force ? " force" : ""} on "${target}"`,
      fragment: seg.text,
    };
  }
  return null;
}

function checkGit(seg: Segment): DangerMatch | null {
  if (seg.first !== "git") return null;
  const sub = seg.args[0];
  const rest = seg.args.slice(1);
  if (sub === "push") {
    if (rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease"))) {
      return { label: "git force push", detail: "force pushing rewrites remote history", fragment: seg.text };
    }
  }
  if (sub === "reset" && rest.includes("--hard")) {
    return { label: "git hard reset", detail: "discards uncommitted work irreversibly", fragment: seg.text };
  }
  if (sub === "clean") {
    const force = rest.some((a) => a === "--force" || /^-[^-]*f/.test(a));
    const aggressive = rest.some((a) => /^-[^-]*[xd]/.test(a) || a === "--delete");
    if (force && aggressive) {
      return { label: "git clean -fdx", detail: "removes untracked and ignored files", fragment: seg.text };
    }
    if (force) {
      return { label: "git clean force", detail: "removes untracked files", fragment: seg.text };
    }
  }
  return null;
}

function checkChmod(seg: Segment): DangerMatch | null {
  if (seg.first !== "chmod" && seg.first !== "chown") return null;
  const recursive = seg.args.some((a) => a === "--recursive" || /^-[^-]*R/.test(a));
  if (!recursive) return null;
  if (seg.first === "chown") {
    return { label: "recursive chown", detail: "recursively changes file ownership", fragment: seg.text };
  }
  if (seg.args.some((a) => /^(?:0?777|a\+rwx|ugo\+rwx)$/.test(a))) {
    return { label: "recursive chmod 777", detail: "makes files world-writable", fragment: seg.text };
  }
  return null;
}

function checkDd(seg: Segment): DangerMatch | null {
  if (seg.first !== "dd") return null;
  if (seg.args.some((a) => /^of=\/dev\/(?:sd|nvme|disk|hd|vd)/i.test(a))) {
    return { label: "raw disk write", detail: "dd writing to a block device", fragment: seg.text };
  }
  return null;
}

function checkKill(seg: Segment): DangerMatch | null {
  if (seg.first !== "kill") return null;
  const joined = seg.args.join(" ");
  if (/(?:^|\s)(?:-9|--signal[= ]?9|-KILL)(?:\s|$)/.test(joined) && /(?:^|\s)-1(?:\s|$)/.test(joined)) {
    return { label: "kill all processes", detail: "kill -9 -1 targets every process", fragment: seg.text };
  }
  return null;
}

function checkSystem(seg: Segment): DangerMatch | null {
  if (["shutdown", "reboot", "halt", "poweroff"].includes(seg.first)) {
    return { label: "system shutdown", detail: "shuts down or reboots the machine", fragment: seg.text };
  }
  if (seg.first === "sudo" || seg.first === "su") {
    return { label: "privilege escalation", detail: "runs with elevated privileges", fragment: seg.text };
  }
  if (seg.first === "mkfs" || seg.first.startsWith("mkfs.")) {
    return { label: "filesystem format", detail: "formats a filesystem", fragment: seg.text };
  }
  return null;
}

function checkPipes(command: string): DangerMatch | null {
  if (/\b(?:curl|wget|fetch)\b[\s\S]{0,2000}?\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i.test(command)) {
    return {
      label: "pipe remote script to shell",
      detail: "downloads and executes a remote script",
      fragment: command.slice(0, 300),
    };
  }
  if (/>\s*\/dev\/(?:sd|nvme|disk|hd|vd)[a-z0-9]*/i.test(command)) {
    return {
      label: "raw device redirection",
      detail: "redirects output directly to a block device",
      fragment: command.slice(0, 300),
    };
  }
  return null;
}

function checkForkBomb(command: string): DangerMatch | null {
  const normalized = command.replace(/\s+/g, "").replace(/^["']|["']$/g, "");
  if (normalized.includes(":(){:|:&};:")) {
    return { label: "fork bomb", detail: "exhausts process table", fragment: command.slice(0, 120) };
  }
  return null;
}

export function detectDangerousCommand(
  command: string,
  extraPatterns: string[] = [],
): DangerMatch | null {
  const raw = (command ?? "").trim();
  if (!raw) return null;

  const fork = checkForkBomb(raw);
  if (fork) return fork;
  const pipe = checkPipes(raw);
  if (pipe) return pipe;

  for (const segmentText of splitSegments(raw)) {
    const seg = normalizeSegment(segmentText);
    const checks = [checkSystem(seg), checkRm(seg), checkGit(seg), checkChmod(seg), checkDd(seg), checkKill(seg)];
    for (const match of checks) if (match) return match;
  }

  for (const pattern of extraPatterns) {
    if (!pattern) continue;
    try {
      const re = new RegExp(pattern, "i");
      const m = re.exec(raw);
      if (m) {
        return {
          label: "custom dangerous pattern",
          detail: `matched configured pattern ${pattern}`,
          fragment: m[0].slice(0, 200),
        };
      }
    } catch {
      /* invalid user regex is ignored (config validation reports separately) */
    }
  }
  return null;
}

/** Human-readable list of built-in dangerous operations, used by /permissions. */
export const DANGEROUS_COMMANDS: ReadonlyArray<{ pattern: string; label: string }> = [
  { pattern: "rm -rf / | rm -rf ~ | rm -rf .", label: "recursive delete of protected path" },
  { pattern: "sudo * | su *", label: "privilege escalation" },
  { pattern: "curl ... | sh | wget ... | sh", label: "pipe remote script to shell" },
  { pattern: "git push --force | git reset --hard | git clean -fdx", label: "destructive git operation" },
  { pattern: "chmod -R 777 | chown -R", label: "recursive permission/ownership change" },
  { pattern: "mkfs* | dd if=* of=/dev/* | > /dev/sd*", label: "filesystem/disk destruction" },
  { pattern: ":(){ :|:& };:", label: "fork bomb" },
  { pattern: "kill -9 -1 | shutdown | reboot", label: "system-level disruption" },
];

/** Session grant suggestion for a command: first two non-flag tokens. */
export function commandPrefix(command: string): string {
  const tokens = tokenize(command.trim());
  const out: string[] = [];
  for (const token of tokens) {
    if (out.length === 0) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      out.push(token);
      continue;
    }
    if (token.startsWith("-")) break;
    if (/["'|&;<>]/.test(token)) break;
    out.push(token);
    if (out.length >= 2) break;
  }
  return out.join(" ");
}
