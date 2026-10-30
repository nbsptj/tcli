import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";
import type { TodoItem } from "../types.ts";

const TodoArgs = z.strictObject({
  todos: z
    .array(
      z.strictObject({
        content: z.string().min(1).describe("Short description of the task."),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .describe("The complete updated todo list (replaces the previous list). Use [] to clear."),
});

export const todoTool = defineTool({
  name: "todo",
  description:
    "Maintain the structured task list for multi-step work. Send the complete list each time. " +
    "Keep exactly one item in_progress while working, and mark items completed as soon as they are done.",
  schema: TodoArgs,
  kind: "read",
  async permissionInfo() {
    return { paths: [] };
  },
  async execute(input, ctx: ToolContext) {
    try {
      ctx.todo.replace(input.todos as TodoItem[]);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
    const todos = ctx.todo.list();
    ctx.onTodo?.(todos);
    const progress = ctx.todo.progress();
    return {
      content: `Todo list updated (${progress.done}/${progress.total} completed):\n${ctx.todo.format()}`,
      display: { summary: `todo: ${progress.done}/${progress.total} completed` },
      metadata: { todos },
    };
  },
});
