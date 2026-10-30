import type { Config } from "./schema.ts";

export const DEFAULT_CONFIG: Config = {
  version: 1,
  provider: "deepseek",
  model: "deepseek-chat",
  temperature: 0,
  maxTokens: 8192,
  maxSteps: 40,
  providers: {
    deepseek: {
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
    },
    openai: {
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-4.1-mini",
      models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    },
    anthropic: {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      model: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-20241022"],
    },
    ollama: {
      type: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5-coder:7b",
      models: [],
    },
    mock: {
      type: "mock",
      model: "mock",
      models: ["mock"],
    },
  },
  context: {
    window: 128_000,
    compactAt: 0.8,
    keepRecentTurns: 4,
    maxFileBytes: 20_000,
    overview: { enabled: true, depth: 2, maxFiles: 300, ttlMs: 300_000 },
  },
  permissions: {
    mode: "default",
    rules: [
      { tool: "read_file", action: "allow" },
      { tool: "glob", action: "allow" },
      { tool: "grep", action: "allow" },
      { tool: "git_status", action: "allow" },
      { tool: "git_diff", action: "allow" },
      { tool: "todo", action: "allow" },
      { tool: "task", action: "allow" },
      { tool: "mcp__*", action: "ask" },
      { tool: "custom__*", action: "ask" },
    ],
    dangerous: {
      enabled: true,
      extra: [],
      allow: [],
    },
    workspaceOnly: true,
    requireReadBeforeWrite: true,
    autoApproveYes: ["read_file", "glob", "grep", "git_status", "git_diff", "todo"],
    sensitivePatterns: [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.p12",
      "id_rsa",
      "id_ed25519",
      ".npmrc",
      ".netrc",
      "credentials",
      "*credentials*",
      "*secret*",
      ".ssh/*",
      ".aws/*",
    ],
    audit: { enabled: true },
  },
  tools: {
    limits: { maxLines: 2000, maxBytes: 51_200, maxResults: 200 },
    bash: { timeoutMs: 120_000, envPassthrough: [] },
    web: {
      enabled: false,
      fetchEnabled: true,
      searchEnabled: true,
      searchProvider: "duckduckgo",
      timeoutMs: 20_000,
      allowPrivateHosts: false,
    },
    git: { enabled: true },
    read: { maxFileBytes: 5 * 1024 * 1024 },
  },
  agent: {
    timeoutMs: 0,
    budget: { maxTokens: 0, maxCostUsd: 0 },
    subagents: { enabled: true, maxDepth: 2, maxSteps: 20 },
  },
  session: { autoSave: true, titleMaxLength: 70 },
  mcpServers: {},
  hooks: { sessionStart: [], sessionEnd: [], preToolUse: [], postToolUse: [] },
  commands: { dirs: [] },
  customTools: { enabled: false, dirs: [] },
  sandbox: { mode: "off", network: false },
  logging: { level: "info", file: true },
  telemetry: { enabled: false },
  ui: { color: "auto", theme: "dark", language: "en", scrollbackLines: 5000 },
  instructions: { files: ["AGENTS.md", "TCLI.md"], maxBytes: 32_768, includeGlobal: true },
};

/** Default models per provider name for /model completion. */
export function providerModelList(config: Config, providerName: string): string[] {
  const p = config.providers[providerName];
  if (!p) return [];
  const list = new Set<string>();
  if (p.models) for (const m of p.models) list.add(m);
  if (p.model) list.add(p.model);
  if (config.provider === providerName && config.model) list.add(config.model);
  return [...list];
}
