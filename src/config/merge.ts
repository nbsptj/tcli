import { isPlainObject } from "../utils/strings.ts";

/**
 * Deep merge for layered configuration.
 *
 * - objects merge recursively
 * - arrays concatenate (later layers append), except `mcpServers`/`providers`
 *   which are plain objects and merge recursively
 * - primitives (and null) replace
 *
 * Order matters for permission rules: later layers win because rules are
 * evaluated in order and the last match is used.
 */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === undefined) return base;
  if (Array.isArray(base) && Array.isArray(overlay)) {
    return [...base, ...overlay] as T;
  }
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue;
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out as T;
  }
  return overlay as T;
}

export function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (!isPlainObject(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

export function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}
