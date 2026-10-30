import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { uniqueTempName } from "./paths.ts";

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function statSafe(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

export function isBinaryBuffer(buf: Buffer | Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function isBinaryFile(p: string): boolean {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(Math.min(8192, stat.size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return isBinaryBuffer(buf.subarray(0, read));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function hashBytes(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function readFileTextSync(p: string): string {
  return fs.readFileSync(p, "utf8");
}

export function readFileTextSafe(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Atomic write: write a sibling temp file, fsync it, rename over the target,
 * then fsync the directory. A crash can never leave a half-written file at the
 * destination. Existing file permissions are preserved.
 */
export function writeFileAtomicSync(filePath: string, content: string, mode?: number): void {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  let fileMode = mode;
  if (fileMode === undefined) {
    try {
      fileMode = fs.statSync(filePath).mode & 0o777;
    } catch {
      fileMode = 0o644;
    }
  }
  const tmp = uniqueTempName(dir, path.basename(filePath));
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", fileMode);
    const buf = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* directory fsync is best-effort */
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function appendLineSync(filePath: string, line: string): void {
  ensureDirSync(path.dirname(filePath));
  fs.appendFileSync(filePath, line.endsWith("\n") ? line : line + "\n", "utf8");
}

export interface WalkEntry {
  path: string;
  rel: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

export interface WalkOptions {
  /** Return true to skip this entry (files and dirs alike). */
  shouldIgnore?: (absPath: string, rel: string, isDir: boolean) => boolean;
  maxEntries?: number;
  followSymlinks?: boolean;
  includeDirs?: boolean;
  /** Optional concurrency-free filter applied before yield; dirs are always traversed. */
  signal?: AbortSignal;
}

/**
 * Recursively walk files, sorted for deterministic output. Symlinks are
 * skipped by default so tools cannot wander outside the workspace through a
 * link; explicit reads still work and are checked by the permission engine.
 */
export function* walkFiles(root: string, opts: WalkOptions = {}): Generator<WalkEntry> {
  const maxEntries = opts.maxEntries ?? 200_000;
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length) {
    if (opts.signal?.aborted) return;
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!opts.followSymlinks) continue;
        try {
          const st = fs.statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (opts.shouldIgnore?.(abs, rel, isDir)) continue;
      if (isDir) {
        subdirs.push(abs);
        if (opts.includeDirs) {
          const st = statSafe(abs);
          yield { path: abs, rel, size: 0, mtimeMs: st?.mtimeMs ?? 0, isDir: true };
        }
      } else if (isFile) {
        const st = statSafe(abs);
        if (!st) continue;
        yield { path: abs, rel, size: st.size, mtimeMs: st.mtimeMs, isDir: false };
      }
    }
    // Push in reverse so traversal is alphabetical.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
}

export function listDir(p: string): fs.Dirent[] | undefined {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

export function removeFileSafe(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

