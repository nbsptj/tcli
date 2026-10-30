import type { Config } from "../config/schema.ts";
import type { AnyToolDefinition } from "./types.ts";
import { ToolRegistry } from "./registry.ts";
import { readFileTool } from "./read-file.ts";
import { writeFileTool } from "./write-file.ts";
import { editFileTool } from "./edit-file.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { bashTool } from "./bash.ts";
import { gitDiffTool, gitStatusTool } from "./git.ts";
import { todoTool } from "./todo.ts";
import { webFetchTool, webSearchTool } from "./web.ts";
import { taskTool } from "./task.ts";

export function createBuiltinTools(config: Config): AnyToolDefinition[] {
  const tools: AnyToolDefinition[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    bashTool,
    todoTool,
  ] as unknown as AnyToolDefinition[];
  if (config.tools.git.enabled) {
    tools.push(gitStatusTool as unknown as AnyToolDefinition, gitDiffTool as unknown as AnyToolDefinition);
  }
  if (config.tools.web.enabled) {
    tools.push(webFetchTool as unknown as AnyToolDefinition, webSearchTool as unknown as AnyToolDefinition);
  }
  if (config.agent.subagents.enabled) {
    tools.push(taskTool as unknown as AnyToolDefinition);
  }
  return tools;
}

export function createToolRegistry(
  config: Config,
  extra: AnyToolDefinition[] = [],
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(config)) registry.register(tool);
  for (const tool of extra) registry.register(tool);
  return registry;
}

export * from "./types.ts";
export * from "./registry.ts";
export * from "./todo-store.ts";
export { readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool, gitStatusTool, gitDiffTool, todoTool, webFetchTool, webSearchTool, taskTool };
