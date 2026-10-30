import { ConfigError } from "../utils/errors.ts";
import type { ResolvedProvider } from "../config/load.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAiCompatibleProvider } from "./openai.ts";
import type { Provider, ProviderFactoryOptions } from "./types.ts";

export function createProvider(resolved: ResolvedProvider): Provider {
  const opts: ProviderFactoryOptions = {
    id: resolved.name,
    type: resolved.type,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    headers: resolved.headers,
    timeoutMs: resolved.timeoutMs,
    options: resolved.raw.options,
  };
  switch (resolved.type) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider(opts);
    case "anthropic":
      return new AnthropicProvider(opts);
    case "ollama":
      return new OllamaProvider(opts);
    case "mock":
      return new MockProvider(opts);
    default:
      throw new ConfigError(`Unsupported provider type "${resolved.type}"`);
  }
}

export * from "./types.ts";
export * from "./sse.ts";
export * from "./http.ts";
export * from "./openai.ts";
export * from "./anthropic.ts";
export * from "./ollama.ts";
export * from "./mock.ts";
