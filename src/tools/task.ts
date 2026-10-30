import { z } from "zod";
import { defineTool, type ToolContext } from "./types.ts";

const TaskArgs = z.strictObject({
  description: z.string().min(1).describe("Short (3-6 words) description of the subtask."),
  prompt: z.string().min(1).describe("Complete, self-contained instructions for the subagent."),
  max_steps: z.number().int().positive().max(100).optional().describe("Maximum agent steps for the subtask."),
});

export const taskTool = defineTool({
  name: "task",
  description:
    "Delegate a self-contained subtask to a subagent with an isolated context. The subagent has the same tools " +
    "and permission rules and returns a final report. Use for broad searches or independent research; never " +
    "delegate the whole user task.",
  schema: TaskArgs,
  kind: "read",
  async permissionInfo() {
    return { paths: [] };
  },
  async execute(input, ctx: ToolContext) {
    if (!ctx.spawnSubagent) {
      return { content: "Subagents are disabled (agent.subagents.enabled=false).", isError: true };
    }
    const result = await ctx.spawnSubagent({
      description: input.description,
      prompt: input.prompt,
      maxSteps: input.max_steps,
    });
    return {
      content:
        `<subagent-report description="${input.description.replace(/"/g, "&quot;")}" ok="${result.ok}">\n` +
        `${result.text || "(subagent produced no output)"}\n</subagent-report>`,
      isError: !result.ok,
      display: { summary: `task: ${input.description} (${result.toolCalls ?? 0} tool calls)` },
      metadata: { usage: result.usage, toolCalls: result.toolCalls },
    };
  },
});
