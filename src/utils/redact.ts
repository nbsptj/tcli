/**
 * Secret redaction for tool output, logs, audit records and transcripts.
 *
 * Deliberately conservative: it targets credential-shaped assignments and
 * bearer tokens rather than every high-entropy string, so normal code is not
 * mangled.
 */

const ENV_ASSIGN =
  /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE)[A-Za-z0-9_]*)([ \t]*=[ \t]*)(["']?)([^\n]*?)(\4)([ \t]*(?:#.*)?)$/gim;

const JSON_ASSIGN =
  /("?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|private[_-]?key|authorization)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi;

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g;
const BASIC = /\b(Basic\s+)[A-Za-z0-9+/=]{8,}/g;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi;

export interface RedactResult {
  text: string;
  count: number;
}

export function redactSecrets(input: string): RedactResult {
  if (!input) return { text: input, count: 0 };
  let count = 0;
  let text = input;

  text = text.replace(ENV_ASSIGN, (_m, pre: string, name: string, eq: string, quote: string, value: string, close: string, tail: string) => {
    if (!value || value === "***") return _m;
    // Keep obviously non-secret values readable.
    void quote;
    count++;
    return `${pre}${name}${eq}"***"${tail}`;
  });

  text = text.replace(
    /\b(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,}]+/gi,
    (_m, pre: string) => {
      count++;
      return `${pre}***`;
    },
  );

  text = text.replace(JSON_ASSIGN, (_m, pre: string, value: string) => {
    const plain = value.replace(/^["']|["']$/g, "");
    if (!plain || plain === "***" || plain === "null" || plain === "undefined") return _m;
    count++;
    return `${pre}"***"`;
  });

  text = text.replace(BEARER, (_m, pre: string) => {
    count++;
    return `${pre}***`;
  });
  text = text.replace(BASIC, (_m, pre: string) => {
    count++;
    return `${pre}***`;
  });
  text = text.replace(URL_CREDS, (_m, pre: string, _pass: string, at: string) => {
    count++;
    return `${pre}***${at}`;
  });

  return { text, count };
}

/** Redact every string leaf of a JSON-like value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api[_-]?key|token|secret|password|authorization)$/i.test(k)) {
        out[k] = "***";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out as T;
  }
  return value;
}

/** True when file content appears to contain credentials. */
export function containsSecrets(text: string): boolean {
  return redactSecrets(text).count > 0;
}
