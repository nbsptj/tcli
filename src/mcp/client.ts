import { TCLI_VERSION } from "../types.ts";
import { describeError } from "../utils/errors.ts";
import { HttpMcpTransport, SseMcpTransport } from "./http.ts";
import { StdioTransport } from "./stdio.ts";
import {
  McpError,
  type McpCallResult,
  type McpClientOptions,
  type McpRequestOptions,
  type McpToolInfo,
  type McpTransport,
} from "./types.ts";

interface McpToolWire {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
    idempotentHint?: unknown;
    title?: unknown;
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function renderCallContent(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const raw of content) {
    const item = asObject(raw);
    const type = item.type;
    if (type === "text") {
      if (typeof item.text === "string") parts.push(item.text);
    } else if (type === "resource") {
      const resource = asObject(item.resource);
      if (typeof resource.text === "string") parts.push(resource.text);
      else if (typeof resource.uri === "string") parts.push(`[resource: ${resource.uri}]`);
    } else if (type === "image") {
      parts.push(`[image omitted${typeof item.mimeType === "string" ? `: ${item.mimeType}` : ""}]`);
    } else if (type === "audio") {
      parts.push(`[audio omitted${typeof item.mimeType === "string" ? `: ${item.mimeType}` : ""}]`);
    } else if (typeof item.type === "string") {
      parts.push(`[${item.type} content]`);
    }
  }
  if (!parts.length && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      parts.push(String(result.structuredContent));
    }
  }
  return parts.join("\n") || "(no output)";
}

/** One MCP server connection: handshake, tool discovery and tool calls. */
export class McpClient {
  readonly name: string;
  serverInfo?: unknown;
  private readonly options: McpClientOptions;
  private transport?: McpTransport;
  private tools: McpToolInfo[] = [];

  constructor(options: McpClientOptions) {
    this.options = options;
    this.name = options.name;
  }

  private createTransport(override?: "stdio" | "sse" | "http"): McpTransport {
    const { config, workspace, logger } = this.options;
    const timeoutMs = config.timeoutMs ?? 20_000;
    const mode = override ?? config.transport ?? (config.command ? "stdio" : "http");
    if (mode === "stdio") {
      if (!config.command) throw new McpError(`MCP server "${this.name}" has no command for stdio transport`);
      return new StdioTransport({ config, workspace, logger, timeoutMs });
    }
    if (!config.url) throw new McpError(`MCP server "${this.name}" has no url for ${mode} transport`);
    if (mode === "sse") {
      return new SseMcpTransport({ url: config.url, headers: config.headers, timeoutMs, logger });
    }
    return new HttpMcpTransport({ url: config.url, headers: config.headers, timeoutMs, logger });
  }

  async connect(transportOverride?: "stdio" | "sse" | "http"): Promise<void> {
    const transport = this.createTransport(transportOverride);
    try {
      await transport.connect();
      const result = asObject(
        await transport.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tcli", version: TCLI_VERSION },
        }),
      );
      this.serverInfo = result.serverInfo;
      await transport.notify("notifications/initialized", {});
      this.transport = transport;
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err instanceof McpError ? err : new McpError(`MCP server "${this.name}" failed to initialize: ${describeError(err)}`);
    }
  }

  private requireTransport(): McpTransport {
    if (!this.transport) throw new McpError(`MCP server "${this.name}" is not connected`);
    return this.transport;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const transport = this.requireTransport();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = asObject(await transport.request("tools/list", cursor ? { cursor } : {}));
      const list = Array.isArray(response.tools) ? response.tools : [];
      for (const raw of list) {
        const tool = raw as McpToolWire;
        if (typeof tool.name !== "string" || !tool.name) continue;
        const schema = asObject(tool.inputSchema);
        const annotations = tool.annotations ?? {};
        tools.push({
          name: tool.name,
          description:
            (typeof tool.description === "string" && tool.description) ||
            (typeof tool.title === "string" && tool.title) ||
            tool.name,
          inputSchema:
            Object.keys(schema).length > 0
              ? schema
              : { type: "object", properties: {}, additionalProperties: true },
          readOnly: annotations.readOnlyHint === true,
          destructive: annotations.destructiveHint === true,
          idempotent: annotations.idempotentHint === true,
        });
      }
      if (typeof response.nextCursor === "string" && response.nextCursor) {
        cursor = response.nextCursor;
      } else {
        break;
      }
    }
    this.tools = tools;
    return tools;
  }

  get discoveredTools(): McpToolInfo[] {
    return [...this.tools];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: McpRequestOptions = {},
  ): Promise<McpCallResult> {
    const transport = this.requireTransport();
    const result = asObject(
      await transport.request("tools/call", { name, arguments: args }, opts),
    );
    return {
      content: renderCallContent(result),
      isError: result.isError === true,
      structured: result.structuredContent,
    };
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    if (transport) await transport.close().catch(() => undefined);
  }
}

export { renderCallContent };
