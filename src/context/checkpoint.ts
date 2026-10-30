import fs from "node:fs";
import path from "node:path";
import { ensureDirSync, hashBytes, readFileTextSafe, removeFileSafe, writeFileAtomicSync } from "../utils/fs.ts";

export interface CheckpointInfo {
  id: string;
  path: string;
  existed: boolean;
  createdAt: string;
  tool: string;
  oldSize: number;
  /** Hash of the content written by the tool, used to detect later edits. */
  afterHash?: string;
  undoneAt?: string;
}

export interface UndoResult {
  ok: boolean;
  path?: string;
  action?: "restored" | "deleted";
  message: string;
}

/**
 * File checkpoints (CT-5): before every write/edit, keep a backup so `/undo`
 * can restore the previous content. Backups and metadata live inside the
 * session directory and survive resume.
 */
export class CheckpointStore {
  readonly dir: string;
  private items: CheckpointInfo[] = [];
  private counter = 0;
  private readonly onRecord?: (info: CheckpointInfo) => void;

  constructor(dir: string, onRecord?: (info: CheckpointInfo) => void) {
    this.dir = path.resolve(dir);
    this.onRecord = onRecord;
    this.load();
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private backupPath(id: string): string {
    return path.join(this.dir, `${id}.bak`);
  }

  private load(): void {
    this.items = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of entries) {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as CheckpointInfo;
        if (info?.id && info.path) this.items.push(info);
      } catch {
        /* ignore corrupt checkpoint metadata */
      }
    }
    this.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const last = this.items.length ? this.items[this.items.length - 1]!.id : "";
    const digits = /cp-(\d+)-/.exec(last)?.[1];
    this.counter = digits ? Number(digits) : this.items.length;
  }

  list(includeUndone = false): CheckpointInfo[] {
    return this.items.filter((i) => includeUndone || !i.undoneAt).map((i) => ({ ...i }));
  }

  get(id: string): CheckpointInfo | undefined {
    const found = this.items.find((i) => i.id === id);
    return found ? { ...found } : undefined;
  }

  /** Store a backup before mutating a file. `oldContent` is null for new files. */
  create(absPath: string, oldContent: string | null, meta: { tool: string }): CheckpointInfo {
    ensureDirSync(this.dir);
    this.counter++;
    const id = `cp-${Date.now()}-${String(this.counter).padStart(4, "0")}`;
    if (oldContent !== null) {
      writeFileAtomicSync(this.backupPath(id), oldContent, 0o600);
    }
    const info: CheckpointInfo = {
      id,
      path: path.resolve(absPath),
      existed: oldContent !== null,
      createdAt: new Date().toISOString(),
      tool: meta.tool,
      oldSize: oldContent === null ? 0 : Buffer.byteLength(oldContent, "utf8"),
    };
    this.persist(info);
    this.items.push(info);
    this.prune();
    this.onRecord?.({ ...info });
    return { ...info };
  }

  finalize(id: string, newContent: string): void {
    const info = this.items.find((i) => i.id === id);
    if (!info) return;
    info.afterHash = hashBytes(newContent);
    this.persist(info);
    this.onRecord?.({ ...info });
  }

  private persist(info: CheckpointInfo): void {
    writeFileAtomicSync(this.metaPath(info.id), JSON.stringify(info, null, 2), 0o600);
  }

  private prune(): void {
    if (this.items.length <= 200) return;
    const removable = this.items.filter((i) => i.undoneAt).slice(0, this.items.length - 200);
    for (const info of removable) {
      removeFileSafe(this.metaPath(info.id));
      removeFileSafe(this.backupPath(info.id));
      this.items = this.items.filter((i) => i.id !== info.id);
    }
  }

  undoLast(opts: { force?: boolean } = {}): UndoResult & { info?: CheckpointInfo } {
    const last = [...this.items].reverse().find((i) => !i.undoneAt);
    if (!last) return { ok: false, message: "No checkpoint to undo." };
    const result = this.restore(last.id, opts);
    return { ...result, info: last };
  }

  restore(id: string, opts: { force?: boolean } = {}): UndoResult {
    const info = this.items.find((i) => i.id === id);
    if (!info) return { ok: false, message: `Unknown checkpoint: ${id}` };
    if (info.undoneAt) return { ok: false, message: `Checkpoint ${id} was already undone.` };
    const current = readFileTextSafe(info.path);
    if (info.afterHash && current !== undefined && hashBytes(current) !== info.afterHash && !opts.force) {
      return {
        ok: false,
        path: info.path,
        message: `${info.path} changed since this checkpoint was created; refusing to overwrite (use /undo --force to override).`,
      };
    }
    try {
      if (info.existed) {
        const backup = readFileTextSafe(this.backupPath(info.id));
        if (backup === undefined) {
          return { ok: false, path: info.path, message: `Backup missing for checkpoint ${info.id}.` };
        }
        writeFileAtomicSync(info.path, backup);
        info.undoneAt = new Date().toISOString();
        this.persist(info);
        return { ok: true, path: info.path, action: "restored", message: `Restored ${info.path}` };
      }
      if (current !== undefined) fs.unlinkSync(info.path);
      info.undoneAt = new Date().toISOString();
      this.persist(info);
      return { ok: true, path: info.path, action: "deleted", message: `Deleted ${info.path} (it did not exist before the edit)` };
    } catch (err) {
      return { ok: false, path: info.path, message: `Failed to restore ${info.path}: ${(err as Error).message}` };
    }
  }
}
