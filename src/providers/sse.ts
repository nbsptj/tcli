/**
 * Server-Sent Events parser used by OpenAI-compatible and Anthropic providers.
 * Handles arbitrary chunk boundaries, CRLF, comments, multi-line data and
 * multi-byte UTF-8 sequences.
 */

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

const MAX_BUFFER = 8 * 1024 * 1024;

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;

  const dispatch = (): SseMessage | undefined => {
    if (!dataLines.length && !eventName) {
      id = undefined;
      retry = undefined;
      return undefined;
    }
    const msg: SseMessage = {
      data: dataLines.join("\n"),
      event: eventName,
      id,
      retry,
    };
    eventName = undefined;
    dataLines = [];
    id = undefined;
    retry = undefined;
    return msg;
  };

  const consumeLine = (line: string): SseMessage | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const n = Number(value);
        if (Number.isFinite(n)) retry = n;
        break;
      }
      default:
        break;
    }
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER) {
        throw new Error("SSE stream exceeded buffer limit without a complete event");
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const msg = consumeLine(line);
        if (msg) yield msg;
      }
    }
    buffer += decoder.decode();
    if (buffer.length) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const msg = consumeLine(line);
      if (msg) yield msg;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Parse newline-delimited JSON (Ollama streaming format). */
export async function* parseNdjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          throw new Error(`Malformed NDJSON line: ${line.slice(0, 200)}`);
        }
      }
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) {
      try {
        yield JSON.parse(rest);
      } catch {
        throw new Error(`Malformed NDJSON: ${rest.slice(0, 200)}`);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
