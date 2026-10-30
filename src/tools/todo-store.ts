import type { TodoItem } from "../types.ts";

const MAX_TODOS = 64;
const VALID_STATUS = new Set(["pending", "in_progress", "completed"]);

/** In-memory task list driving the progress panel (AG-4 / TL-6). */
export class TodoStore {
  private items: TodoItem[] = [];

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  replace(items: TodoItem[]): void {
    if (items.length > MAX_TODOS) throw new Error(`Too many todos (max ${MAX_TODOS})`);
    for (const item of items) {
      if (!item.content.trim()) throw new Error("Todo content must not be empty");
      if (!VALID_STATUS.has(item.status)) throw new Error(`Invalid todo status: ${item.status}`);
    }
    this.items = items.map((item) => ({ content: item.content.trim(), status: item.status }));
  }

  clear(): void {
    this.items = [];
  }

  restore(items: TodoItem[] | undefined): void {
    if (!Array.isArray(items)) return;
    try {
      this.replace(items);
    } catch {
      this.items = [];
    }
  }

  format(): string {
    if (!this.items.length) return "No todos.";
    const icon = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
    return this.items.map((item, i) => `${i + 1}. ${icon[item.status]} ${item.content}`).join("\n");
  }

  /** Compact progress string for the TUI status bar. */
  progress(): { done: number; total: number } {
    return { done: this.items.filter((i) => i.status === "completed").length, total: this.items.length };
  }
}
