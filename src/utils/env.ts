/**
 * Environment hygiene for spawned commands.
 *
 * Tool subprocesses should not inherit provider keys or unrelated credentials,
 * but must retain the basics needed to run builds and VCS commands.
 */

const ALWAYS_KEEP = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PWD",
  "LANG",
  "LANGUAGE",
  "TZ",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
]);

const SENSITIVE_ENV =
  /^(?:AWS_|AZURE_|GCP_|GOOGLE_|OPENAI_|ANTHROPIC_|DEEPSEEK_|GEMINI_|TAVILY_|BRAVE_|HUGGINGFACE_|HF_|TCLI_)|(?:_API_KEY|_ACCESS_KEY|_SECRET|_SECRET_KEY|_TOKEN|_PASSWORD|_PASSWD|CREDENTIALS)$/i;

/**
 * Filter process env down to a safe set.
 * @param passthrough exact names or `prefix*` patterns to keep regardless.
 */
export function filterEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  passthrough: string[] = [],
): Record<string, string> {
  const keepExact = new Set(passthrough.filter((p) => !p.includes("*")));
  const keepPatterns = passthrough
    .filter((p) => p.includes("*"))
    .map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ALWAYS_KEEP.has(key) || key.startsWith("LC_") || key.startsWith("XDG_")) {
      out[key] = value;
      continue;
    }
    if (keepExact.has(key) || keepPatterns.some((re) => re.test(key))) {
      out[key] = value;
      continue;
    }
    if (SENSITIVE_ENV.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Names of removed sensitive variables (for diagnostics, values never logged). */
export function filteredEnvNames(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  passthrough: string[] = [],
): string[] {
  const kept = filterEnv(env, passthrough);
  return Object.keys(env).filter((k) => env[k] !== undefined && !(k in kept)).sort();
}
