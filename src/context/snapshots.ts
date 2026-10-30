import { hashBytes, readFileTextSync } from "../utils/fs.ts";

export interface SnapshotRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  readAt: string;
}

/**
 * Tracks files the agent has read so `write_file`/`edit_file` cannot silently
 * overwrite content the model has not seen (TL-2 / CT-4).
 */
export class SnapshotStore {
  private readonly records = new Map<string, SnapshotRecord>();
  private readonly onRecord?: (record: SnapshotRecord) => void;

  constructor(onRecord?: (record: SnapshotRecord) => void) {
    this.onRecord = onRecord;
  }

  recordRead(absPath: string, content: string, mtimeMs?: number): SnapshotRecord {
    const record: SnapshotRecord = {
      path: absPath,
      hash: hashBytes(content),
      size: Buffer.byteLength(content, "utf8"),
      mtimeMs: mtimeMs ?? Date.now(),
      readAt: new Date().toISOString(),
    };
    this.records.set(absPath, record);
    this.onRecord?.(record);
    return record;
  }

  get(absPath: string): SnapshotRecord | undefined {
    return this.records.get(absPath);
  }

  has(absPath: string): boolean {
    return this.records.has(absPath);
  }

  remove(absPath: string): void {
    this.records.delete(absPath);
  }

  all(): SnapshotRecord[] {
    return [...this.records.values()];
  }

  restore(records: SnapshotRecord[]): void {
    for (const record of records) {
      if (record?.path && record.hash) this.records.set(record.path, record);
    }
  }

  /**
   * Check that the on-disk content is still what the model last read.
   * Returns a model-readable error when a read is missing or stale.
   */
  verify(absPath: string, currentContent: string, opts: { requireRead: boolean }):
    | { ok: true }
    | { ok: false; reason: string; code: "not-read" | "stale" } {
    const record = this.records.get(absPath);
    if (!record) {
      if (!opts.requireRead) return { ok: true };
      return {
        ok: false,
        code: "not-read",
        reason: `Refusing to modify "${absPath}" without reading it first. Call read_file on it, then retry.`,
      };
    }
    const currentHash = hashBytes(currentContent);
    if (currentHash !== record.hash) {
      return {
        ok: false,
        code: "stale",
        reason: `"${absPath}" changed on disk since it was last read. Read it again before editing (do not overwrite external changes).`,
      };
    }
    return { ok: true };
  }
}

export function currentContent(absPath: string): string | undefined {
  try {
    return readFileTextSync(absPath);
  } catch {
    return undefined;
  }
}
