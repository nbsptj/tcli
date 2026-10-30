import readline from "node:readline/promises";
import type { Asker, ConfirmationAnswer, ConfirmationRequest } from "../permissions/types.ts";
import type { ColorMode } from "./ansi.ts";
import { paint } from "./ansi.ts";
import { truncateText } from "../utils/strings.ts";
import { stdinIsTerminal } from "../utils/tty.ts";

export interface TerminalAskerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  colorMode?: ColorMode;
  theme?: "dark" | "light";
}

export interface TerminalAsker extends Asker {
  close(): void;
}

function renderPreview(preview: string, colorMode: ColorMode, theme: "dark" | "light"): string[] {
  const lines = preview.split("\n").slice(0, 60);
  const out: string[] = [];
  for (const line of lines) {
    let styled = line;
    if (line.startsWith("+++") || line.startsWith("---")) styled = paint(line, { fg: "muted" }, theme, colorMode);
    else if (line.startsWith("@@")) styled = paint(line, { fg: "diffMeta" }, theme, colorMode);
    else if (line.startsWith("+")) styled = paint(line, { fg: "diffAdd" }, theme, colorMode);
    else if (line.startsWith("-")) styled = paint(line, { fg: "diffDel" }, theme, colorMode);
    out.push("  │ " + styled);
  }
  if (preview.split("\n").length > lines.length) out.push("  │ … preview truncated");
  return out;
}

/**
 * Inline confirmation prompt for single-shot/headless mode. Defaults to deny;
 * output goes to stderr so stdout stays machine-readable.
 */
export function createTerminalAsker(opts: TerminalAskerOptions = {}): TerminalAsker | undefined {
  const input = opts.input ?? process.stdin;
  const output = (opts.output ?? process.stderr) as NodeJS.WriteStream;
  const colorMode = opts.colorMode ?? "none";
  const theme = opts.theme ?? "dark";
  if (!stdinIsTerminal()) return undefined;

  let rl: readline.Interface | undefined;
  const getRl = () => {
    if (!rl) rl = readline.createInterface({ input, output, terminal: true });
    return rl;
  };

  const ask: Asker = async (req: ConfirmationRequest): Promise<ConfirmationAnswer> => {
    output.write("\n");
    output.write(
      paint(`Permission required: ${req.tool}`, { fg: "warning", bold: true }, theme, colorMode) + "\n",
    );
    output.write(`  ${req.decision.reason}\n`);
    const preview = req.preview ?? "";
    if (preview.trim()) {
      for (const line of renderPreview(preview, colorMode, theme)) output.write(line + "\n");
    }
    const editable = req.kind === "exec";
    const promptText =
      `Allow? [y]es / [n]o (default) / [a]lways${editable ? " / [e]dit" : ""}: `;
    let answer = "";
    try {
      answer = (await getRl().question(promptText)).trim().toLowerCase();
    } catch {
      return { type: "no" };
    }
    if (answer === "y" || answer === "yes") return { type: "yes" };
    if (answer === "a" || answer === "always") return { type: "always" };
    if ((answer === "e" || answer === "edit") && editable) {
      let edited = "";
      try {
        edited = (await getRl().question("Edit command (empty cancels): ")).trim();
      } catch {
        return { type: "no" };
      }
      if (!edited) return { type: "no" };
      return { type: "edit", editedCommand: edited };
    }
    return { type: "no" };
  };

  return Object.assign(ask, {
    close() {
      rl?.close();
      rl = undefined;
    },
  });
}

/** Plain one-line prompt used by interactive CLI helpers. */
export async function promptLine(question: string, opts: TerminalAskerOptions = {}): Promise<string | undefined> {
  const input = opts.input ?? process.stdin;
  if (!stdinIsTerminal()) return undefined;
  const output = (opts.output ?? process.stderr) as NodeJS.WriteStream;
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function formatPermissionPreview(text: string, maxChars = 8000): string {
  return truncateText(text, maxChars);
}
