import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";
import type { AnyToolDefinition, ToolContext, ToolResult } from "../tools/types.ts";
import { validateWithJsonSchema } from "../utils/json-schema.ts";
import { resolveUserPath } from "../utils/paths.ts";
import { describeError } from "../utils/errors.ts";
import { McpClient } from "./client.ts";
import type { McpLoadResult, McpToolInfo } from "./types.ts";

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function extractPaths(args: Record<string, unknown>, cwd: string): string[] {
  const keys = ["path", "file_path", "filePath", "cwd", "directory", "dir", "root"];
  const paths: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) paths.push(resolveUserPath(cwd, value));
  }
  return [...new Set(paths)];
}

function createMcpTool(
  serverName: string,
  client: McpClient,
  tool: McpToolInfo,
): AnyToolDefinition {
  const name = `mcp__${slug(serverName)}__${slug(tool.name)}`;
  const schema = { ...tool.inputSchema };
  delete (schema as Record<string, unknown>).$schema;
  const description = [
    `[MCP server "${serverName}"] ${tool.description}`,
    tool.readOnly ? "(read-only)" : "",
    tool.destructive ? "(destructive; requires care)" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    name,
    description,
    schema: z.record(z.string(), z.unknown()),
    inputSchema: schema,
    validateInput: (input: unknown) => validateWithJsonSchema(schema, input),
    kind: tool.readOnly ? "read" : "exec",
    permissionInfo: (input: unknown, ctx: ToolContext) => ({
      paths: extractPaths(input as Record<string, unknown>, ctx.cwd),
    }),
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const result = await client.callTool(tool.name, input, { signal: ctx.signal });
        return {
          content: result.content,
          isError: result.isError,
          display: { summary: `MCP ${serverName} · ${tool.name}${result.isError ? " (error)" : ""}` },
          metadata: { server: serverName, tool: tool.name, mcp: true },
        };
      } catch (err) {
        return {
          content: `MCP tool "${tool.name}" on server "${serverName}" failed: ${describeError(err)}`,
          isError: true,
          display: { summary: `MCP ${serverName} · ${tool.name} failed` },
        };
      }
    },
  } as unknown as AnyToolDefinition;
}

/**
 * Connects configured MCP servers, discovers their tools and exposes them to
 * the agent. Connection failures are warnings, never fatal: a broken server
 * must not prevent the rest of tcli from running.
 */
export class McpManager {
  private readonly config: Config;
  private readonly workspace: string;
  private readonly logger: Logger;
  private readonly clients: McpClient[] = [];

  constructor(opts: { config: Config; workspace: string; logger: Logger }) {
    this.config = opts.config;
    this.workspace = opts.workspace;
    this.logger = opts.logger;
  }

  async load(): Promise<McpLoadResult> {
    const tools: AnyToolDefinition[] = [];
    const warnings: string[] = [];
    const servers = Object.entries(this.config.mcpServers)
      .filter(([, server]) => server.enabled)
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [serverName, server] of servers) {
      const modes: Array<"stdio" | "sse" | "http"> = server.command
        ? ["stdio"]
        : server.transport
          ? [server.transport]
          : ["http", "sse"];
      let connected: McpClient | undefined;
      let discovered: McpToolInfo[] = [];
      for (const mode of modes) {
        const client = new McpClient({
          name: serverName,
          config: server,
          workspace: this.workspace,
          logger: this.logger,
        });
        try {
          await client.connect(mode);
          discovered = await client.listTools();
          connected = client;
          this.logger.info("mcp server connected", {
            server: serverName,
            transport: mode,
            tools: discovered.length,
          });
          break;
        } catch (err) {
          const message = describeError(err);
          warnings.push(`MCP server "${serverName}" (${mode}): ${message}`);
          this.logger.warn("mcp server failed", { server: serverName, transport: mode, error: message });
          await client.close().catch(() => undefined);
        }
      }
      if (!connected) continue;
      this.clients.push(connected);
      const seen = new Set<string>();
      for (const tool of discovered) {
        const definition = createMcpTool(serverName, connected, tool);
        if (seen.has(definition.name)) {
          warnings.push(`MCP server "${serverName}" exposed duplicate tool name "${tool.name}"; ignored.`);
          continue;
        }
        seen.add(definition.name);
        tools.push(definition);
      }
    }
    return { tools, warnings, clients: this.clients.length };
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close().catch(() => undefined)));
    this.clients.length = 0;
  }
}
