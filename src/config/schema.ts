import { z } from "zod";

export const ProviderTypeSchema = z.enum(["openai-compatible", "anthropic", "ollama", "mock"]);

export const PriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
});

export const ProviderConfigSchema = z.strictObject({
  type: ProviderTypeSchema,
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string().optional(),
  models: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  contextWindow: z.number().int().positive().optional(),
  price: PriceSchema.optional(),
  /** Extra provider-specific options (e.g. Ollama keep_alive). */
  options: z.record(z.string(), z.unknown()).optional(),
});

export const PermissionRuleSchema = z.strictObject({
  tool: z.string().min(1),
  /** Command prefix (bash) or path glob (file tools). */
  match: z.string().optional(),
  action: z.enum(["allow", "ask", "deny"]),
  reason: z.string().optional(),
});

export const DangerousConfigSchema = z.strictObject({
  enabled: z.boolean(),
  /** Additional regex patterns treated as dangerous. */
  extra: z.array(z.string()),
  /** Exact commands or prefixes that may be offered to the user instead of hard-denied. */
  allow: z.array(z.string()),
});

export const AuditConfigSchema = z.strictObject({
  enabled: z.boolean(),
  dir: z.string().optional(),
});

export const PermissionsConfigSchema = z.strictObject({
  mode: z.enum(["default", "read-only", "workspace-write"]),
  rules: z.array(PermissionRuleSchema),
  dangerous: DangerousConfigSchema,
  workspaceOnly: z.boolean(),
  requireReadBeforeWrite: z.boolean(),
  autoApproveYes: z.array(z.string()),
  sensitivePatterns: z.array(z.string()),
  audit: AuditConfigSchema,
});

export const ToolLimitsSchema = z.strictObject({
  maxLines: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  maxResults: z.number().int().positive(),
});

export const BashConfigSchema = z.strictObject({
  timeoutMs: z.number().int().positive(),
  envPassthrough: z.array(z.string()),
});

export const WebConfigSchema = z.strictObject({
  enabled: z.boolean(),
  fetchEnabled: z.boolean(),
  searchEnabled: z.boolean(),
  searchProvider: z.enum(["duckduckgo", "brave", "tavily"]),
  timeoutMs: z.number().int().positive(),
  allowPrivateHosts: z.boolean(),
});

export const ToolsConfigSchema = z.strictObject({
  limits: ToolLimitsSchema,
  bash: BashConfigSchema,
  web: WebConfigSchema,
  git: z.strictObject({ enabled: z.boolean() }),
  read: z.strictObject({ maxFileBytes: z.number().int().positive() }),
});

export const ContextConfigSchema = z.strictObject({
  window: z.number().int().positive(),
  compactAt: z.number().gt(0).lte(1),
  keepRecentTurns: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  overview: z.strictObject({
    enabled: z.boolean(),
    depth: z.number().int().positive(),
    maxFiles: z.number().int().positive(),
    ttlMs: z.number().int().nonnegative(),
  }),
});

export const AgentConfigSchema = z.strictObject({
  timeoutMs: z.number().int().nonnegative(),
  budget: z.strictObject({
    maxTokens: z.number().int().nonnegative(),
    maxCostUsd: z.number().nonnegative(),
  }),
  subagents: z.strictObject({
    enabled: z.boolean(),
    maxDepth: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
  }),
});

export const SessionConfigSchema = z.strictObject({
  autoSave: z.boolean(),
  titleMaxLength: z.number().int().positive(),
});

export const HookSchema = z.strictObject({
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

export const HooksConfigSchema = z.strictObject({
  sessionStart: z.array(HookSchema),
  sessionEnd: z.array(HookSchema),
  preToolUse: z.array(HookSchema),
  postToolUse: z.array(HookSchema),
});

export const McpServerSchema = z
  .strictObject({
    enabled: z.boolean(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    transport: z.enum(["stdio", "sse", "http"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((v) => Boolean(v.command) !== Boolean(v.url), {
    message: "MCP server must set exactly one of command (stdio) or url (HTTP/SSE)",
  });

export const SandboxConfigSchema = z.strictObject({
  mode: z.enum(["off", "read-only", "workspace"]),
  network: z.boolean(),
});

export const LoggingConfigSchema = z.strictObject({
  level: z.enum(["debug", "info", "warn", "error"]),
  file: z.boolean(),
  dir: z.string().optional(),
});

export const TelemetryConfigSchema = z.strictObject({
  enabled: z.boolean(),
  endpoint: z.string().optional(),
});

export const UiConfigSchema = z.strictObject({
  color: z.enum(["auto", "always", "never"]),
  theme: z.enum(["dark", "light"]),
  language: z.enum(["en", "zh"]),
  scrollbackLines: z.number().int().positive(),
});

export const InstructionsConfigSchema = z.strictObject({
  files: z.array(z.string()),
  maxBytes: z.number().int().positive(),
  includeGlobal: z.boolean(),
});

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  providers: z.record(z.string(), ProviderConfigSchema),
  context: ContextConfigSchema,
  permissions: PermissionsConfigSchema,
  tools: ToolsConfigSchema,
  agent: AgentConfigSchema,
  session: SessionConfigSchema,
  mcpServers: z.record(z.string(), McpServerSchema),
  hooks: HooksConfigSchema,
  commands: z.strictObject({ dirs: z.array(z.string()) }),
  customTools: z.strictObject({ enabled: z.boolean(), dirs: z.array(z.string()) }),
  sandbox: SandboxConfigSchema,
  logging: LoggingConfigSchema,
  telemetry: TelemetryConfigSchema,
  ui: UiConfigSchema,
  instructions: InstructionsConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type HookConfig = z.infer<typeof HookSchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type LogLevelName = z.infer<typeof LoggingConfigSchema>["level"];
export type ProviderType = z.infer<typeof ProviderTypeSchema>;
