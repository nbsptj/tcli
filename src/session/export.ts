import type { LoadedSession } from "./types.ts";
import type { ChatMessage } from "../types.ts";
import { formatTokens } from "../utils/strings.ts";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMessage(message: ChatMessage, index: number): string[] {
  const out: string[] = [];
  if (message.role === "system") {
    const isSummary = message.content.startsWith("[Conversation summary");
    out.push(`## ${isSummary ? "Compacted context" : "System"}${isSummary ? "" : ` ${index}`}`);
    out.push("");
    out.push(`> ${message.content.replace(/\n/g, "\n> ")}`);
    out.push("");
    return out;
  }
  if (message.role === "user") {
    out.push(`## User`);
    out.push("");
    out.push(message.content);
    out.push("");
    return out;
  }
  if (message.role === "assistant") {
    out.push(`## Assistant`);
    out.push("");
    if (message.content.trim()) {
      out.push(message.content);
      out.push("");
    }
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        out.push(`### Tool call: \`${call.name}\``);
        out.push("");
        out.push("<details><summary>Arguments</summary>");
        out.push("");
        out.push("```json");
        out.push(JSON.stringify(call.arguments, null, 2));
        out.push("```");
        out.push("");
        out.push("</details>");
        out.push("");
      }
    }
    return out;
  }
  out.push(`### Tool result: \`${message.toolName ?? "tool"}\`${message.isError ? " (error)" : ""}`);
  out.push("");
  const content = message.content.length > 8000 ? message.content.slice(0, 8000) + "\n… [truncated]" : message.content;
  out.push("<details><summary>Output</summary>");
  out.push("");
  out.push("<pre>" + escapeHtml(content) + "</pre>");
  out.push("");
  out.push("</details>");
  out.push("");
  return out;
}

export function sessionToMarkdown(loaded: LoadedSession): string {
  const lines: string[] = [];
  const { meta } = loaded;
  lines.push(`# ${meta.title || "tcli session"}`);
  lines.push("");
  lines.push(`- Session: \`${meta.id}\``);
  lines.push(`- Created: ${meta.createdAt}`);
  lines.push(`- Workspace: \`${meta.cwd}\``);
  lines.push(`- Provider: ${meta.provider} / ${meta.model}`);
  lines.push(
    `- Usage: ${formatTokens(loaded.usage.inputTokens)} input, ${formatTokens(loaded.usage.outputTokens)} output tokens`,
  );
  if (loaded.warnings.length) {
    lines.push(`- Warnings: ${loaded.warnings.length} malformed line(s) ignored`);
  }
  lines.push("");
  loaded.messages.forEach((message, index) => lines.push(...renderMessage(message, index)));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
