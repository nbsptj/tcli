/**
 * Token and cost estimation.
 *
 * Providers report exact usage when available; these estimates are used for
 * context budgeting before a request and as a fallback for local models.
 */

export interface Price {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Optional discounted price for cached input tokens. */
  cacheRead?: number;
}

/**
 * Approximate public list prices (USD / 1M tokens) used only for cost display.
 * Users can override prices per provider in config.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "o3": { input: 2, output: 8, cacheRead: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-3-7-sonnet-20250219": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-opus-4-20250514": { input: 15, output: 75, cacheRead: 1.5 },
};

/** Rough tokenizer: ~4 ASCII chars/token; CJK and other non-ASCII ~1 token/char. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) ascii++;
    else if (code >= 0xd800 && code <= 0xdbff) {
      wide++;
      i++;
    } else wide++;
  }
  return Math.ceil(ascii / 4) + wide;
}

export function estimateMessagesTokens(messages: Array<{ content: string; reasoning?: string }>): number {
  let total = 0;
  for (const m of messages) {
    total += 4 + estimateTokens(m.content) + estimateTokens(m.reasoning ?? "");
  }
  return total;
}

export function priceFor(model: string, override?: Price): Price | undefined {
  if (override) return override;
  if (DEFAULT_PRICES[model]) return DEFAULT_PRICES[model];
  // Match versioned snapshots by prefix (e.g. "gpt-4o-2024-08-06").
  const key = Object.keys(DEFAULT_PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? DEFAULT_PRICES[key] : undefined;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export function estimateCost(usage: CostInput, price: Price | undefined): number | undefined {
  if (!price) return undefined;
  const cached = usage.cacheReadTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const cachePrice = price.cacheRead ?? price.input;
  return (
    (uncachedInput / 1_000_000) * price.input +
    (cached / 1_000_000) * cachePrice +
    (usage.outputTokens / 1_000_000) * price.output
  );
}
