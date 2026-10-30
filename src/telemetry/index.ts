import type { Config } from "../config/schema.ts";
import { TCLI_VERSION } from "../types.ts";

export interface TelemetryData {
  reason: string;
  success: boolean;
  durationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
}

/**
 * Opt-in, anonymous session telemetry (OB-5). Disabled by default; requires an
 * explicit endpoint, and never includes prompts, file paths or command output.
 */
export async function reportTelemetry(config: Config, data: TelemetryData): Promise<void> {
  if (!config.telemetry.enabled || !config.telemetry.endpoint) return;
  const payload = {
    version: 1,
    tcli: TCLI_VERSION,
    event: "session_end",
    os: process.platform,
    arch: process.arch,
    ...data,
    model: data.model,
  };
  try {
    await fetch(config.telemetry.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `tcli/${TCLI_VERSION}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* telemetry must never affect the session */
  }
}
