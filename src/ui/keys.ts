/** Terminal key sequence parser for raw-mode input. */

export type Key =
  | { type: "char"; char: string; shift?: boolean }
  | { type: "enter" }
  | { type: "newline" }
  | { type: "tab"; shift?: boolean }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left"; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { type: "right"; ctrl?: boolean; alt?: boolean; shift?: boolean }
  | { type: "up"; shift?: boolean }
  | { type: "down"; shift?: boolean }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "esc" }
  | { type: "ctrl"; char: string }
  | { type: "alt"; char: string }
  | { type: "paste"; text: string }
  | { type: "unknown"; sequence: string };

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const MAX_PASTE = 1_000_000;

function modifierBitsToKey(bits: number): { shift: boolean; alt: boolean; ctrl: boolean } {
  const mod = bits - 1;
  return { shift: (mod & 1) !== 0, alt: (mod & 2) !== 0, ctrl: (mod & 4) !== 0 };
}

/**
 * Incremental parser: escape sequences and UTF-8 characters may be split
 * across reads. Incomplete CSI/SS3 sequences stay buffered; a lone ESC is
 * emitted as an Esc key after `flushEscape()` (the reader calls this on a short
 * timer so Alt+key still works when terminals send it in one chunk).
 */
export class KeyParser {
  private buffer = "";
  private pasteMode = false;
  private pasteBuffer = "";

  feed(chunk: string): Key[] {
    this.buffer += chunk;
    return this.parse();
  }

  hasPending(): boolean {
    return this.buffer.startsWith("\u001b") || this.pasteMode;
  }

  isPasting(): boolean {
    return this.pasteMode;
  }

  flushEscape(): Key[] {
    if (!this.buffer) return [];
    if (this.pasteMode) return [];
    if (this.buffer === "\u001b") {
      this.buffer = "";
      return [{ type: "esc" }];
    }
    if (this.buffer.startsWith("\u001b[") || this.buffer.startsWith("\u001bO")) {
      const sequence = this.buffer;
      this.buffer = "";
      return [{ type: "unknown", sequence }];
    }
    return [];
  }

  private parse(): Key[] {
    const keys: Key[] = [];
    for (;;) {
      if (this.pasteMode) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) {
          if (this.buffer.length > MAX_PASTE) {
            keys.push({ type: "paste", text: this.pasteBuffer + this.buffer.slice(0, MAX_PASTE) });
            this.buffer = this.buffer.slice(MAX_PASTE);
            this.pasteBuffer = "";
            this.pasteMode = false;
          }
          return keys;
        }
        this.pasteBuffer += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        keys.push({ type: "paste", text: this.pasteBuffer });
        this.pasteBuffer = "";
        this.pasteMode = false;
        continue;
      }
      if (!this.buffer) return keys;
      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.pasteMode = true;
        continue;
      }

      const first = this.buffer.codePointAt(0)!;
      const firstChar = String.fromCodePoint(first);

      if (firstChar === "\u001b") {
        if (this.buffer.length === 1) return keys;
        const second = this.buffer[1]!;
        if (second === "[") {
          let finalIndex = -1;
          for (let i = 2; i < this.buffer.length; i++) {
            const code = this.buffer.charCodeAt(i);
            if (code >= 0x40 && code <= 0x7e) {
              finalIndex = i;
              break;
            }
          }
          if (finalIndex < 0) return keys;
          const sequence = this.buffer.slice(0, finalIndex + 1);
          this.buffer = this.buffer.slice(finalIndex + 1);
          keys.push(...this.parseCsi(sequence));
          continue;
        }
        if (second === "O") {
          if (this.buffer.length < 3) return keys;
          const sequence = this.buffer.slice(0, 3);
          this.buffer = this.buffer.slice(3);
          keys.push(...this.parseSs3(sequence));
          continue;
        }
        // Alt + character (may be multi-byte).
        const altChar = String.fromCodePoint(this.buffer.codePointAt(1)!);
        this.buffer = this.buffer.slice(1 + altChar.length);
        keys.push({ type: "alt", char: altChar });
        continue;
      }

      this.buffer = this.buffer.slice(firstChar.length);
      const code = firstChar.charCodeAt(0);
      if (code === 13) {
        keys.push({ type: "enter" });
        continue;
      }
      if (code === 10) {
        keys.push({ type: "newline" });
        continue;
      }
      if (code === 9) {
        keys.push({ type: "tab" });
        continue;
      }
      if (code === 127 || code === 8) {
        keys.push({ type: "backspace" });
        continue;
      }
      if (code > 0 && code < 32) {
        keys.push({ type: "ctrl", char: String.fromCharCode(code + 64) });
        continue;
      }
      keys.push({ type: "char", char: firstChar });
    }
  }

  private parseCsi(sequence: string): Key[] {
    const body = sequence.slice(2, -1);
    const final = sequence.slice(-1);
    const params = body.split(";");
    switch (final) {
      case "A": {
        const mods = params[1] ? modifierBitsToKey(Number(params[1])) : undefined;
        return [{ type: "up", shift: mods?.shift }];
      }
      case "B": {
        const mods = params[1] ? modifierBitsToKey(Number(params[1])) : undefined;
        return [{ type: "down", shift: mods?.shift }];
      }
      case "C": {
        const mods = params[1] ? modifierBitsToKey(Number(params[1])) : undefined;
        return [{ type: "right", ctrl: mods?.ctrl, alt: mods?.alt, shift: mods?.shift }];
      }
      case "D": {
        const mods = params[1] ? modifierBitsToKey(Number(params[1])) : undefined;
        return [{ type: "left", ctrl: mods?.ctrl, alt: mods?.alt, shift: mods?.shift }];
      }
      case "H":
        return [{ type: "home" }];
      case "F":
        return [{ type: "end" }];
      case "Z":
        return [{ type: "tab", shift: true }];
      case "u":
        return this.parseKitty(body);
      case "~": {
        const value = Number(params[0] ?? "0");
        if (value === 1 || value === 7) return [{ type: "home" }];
        if (value === 4 || value === 8) return [{ type: "end" }];
        if (value === 3) return [{ type: "delete" }];
        if (value === 5) return [{ type: "pageup" }];
        if (value === 6) return [{ type: "pagedown" }];
        if (value === 200) {
          this.pasteMode = true;
          return [];
        }
        return [{ type: "unknown", sequence }];
      }
      default:
        return [{ type: "unknown", sequence }];
    }
  }

  private parseSs3(sequence: string): Key[] {
    const final = sequence.slice(-1);
    switch (final) {
      case "A":
        return [{ type: "up" }];
      case "B":
        return [{ type: "down" }];
      case "C":
        return [{ type: "right" }];
      case "D":
        return [{ type: "left" }];
      case "H":
        return [{ type: "home" }];
      case "F":
        return [{ type: "end" }];
      default:
        return [{ type: "unknown", sequence }];
    }
  }

  private parseKitty(body: string): Key[] {
    // Format: codepoint[;modifiers[:event]][;text]u
    const parts = body.split(";");
    const codePoint = Number(parts[0]);
    if (!Number.isFinite(codePoint)) return [{ type: "unknown", sequence: `\u001b[${body}u` }];
    const modPart = parts[1] ?? "1";
    const mods = modifierBitsToKey(Number(modPart.split(":")[0] ?? "1"));
    if (codePoint === 13) return mods.shift ? [{ type: "newline" }] : [{ type: "enter" }];
    if (codePoint === 9) return [{ type: "tab", shift: mods.shift }];
    if (codePoint === 27) return [{ type: "esc" }];
    if (codePoint === 127 || codePoint === 8) return [{ type: "backspace" }];
    if (codePoint === 3) return [{ type: "ctrl", char: "C" }];
    const char = String.fromCodePoint(codePoint);
    if (mods.ctrl && /^[a-zA-Z]$/.test(char)) return [{ type: "ctrl", char: char.toUpperCase() }];
    if (mods.alt) return [{ type: "alt", char }];
    return [{ type: "char", char, shift: mods.shift }];
  }
}
