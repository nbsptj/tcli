import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { Logger } from "../log/logger.ts";
import type { AnyToolDefinition, ToolContext, ToolResult } from "../tools/types.ts";
import { projectToolsDir, resolveFrom, userToolsDir, resolveUserPath } from "../utils/paths.ts";
import { validateWithJsonSchema } from "../utils/json-schema.ts";
import { describeError } from "../utils/errors.ts";

interface CustomToolModule {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
  schema?: unknown;
  readOnly?: unknown;
  execute?: unknown;
}

export interface CustomToolLoadResult {
  tools: AnyToolDefinition[];
  warnings: string[];
}

function listModules(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith(".d.ts"))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function extractPaths(args: Record<string, unknown>, cwd: string): string[] {
  const keys = ["path", "file_path", "filePath", "cwd", "directory", "dir"];
  const paths: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) paths.push(resolveUserPath(cwd, value));
  }
  return [...new Set(paths)];
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { safeParse?: unknown }).safeParse === "function" &&
      typeof (value as { parse?: unknown }).parse === "function",
  );
}

function toResult(value: unknown): ToolResult {
  if (typeof value === "string") return { content: value };
  if (value && typeof value === "object") {
    const obj = value as { content?: unknown; isError?: unknown; display?: unknown };
    if (typeof obj.content === "string") {
      return {
        content: obj.content,
        isError: obj.isError === true,
        display:
          obj.display && typeof obj.display === "object"
            ? (obj.display as ToolResult["display"])
            : undefined,
      };
    }
  }
  try {
    return { content: JSON.stringify(value, null, 2) ?? String(value) };
  } catch {
    return { content: String(value) };
  }
}

/**
 * Load local custom tools (EX-4). Disabled by default because modules execute
 * in-process with the agent's privileges; enabling is an explicit trust
 * decision in config. Tool calls still go through the permission engine.
 *
 * Module shape:
 *   export default { name, description, parameters: <JSON Schema | Zod>, readOnly?, execute(args, ctx) }
 */
export async function loadCustomTools(opts: {
  cwd: string;
  config: Config;
  logger: Logger;
}): Promise<CustomToolLoadResult> {
  const warnings: string[] = [];
  const tools: AnyToolDefinition[] = [];
  if (!opts.config.customTools.enabled) return { tools, warnings };
  const dirs = [
    userToolsDir(),
    projectToolsDir(opts.cwd),
    ...opts.config.customTools.dirs.map((dir) => resolveFrom(opts.cwd, dir)),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of listModules(dir)) {
      let module: CustomToolModule;
      try {
        const stat = fs.statSync(file);
        const url = `${pathToFileURL(file).href}?v=${stat.mtimeMs}`;
        const imported = (await import(url)) as CustomToolModule & { default?: CustomToolModule; tool?: CustomToolModule };
        module = (imported.default ?? imported.tool ?? imported) as CustomToolModule;
      } catch (err) {
        warnings.push(`Custom tool failed to load (${file}): ${describeError(err)}`);
        opts.logger.warn("custom tool import failed", { file, error: describeError(err) });
        continue;
      }
      if (!module || typeof module !== "object" || typeof module.execute !== "function") {
        warnings.push(`Custom tool must export an object with execute(): ${file}`);
        continue;
      }
      const rawName = typeof module.name === "string" && module.name.trim() ? module.name.trim() : path.basename(file).replace(/\.[^.]+$/, "");
      const safeName = rawName.replace(/[^A-Za-z0-9_-]/g, "_");
      const name = `custom__${safeName}`;
      if (seen.has(name)) {
        warnings.push(`Duplicate custom tool "${safeName}" in ${file}; ignored.`);
        continue;
      }
      seen.add(name);
      const description =
        typeof module.description === "string" && module.description
          ? module.description
          : `Custom tool ${safeName}`;
      const parameters = module.parameters ?? module.inputSchema ?? module.schema;
      const readOnly = module.readOnly === true;
      const execute = module.execute as (
        args: Record<string, unknown>,
        ctx: { cwd: string; signal: AbortSignal; logger: Logger; config: Config },
      ) => unknown;

      const base = {
        name,
        description: `[custom tool] ${description}`,
        kind: readOnly ? ("read" as const) : ("exec" as const),
        permissionInfo: (input: Record<string, unknown>, ctx: ToolContext) => ({
          paths: extractPaths(input, ctx.cwd),
        }),
        async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
          try {
            const value = await execute(input, {
              cwd: ctx.cwd,
              signal: ctx.signal,
              logger: ctx.logger,
              config: ctx.config,
            });
            const result = toResult(value);
            return {
              ...result,
              display: result.display ?? { summary: `${safeName} completed` },
            };
          } catch (err) {
            return {
              content: `Custom tool "${safeName}" failed: ${describeError(err)}`,
              isError: true,
              display: { summary: `${safeName} failed` },
            };
          }
        },
      };

      if (isZodSchema(parameters)) {
        tools.push({ ...base, schema: parameters } as unknown as AnyToolDefinition);
      } else {
        const inputSchema =
          parameters && typeof parameters === "object" && !Array.isArray(parameters)
            ? (parameters as Record<string, unknown>)
            : { type: "object", properties: {}, additionalProperties: true };
        tools.push({
          ...base,
          schema: z.record(z.string(), z.unknown()),
          inputSchema,
          validateInput: (input: unknown) => validateWithJsonSchema(inputSchema, input),
        } as unknown as AnyToolDefinition);
      }
      opts.logger.info("custom tool loaded", { name, file });
    }
  }
  return { tools, warnings };
}
