import fs from "node:fs";
import { ConfigSchema, type Config, type ProviderConfig, type ProviderType } from "./schema.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { deepMerge } from "./merge.ts";
import { ConfigError } from "../utils/errors.ts";
import { projectConfigPath, userConfigPath } from "../utils/paths.ts";
import type { Price } from "../utils/tokens.ts";

export interface CliConfigOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  permissionMode?: "default" | "read-only" | "workspace-write";
  color?: "auto" | "always" | "never";
  sandbox?: "off" | "read-only" | "workspace";
}

export interface LoadedConfig {
  config: Config;
  userConfigPath: string;
  projectConfigPath: string;
  /** Existing config files, lowest to highest priority. */
  sources: string[];
  warnings: string[];
}

function readConfigFile(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new ConfigError(`Cannot read config file ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function envNumber(env: NodeJS.ProcessEnv, key: string, min?: number, max?: number): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`Environment variable ${key} must be a number, got "${raw}"`);
  if (min !== undefined && value < min) throw new ConfigError(`${key} must be >= ${min}`);
  if (max !== undefined && value > max) throw new ConfigError(`${key} must be <= ${max}`);
  return value;
}

function applyEnv(config: Config, env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  const providerOverride = env.TCLI_PROVIDER?.trim();
  if (providerOverride) {
    config.provider = providerOverride;
    const p = config.providers[providerOverride];
    if (!env.TCLI_MODEL && p?.model) config.model = p.model;
  }
  if (env.TCLI_MODEL?.trim()) config.model = env.TCLI_MODEL.trim();

  const temperature = envNumber(env, "TCLI_TEMPERATURE", 0, 2);
  if (temperature !== undefined) config.temperature = temperature;
  const maxTokens = envNumber(env, "TCLI_MAX_TOKENS", 1);
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  const maxSteps = envNumber(env, "TCLI_MAX_STEPS", 1);
  if (maxSteps !== undefined) config.maxSteps = maxSteps;

  const logLevel = env.TCLI_LOG_LEVEL?.trim();
  if (logLevel) {
    if (!["debug", "info", "warn", "error"].includes(logLevel)) {
      throw new ConfigError("TCLI_LOG_LEVEL must be one of debug|info|warn|error");
    }
    config.logging.level = logLevel as Config["logging"]["level"];
  }
  const mode = env.TCLI_PERMISSION_MODE?.trim();
  if (mode) {
    if (!["default", "read-only", "workspace-write"].includes(mode)) {
      throw new ConfigError("TCLI_PERMISSION_MODE must be one of default|read-only|workspace-write");
    }
    config.permissions.mode = mode as Config["permissions"]["mode"];
  }
  const color = env.TCLI_COLOR?.trim();
  if (color) {
    if (!["auto", "always", "never"].includes(color)) {
      throw new ConfigError("TCLI_COLOR must be one of auto|always|never");
    }
    config.ui.color = color as Config["ui"]["color"];
  }
  const theme = env.TCLI_THEME?.trim();
  if (theme === "dark" || theme === "light") config.ui.theme = theme;
  const language = env.TCLI_LANGUAGE?.trim();
  if (language === "en" || language === "zh") config.ui.language = language;
  const sandbox = env.TCLI_SANDBOX?.trim();
  if (sandbox) {
    if (!["off", "read-only", "workspace"].includes(sandbox)) {
      throw new ConfigError("TCLI_SANDBOX must be one of off|read-only|workspace");
    }
    config.sandbox.mode = sandbox as Config["sandbox"]["mode"];
  }
  if (env.TCLI_TELEMETRY === "1" || env.TCLI_TELEMETRY === "true") config.telemetry.enabled = true;

  // Provider endpoint/key overrides target the selected provider.
  const effectiveProvider = config.providers[config.provider];
  if (effectiveProvider) {
    if (env.TCLI_BASE_URL?.trim()) effectiveProvider.baseUrl = env.TCLI_BASE_URL.trim();
    if (env.TCLI_API_KEY?.trim()) effectiveProvider.apiKey = env.TCLI_API_KEY.trim();
  } else if (env.TCLI_BASE_URL || env.TCLI_API_KEY) {
    throw new ConfigError(`Unknown provider "${config.provider}" set by TCLI_PROVIDER`);
  }
  return warnings;
}

function applyCli(config: Config, cli: CliConfigOverrides): void {
  if (cli.provider) {
    config.provider = cli.provider;
    const p = config.providers[cli.provider];
    if (!cli.model && p?.model) config.model = p.model;
  }
  if (cli.model) config.model = cli.model;
  if (cli.temperature !== undefined) config.temperature = cli.temperature;
  if (cli.maxTokens !== undefined) config.maxTokens = cli.maxTokens;
  if (cli.maxSteps !== undefined) config.maxSteps = cli.maxSteps;
  if (cli.logLevel) config.logging.level = cli.logLevel;
  if (cli.permissionMode) config.permissions.mode = cli.permissionMode;
  if (cli.color) config.ui.color = cli.color;
  if (cli.sandbox) config.sandbox.mode = cli.sandbox;
  const provider = config.providers[config.provider];
  if (provider) {
    if (cli.baseUrl) provider.baseUrl = cli.baseUrl;
    if (cli.apiKey) provider.apiKey = cli.apiKey;
  }
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map(
      (issue) =>
        `  ${issue.path.length ? issue.path.map(String).join(".") : "<root>"}: ${issue.message}`,
    )
    .join("\n");
}

/**
 * Load and validate layered configuration:
 * defaults < ~/.tcli/config.json < .tcli/config.json < environment < CLI flags.
 */
export function loadConfig(opts: {
  cwd: string;
  cli?: CliConfigOverrides;
  env?: NodeJS.ProcessEnv;
}): LoadedConfig {
  const env = opts.env ?? process.env;
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(opts.cwd);
  const sources: string[] = [];
  const warnings: string[] = [];

  let merged = structuredClone(DEFAULT_CONFIG);
  const userConfig = readConfigFile(userPath);
  if (userConfig) {
    merged = deepMerge(merged, userConfig);
    sources.push(userPath);
  }
  if (projectPath !== userPath) {
    const projectConfig = readConfigFile(projectPath);
    if (projectConfig) {
      merged = deepMerge(merged, projectConfig);
      sources.push(projectPath);
    }
  }

  warnings.push(...applyEnv(merged, env));

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const where = sources.length ? sources.join(", ") : "no config files";
    throw new ConfigError(`Invalid configuration (${where}):\n${formatIssues(parsed.error)}`);
  }
  const config = parsed.data;
  applyCli(config, opts.cli ?? {});

  if (!config.providers[config.provider]) {
    const names = Object.keys(config.providers).sort().join(", ");
    throw new ConfigError(`Unknown provider "${config.provider}". Configured providers: ${names}`);
  }

  return { config, userConfigPath: userPath, projectConfigPath: projectPath, sources, warnings };
}

export interface ResolvedProvider {
  name: string;
  type: ProviderType;
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
  price?: Price;
  raw: ProviderConfig;
}

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama: "http://127.0.0.1:11434",
  mock: "mock://",
};

export function resolveApiKey(
  name: string,
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider.apiKey) return provider.apiKey;
  if (env.TCLI_API_KEY) return env.TCLI_API_KEY;
  if (provider.apiKeyEnv && env[provider.apiKeyEnv]) return env[provider.apiKeyEnv];
  const conventional = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  if (env[conventional]) return env[conventional];
  if (provider.type === "anthropic" && env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  if (provider.type === "openai-compatible" && name === "openai" && env.OPENAI_API_KEY) {
    return env.OPENAI_API_KEY;
  }
  return undefined;
}

export function resolveProvider(
  config: Config,
  name = config.provider,
  model = config.model,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const raw = config.providers[name];
  if (!raw) throw new ConfigError(`Unknown provider "${name}"`);
  const resolvedModel = model || raw.model || config.model;
  if (!resolvedModel) throw new ConfigError(`No model configured for provider "${name}"`);
  return {
    name,
    type: raw.type,
    model: resolvedModel,
    baseUrl: (raw.baseUrl ?? DEFAULT_BASE_URLS[raw.type]).replace(/\/+$/, ""),
    apiKey: resolveApiKey(name, raw, env),
    apiKeyEnv: raw.apiKeyEnv,
    headers: raw.headers,
    timeoutMs: raw.timeoutMs ?? 120_000,
    maxTokens: raw.maxTokens ?? config.maxTokens,
    temperature: raw.temperature ?? config.temperature,
    contextWindow: raw.contextWindow ?? config.context.window,
    price: raw.price,
    raw,
  };
}

export function missingApiKeyHint(provider: ResolvedProvider): string | undefined {
  if (provider.type === "ollama" || provider.type === "mock") return undefined;
  if (provider.apiKey) return undefined;
  const envName = provider.apiKeyEnv ?? `${provider.name.toUpperCase()}_API_KEY`;
  return `No API key for provider "${provider.name}". Set ${envName}, run \`tcli init\`, or configure providers.${provider.name}.apiKey in ~/.tcli/config.json.`;
}

export function loadRawUserConfig(): Record<string, unknown> | undefined {
  return readConfigFile(userConfigPath());
}

export function loadRawProjectConfig(cwd: string): Record<string, unknown> | undefined {
  return readConfigFile(projectConfigPath(cwd));
}
