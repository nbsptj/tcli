import type { ChatMessage } from "../types.ts";
import { estimateMessagesTokens, estimateTokens } from "../utils/tokens.ts";
import { truncateText } from "../utils/strings.ts";

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  summary?: string;
  beforeTokens: number;
  afterTokens: number;
  keptMessages: number;
}

export type Summarizer = (transcript: string, signal: AbortSignal) => Promise<string>;

function messageTokens(message: ChatMessage): number {
  let tokens = 4 + estimateTokens(message.content) + estimateTokens(message.reasoning ?? "");
  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      tokens += estimateTokens(call.name + JSON.stringify(call.arguments ?? {})) + 4;
    }
  }
  return tokens;
}

export function countMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += messageTokens(message);
  return total;
}

function leadingSystemCount(messages: ChatMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i]!.role === "system") i++;
  return i;
}

function findCutIndex(messages: ChatMessage[], systemCount: number, keepTurns: number): number {
  const userIndexes: number[] = [];
  for (let i = systemCount; i < messages.length; i++) {
    if (messages[i]!.role === "user") userIndexes.push(i);
  }
  if (userIndexes.length <= keepTurns) return systemCount;
  return userIndexes[userIndexes.length - keepTurns]!;
}

function renderTranscript(messages: ChatMessage[], maxChars = 24_000): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      parts.push(`SYSTEM: ${truncateText(message.content, 1200)}`);
    } else if (message.role === "user") {
      parts.push(`USER: ${truncateText(message.content, 2000)}`);
    } else if (message.role === "assistant") {
      let text = `ASSISTANT: ${truncateText(message.content, 2000)}`;
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          text += `\n  TOOL CALL ${call.name}(${truncateText(JSON.stringify(call.arguments ?? {}), 500)})`;
        }
      }
      parts.push(text);
    } else {
      parts.push(`TOOL RESULT ${message.toolName ?? ""}${message.isError ? " (error)" : ""}: ${truncateText(message.content, 1200)}`);
    }
  }
  const joined = parts.join("\n\n");
  if (joined.length <= maxChars) return joined;
  const half = Math.floor(maxChars / 2);
  return joined.slice(0, half) + "\n… [middle omitted] …\n" + joined.slice(-half);
}

/** Deterministic summary used when the model-based summarizer is unavailable. */
export function extractiveSummary(messages: ChatMessage[], recentFiles: string[] = []): string {
  const userMessages = messages.filter((m) => m.role === "user").map((m) => truncateText(m.content.replace(/\s+/g, " "), 300));
  const toolNames = new Map<string, number>();
  let errors = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNames.set(call.name, (toolNames.get(call.name) ?? 0) + 1);
    }
    if (message.role === "tool" && message.isError) errors++;
  }
  const lines = [
    `Earlier work (${messages.length} messages compacted without a model summary).`,
    userMessages.length ? `User requests:\n${userMessages.map((m) => `- ${m}`).join("\n")}` : "",
    `Tools used: ${[...toolNames.entries()].map(([name, n]) => `${name}×${n}`).join(", ") || "none"}`,
    errors ? `Tool errors encountered: ${errors}` : "",
    recentFiles.length ? `Files read recently:\n${recentFiles.map((f) => `- ${f}`).join("\n")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface CompactOptions {
  messages: ChatMessage[];
  keepRecentTurns: number;
  budgetTokens: number;
  summarize: Summarizer;
  signal: AbortSignal;
  recentFiles?: string[];
  force?: boolean;
  /** Number of leading system messages to keep verbatim (default: all leading). */
  preserveSystemCount?: number;
}

/**
 * Compress older turns into a summary when the context approaches its budget
 * (AG-5). Preserves the leading system prompt and the most recent user turns,
 * and never splits a tool call from its results (cuts only at user messages).
 */
export async function compactMessages(opts: CompactOptions): Promise<CompactionResult> {
  const beforeTokens = countMessageTokens(opts.messages);
  if (!opts.force && beforeTokens <= opts.budgetTokens) {
    return {
      messages: opts.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      keptMessages: opts.messages.length,
    };
  }
  const systemCount = Math.min(
    opts.preserveSystemCount ?? leadingSystemCount(opts.messages),
    opts.messages.length,
  );
  const cut = findCutIndex(opts.messages, systemCount, opts.keepRecentTurns);
  if (cut <= systemCount) {
    return {
      messages: opts.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      keptMessages: opts.messages.length,
    };
  }
  const older = opts.messages.slice(systemCount, cut);
  const recent = opts.messages.slice(cut);
  const transcript = renderTranscript(older);
  let summary: string;
  try {
    summary = (await opts.summarize(transcript, opts.signal)).trim();
    if (!summary) summary = extractiveSummary(older, opts.recentFiles);
  } catch {
    summary = extractiveSummary(older, opts.recentFiles);
  }
  summary = truncateText(summary, 8000);
  const summaryMessage: ChatMessage = {
    role: "system",
    content: [
      "[Conversation summary — earlier turns compacted to save context]",
      summary,
      opts.recentFiles?.length
        ? `\nFiles read earlier (still subject to read-before-write):\n${opts.recentFiles.map((f) => `- ${f}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
  let messages = [...opts.messages.slice(0, systemCount), summaryMessage, ...recent];
  // If still too large, keep only the most recent turn and shorten the summary.
  if (countMessageTokens(messages) > opts.budgetTokens && recent.length > 0) {
    const lastUser = [...recent].map((m, i) => ({ m, i })).filter((x) => x.m.role === "user").pop()?.i ?? 0;
    const trimmed = recent.slice(lastUser);
    messages = [...opts.messages.slice(0, systemCount), { ...summaryMessage, content: truncateText(summaryMessage.content, 2000) }, ...trimmed];
  }
  const afterTokens = countMessageTokens(messages);
  return {
    messages,
    compacted: true,
    summary,
    beforeTokens,
    afterTokens,
    keptMessages: messages.length - systemCount - 1,
  };
}

export interface ProxyCompactionState {
  lastCompactedAt?: number;
  compactions: number;
}

export function estimateConversationTokens(messages: ChatMessage[]): number {
  return estimateMessagesTokens(messages);
}
