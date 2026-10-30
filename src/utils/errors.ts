export class TcliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    message: string,
    opts: { code?: string; exitCode?: number; cause?: unknown; details?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "TcliError";
    this.code = opts.code ?? "TCLI_ERROR";
    this.exitCode = opts.exitCode ?? 1;
    this.details = opts.details;
  }
}

export class UsageError extends TcliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "USAGE", exitCode: 2, details });
    this.name = "UsageError";
  }
}

export class ConfigError extends TcliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "CONFIG", exitCode: 2, details });
    this.name = "ConfigError";
  }
}

export class ProviderError extends TcliError {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
      code?: string;
    } = {},
  ) {
    super(message, { code: opts.code ?? "PROVIDER", exitCode: 1, cause: opts.cause });
    this.name = "ProviderError";
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class AbortError extends TcliError {
  constructor(message = "Operation aborted") {
    super(message, { code: "ABORTED", exitCode: 130 });
    this.name = "AbortError";
  }
}

export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

export function isAbortError(err: unknown): boolean {
  const e = asError(err);
  return (
    e.name === "AbortError" ||
    (e as { code?: string }).code === "ABORT_ERR" ||
    (e as { code?: string }).code === "ABORTED"
  );
}

/** Human-readable error with cause chain, without leaking stack traces. */
export function describeError(err: unknown): string {
  const seen = new Set<Error>();
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    parts.push(cur.message || cur.name);
    cur = cur.cause;
  }
  if (!parts.length) parts.push(String(err));
  return parts.join(": ");
}

export function stackOf(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
