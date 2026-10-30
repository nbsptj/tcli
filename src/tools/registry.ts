import { z } from "zod";
import type { ToolSchema } from "../types.ts";
import type { AnyToolDefinition, ToolDefinition } from "./types.ts";

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  // Models handle an explicit object schema better than a top-level anyOf.
  if (!json.type) json.type = "object";
  return json;
}

/**
 * Tool registry: the single source of truth for names, descriptions, JSON
 * schemas and execution. Schemas are generated from Zod so validation and the
 * provider-facing schema cannot drift apart.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private schemaCache?: ToolSchema[];

  register(tool: ToolDefinition<z.ZodTypeAny>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.schemaCache = undefined;
  }

  registerAll(tools: AnyToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.schemaCache = undefined;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((t) => t.name);
  }

  schemas(): ToolSchema[] {
    if (!this.schemaCache) {
      this.schemaCache = this.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? toJsonSchema(tool.schema),
      }));
    }
    return this.schemaCache;
  }

  validate(name: string, input: unknown):
    | { ok: true; tool: AnyToolDefinition; value: Record<string, unknown> }
    | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) {
      const available = this.names().join(", ");
      return { ok: false, error: `Unknown tool "${name}". Available tools: ${available}` };
    }
    if (tool.validateInput) {
      const custom = tool.validateInput(input);
      if (!custom.ok) return { ok: false, error: custom.error ?? `Invalid arguments for tool "${name}"` };
      return { ok: true, tool, value: (custom.value ?? {}) as Record<string, unknown> };
    }
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `  ${issue.path.length ? issue.path.join(".") : "<input>"}: ${issue.message}`)
        .join("\n");
      return { ok: false, error: `Invalid arguments for tool "${name}":\n${issues}` };
    }
    return { ok: true, tool, value: parsed.data as Record<string, unknown> };
  }
}
