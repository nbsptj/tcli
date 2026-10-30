import path from "node:path";
import type { Agent } from "../agent/agent.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { Config } from "../config/schema.ts";
import { providerModelList } from "../config/defaults.ts";
import { missingApiKeyHint, resolveProvider } from "../config/load.ts";
import { createProvider } from "../providers/index.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import type { ConfirmationAnswer, ConfirmationRequest } from "../permissions/types.ts";
import {
  generateTraceId,
  listSessions,
  readSession,
  SessionStore,
  sessionToMarkdown,
} from "../session/index.ts";
import type { LoadedSession, SessionSummary } from "../session/types.ts";
import type { TodoItem, Usage } from "../types.ts";
import { TCLI_VERSION } from "../types.ts";
import { describeError } from "../utils/errors.ts";
import { ensureDirSync, writeFileAtomicSync } from "../utils/fs.ts";
import { displayPath, tildePath } from "../utils/paths.ts";
import {
  formatCost,
  formatRelativeTime,
  formatTokens,
  toOneLine,
  truncateText,
} from "../utils/strings.ts";
import { initProject } from "../commands/init.ts";
import { expandCustomCommand, type CustomCommand } from "../commands/custom.ts";
import { PathCompleter } from "../context/references.ts";
import { terminalSize } from "../utils/tty.ts";
import type { Logger } from "../log/logger.ts";
import {
  paint,
  segmentsWidth,
  stringWidth,
  textLine,
  truncateSegments,
  wrapSegments,
  type ColorMode,
  type DisplayLine,
  type Style,
} from "./ansi.ts";
import { LineEditor, applyCompletion, detectCompletion, type CompletionContext } from "./editor.ts";
import type { Key } from "./keys.ts";
import { Screen } from "./screen.ts";
import { TerminalInput } from "./terminal.ts";
import { summarizeToolInput, todoLines, Transcript } from "./transcript.ts";

interface PickerItem {
  label: string;
  description?: string;
  value?: unknown;
}

type Modal =
  | {
      kind: "confirm";
      req: ConfirmationRequest;
      resolve: (answer: ConfirmationAnswer) => void;
      selected: number;
      scroll: number;
    }
  | {
      kind: "picker";
      title: string;
      items: PickerItem[];
      selected: number;
      resolve: (item: PickerItem | undefined) => void;
      scroll: number;
    };

interface MenuItem {
  label: string;
  description?: string;
  completion: { path: string; isDir: boolean } | { name: string; kind: "command" };
}

interface Menu {
  context: CompletionContext;
  items: MenuItem[];
  selected: number;
}

interface EditMode {
  req: ConfirmationRequest;
  resolve: (answer: ConfirmationAnswer) => void;
}

export interface TuiOptions {
  agent: Agent;
  config: Config;
  permissions: PermissionEngine;
  session: SessionStore;
  workspace: string;
  colorMode: ColorMode;
  theme: "dark" | "light";
  logger: Logger;
  warnings?: string[];
  initialPrompt?: string;
  loaded?: LoadedSession;
  customCommands: CustomCommand[];
  pathCompleter?: PathCompleter;
  createAgent: (session: SessionStore, loaded?: LoadedSession) => Agent;
  onExit?: (session: SessionStore) => void | Promise<void>;
  /** Output sink (tests inject a no-op; defaults to stdout). */
  write?: (chunk: string) => void;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const BUILTIN_COMMANDS: Array<{ name: string; description: string; argumentHint?: string }> = [
  { name: "help", description: "Show commands and keybindings" },
  { name: "model", description: "Switch model", argumentHint: "[provider/model]" },
  { name: "clear", description: "Start a new session and clear the view" },
  { name: "resume", description: "Resume a previous session", argumentHint: "[id]" },
  { name: "cost", description: "Show token usage and estimated cost" },
  { name: "permissions", description: "Show permission policy and session grants" },
  { name: "undo", description: "Undo the last file edit checkpoint" },
  { name: "init", description: "Create project config and AGENTS.md" },
  { name: "export", description: "Export this session to Markdown" },
  { name: "rename", description: "Rename the current session", argumentHint: "[title]" },
  { name: "verbose", description: "Toggle verbose reasoning/debug output" },
  { name: "quit", description: "Exit tcli" },
];

/** Interactive full-screen TUI. */
export class Tui {
  private readonly options: TuiOptions;
  private agent: Agent;
  private session: SessionStore;
  private readonly config: Config;
  private readonly permissions: PermissionEngine;
  private readonly workspace: string;
  private readonly colorMode: ColorMode;
  private readonly theme: "dark" | "light";
  private readonly logger: Logger;
  private readonly pathCompleter: PathCompleter;
  private readonly lang: "en" | "zh";
  private readonly screen: Screen;
  private readonly input: TerminalInput;
  private readonly editor = new LineEditor();
  private readonly transcript = new Transcript();

  private todos: TodoItem[] = [];
  private menu?: Menu;
  private modal?: Modal;
  private editMode?: EditMode;
  private running = false;
  private verbose = false;
  private spinnerIndex = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private renderScheduled = false;
  private scrollOffset = 0;
  private autoScroll = true;
  private lastCtrlC = 0;
  private runStartedAt = 0;
  private exiting = false;
  private seeded = false;
  private doneResolve?: (code: number) => void;
  private readonly donePromise: Promise<number>;
  private exitCode = 0;
  private readonly sigwinchHandler: () => void;
  private readonly sigtermHandler: () => void;
  private readonly sigintHandler: () => void;
  private readonly sighupHandler: () => void;
  private readonly exitHandler: () => void;

  constructor(options: TuiOptions) {
    this.options = options;
    this.agent = options.agent;
    this.session = options.session;
    this.config = options.config;
    this.permissions = options.permissions;
    this.workspace = options.workspace;
    this.colorMode = options.colorMode;
    this.theme = options.theme;
    this.logger = options.logger;
    this.verbose = options.config.logging.level === "debug";
    this.pathCompleter = options.pathCompleter ?? new PathCompleter(options.workspace);
    this.lang = options.config.ui.language;
    this.donePromise = new Promise<number>((resolve) => {
      this.doneResolve = resolve;
    });
    const size = terminalSize();
    const width = size.columns;
    const height = size.rows;
    this.screen = new Screen({
      write: options.write ?? ((chunk) => process.stdout.write(chunk)),
      mode: this.colorMode,
      theme: this.theme,
      width,
      height,
    });
    this.input = new TerminalInput({
      onKey: (key) => this.handleKey(key),
      onActivity: () => this.requestRender(),
      onError: (err) => {
        this.transcript.addError(`Input error: ${err.message}`);
        void this.exit(1);
      },
      onEnd: () => {
        void this.exit(0);
      },
    });
    this.sigwinchHandler = () => this.handleResize();
    this.sigtermHandler = () => {
      void this.exit(143);
    };
    this.sigintHandler = () => this.handleCtrlC();
    this.sighupHandler = () => {
      void this.exit(129);
    };
    this.exitHandler = () => this.input.restoreSync();
  }

  async start(): Promise<void> {
    this.seedTranscript();
    const size = terminalSize();
    this.screen.setSize(size.columns, size.rows);
    this.screen.enterAlternateScreen();
    this.permissions.setAsker((req) => this.askPermission(req));
    process.on("SIGWINCH", this.sigwinchHandler);
    process.on("SIGTERM", this.sigtermHandler);
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGHUP", this.sighupHandler);
    process.once("exit", this.exitHandler);
    try {
      await this.input.start();
    } catch (err) {
      this.permissions.setAsker(undefined);
      process.off("SIGWINCH", this.sigwinchHandler);
      process.off("SIGTERM", this.sigtermHandler);
      process.off("SIGINT", this.sigintHandler);
      process.off("SIGHUP", this.sighupHandler);
      process.off("exit", this.exitHandler);
      await this.input.stop().catch(() => undefined);
      this.screen.leaveAlternateScreen();
      throw err;
    }
    this.requestRender(true);
    if (this.options.initialPrompt?.trim()) {
      const prompt = this.options.initialPrompt;
      setTimeout(() => {
        if (!this.exiting) this.dispatchInput(prompt);
      }, 30);
    }
  }

  wait(): Promise<number> {
    return this.donePromise;
  }

  private seedTranscript(): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const warning of this.options.warnings ?? []) {
      if (warning) this.transcript.addNotice("warn", warning);
    }
    if (this.options.loaded) {
      this.transcript.restore(this.options.loaded.messages);
      this.todos = this.options.loaded.todos;
      this.transcript.addNotice(
        "info",
        `Resumed session ${this.session.id} (${this.options.loaded.messages.length} messages).`,
      );
      if (!this.options.loaded.messages.length) this.addWelcome();
    } else {
      this.addWelcome();
    }
    const history = this.options.loaded?.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .slice(-100);
    if (history?.length) this.editor.setHistory(history);
  }

  private t(en: string, zh: string): string {
    return this.lang === "zh" ? zh : en;
  }

  private addWelcome(): void {
    const lines =
      this.lang === "zh"
        ? [
            `tcli ${TCLI_VERSION} · ${this.agent.providerName}/${this.agent.model}`,
            `工作区：${this.workspace}`,
            `权限：${this.config.permissions.mode} · 沙箱：${this.config.sandbox.mode}`,
            "",
            "直接输入任务。@路径 附加文件，/help 查看命令。",
            "Esc 中断正在运行的任务；Ctrl+C 两次退出。",
          ]
        : [
            `tcli ${TCLI_VERSION} · ${this.agent.providerName}/${this.agent.model}`,
            `Workspace: ${this.workspace}`,
            `Permissions: ${this.config.permissions.mode} · sandbox: ${this.config.sandbox.mode}`,
            "",
            "Type a task. @path attaches files, /help lists commands.",
            "Esc interrupts a running task; Ctrl+C twice exits.",
          ];
    this.transcript.addSystem(lines.join("\n"));
  }

  private handleResize(): void {
    const size = terminalSize();
    this.screen.setSize(size.columns, size.rows);
    this.refreshMenu();
    this.requestRender(true);
  }

  private requestRender(immediate = false): void {
    if (this.exiting) return;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderTimer = setTimeout(
      () => {
        this.renderScheduled = false;
        this.renderTimer = undefined;
        this.render();
      },
      immediate ? 0 : 16,
    );
  }

  private render(): void {
    if (this.exiting) return;
    try {
      const frame = this.compose();
      this.screen.render(frame.lines, frame.cursor);
    } catch (err) {
      this.logger.exception(err, "tui render failed");
    }
  }

  private compose(): { lines: DisplayLine[]; cursor?: { row: number; col: number } } {
    const { width, height } = this.screen.size;
    if (this.modal) return { lines: this.composeModal(width, height) };

    const header: DisplayLine[] = [this.headerLine(width)];
    let showTodo = this.todos.length > 0;
    let showMenu = Boolean(this.menu);
    let showHints = true;
    let bottom = this.buildBottom(width, { todo: showTodo, menu: showMenu, hints: showHints });
    while (1 + 1 + bottom.lines.length > height) {
      if (showHints) showHints = false;
      else if (showTodo) showTodo = false;
      else if (showMenu) showMenu = false;
      else break;
      bottom = this.buildBottom(width, { todo: showTodo, menu: showMenu, hints: showHints });
    }
    const topHeight = Math.max(1, height - bottom.lines.length);
    const transcriptHeight = Math.max(1, topHeight - 1);
    const all = this.transcript.render(width - 2, {
      spinner: SPINNER[this.spinnerIndex % SPINNER.length],
      showReasoning: this.verbose,
    });
    const end = Math.max(0, all.length - this.scrollOffset);
    const start = Math.max(0, end - transcriptHeight);
    const visible = all.slice(start, end);
    const lines: DisplayLine[] = [...header];
    for (const line of visible) lines.push([{ text: " " }, ...line]);
    while (lines.length < topHeight) lines.push([]);
    lines.push(...bottom.lines);
    const cursor = {
      row: topHeight + bottom.cursorRow,
      col: bottom.cursorCol,
    };
    return { lines, cursor };
  }

  private headerLine(width: number): DisplayLine {
    const title = this.session.meta.title && this.session.meta.title !== "New session" ? this.session.meta.title : "";
    const segments: DisplayLine = [
      { text: " tcli ", style: { fg: "accent", bold: true } },
      { text: TCLI_VERSION, style: { fg: "muted" } },
      { text: "  " },
      { text: `${this.agent.providerName}/${this.agent.model}`, style: { fg: "text" } },
    ];
    if (this.config.permissions.mode !== "default") {
      segments.push({ text: `  ${this.config.permissions.mode}`, style: { fg: "warning" } });
    }
    if (title) segments.push({ text: `  ${title}`, style: { fg: "muted" } });
    return truncateSegments(segments, width);
  }

  private buildBottom(
    width: number,
    opts: { todo: boolean; menu: boolean; hints: boolean },
  ): { lines: DisplayLine[]; cursorRow: number; cursorCol: number } {
    const lines: DisplayLine[] = [];
    const add = (line: DisplayLine) => lines.push([{ text: " " }, ...line]);
    if (opts.todo && this.todos.length) {
      for (const line of todoLines(this.todos, width - 2)) add(line);
    }
    if (opts.menu && this.menu) {
      for (const [index, item] of this.menu.items.entries()) {
        const selected = index === this.menu.selected;
        const marker = selected ? "› " : "  ";
        const style: Style = selected ? { inverse: true } : { fg: "muted" };
        const text = `${marker}${item.label}${item.description ? `  ${item.description}` : ""}`;
        add(truncateSegments([{ text, style }], width - 2));
      }
    }
    add(textLine("─".repeat(Math.max(4, width - 2)), { fg: "muted" }));
    const inputStart = lines.length;
    const maxInput = this.screen.size.height < 16 ? 2 : 6;
    const rendered = this.editor.render(width - 2, "› ", maxInput);
    const promptWidth = stringWidth("› ");
    for (const line of rendered.lines) {
      const chars = [...line];
      const head = chars.slice(0, promptWidth).join("");
      const rest = chars.slice(promptWidth).join("");
      add([
        { text: head, style: { fg: "accent", bold: true } },
        { text: rest, style: { fg: "text" } },
      ]);
    }
    add(this.statusLine(width));
    if (opts.hints) add(this.hintLine());
    return {
      lines,
      cursorRow: inputStart + rendered.cursorRow,
      cursorCol: 1 + rendered.cursorCol,
    };
  }

  private statusLine(width: number): DisplayLine {
    const usage = this.agent.usage;
    const total = usage.inputTokens + usage.outputTokens;
    const cost = this.agent.usageCostUsd();
    const parts: DisplayLine = [];
    const push = (text: string, style?: Style) => {
      if (parts.length) parts.push({ text: " · ", style: { fg: "muted" } });
      parts.push({ text, style });
    };
    if (this.editMode) {
      push(this.t("editing command", "编辑命令中"), { fg: "warning", bold: true });
    } else if (this.running) {
      const elapsed = Math.max(0, Math.round((Date.now() - this.runStartedAt) / 1000));
      push(`${SPINNER[this.spinnerIndex % SPINNER.length]} ${this.t("working", "运行中")} ${elapsed}s`, {
        fg: "warning",
      });
    } else {
      push(this.t("ready", "就绪"), { fg: "success" });
    }
    push(`${formatTokens(total)} tok`, { fg: "muted" });
    push(cost !== undefined ? formatCost(cost) : this.t("cost n/a", "费用未知"), { fg: "muted" });
    const done = this.todos.filter((t) => t.status === "completed").length;
    if (this.todos.length) push(`${this.t("plan", "计划")} ${done}/${this.todos.length}`, { fg: "accent" });
    push(`${this.t("sess", "会话")} ${this.session.id.slice(-8)}`, { fg: "muted" });
    return truncateSegments(parts, width - 2);
  }

  private hintLine(): DisplayLine {
    const text = this.editMode
      ? this.t("Enter run edited command · Esc cancel", "Enter 执行编辑后的命令 · Esc 取消")
      : this.running
        ? this.t(
            "Esc stop · Ctrl+C twice exit · you can type the next instruction",
            "Esc 停止 · Ctrl+C 两次退出 · 可先输入下一条指令",
          )
        : this.menu
          ? this.t("↑/↓ select · Tab complete · Esc close", "↑/↓ 选择 · Tab 补全 · Esc 关闭")
          : this.t(
              "Enter send · Shift+Enter newline · Tab complete · @ files · / commands · Ctrl+C twice exit",
              "Enter 发送 · Shift+Enter 换行 · Tab 补全 · @ 文件 · / 命令 · Ctrl+C 两次退出",
            );
    return [{ text, style: { fg: "muted", dim: true } }];
  }

  private composeModal(width: number, height: number): DisplayLine[] {
    const modal = this.modal!;
    if (modal.kind === "picker") {
      const lines: DisplayLine[] = [
        truncateSegments([{ text: ` ${modal.title}`, style: { fg: "accent", bold: true } }], width),
        [],
      ];
      const available = Math.max(1, height - 4);
      const maxScroll = Math.max(0, modal.items.length - available);
      modal.scroll = Math.min(Math.max(0, modal.scroll), maxScroll);
      if (modal.selected < modal.scroll) modal.scroll = modal.selected;
      if (modal.selected >= modal.scroll + available) modal.scroll = modal.selected - available + 1;
      const slice = modal.items.slice(modal.scroll, modal.scroll + available);
      if (!slice.length) lines.push([{ text: "  (empty)", style: { fg: "muted" } }]);
      for (const [offset, item] of slice.entries()) {
        const index = modal.scroll + offset;
        const selected = index === modal.selected;
        const marker = selected ? "› " : "  ";
        const style: Style = selected ? { inverse: true } : { fg: "text" };
        lines.push(
          truncateSegments(
            [
              { text: `${marker}${item.label}`, style },
              { text: item.description ? `  ${item.description}` : "", style: { fg: "muted" } },
            ],
            width,
          ),
        );
      }
      lines.push([]);
      lines.push([
        {
          text: this.t(" ↑/↓ select · Enter choose · Esc cancel", " ↑/↓ 选择 · Enter 确认 · Esc 取消"),
          style: { fg: "muted", dim: true },
        },
      ]);
      return lines;
    }

    const req = modal.req;
    const lines: DisplayLine[] = [];
    lines.push(
      truncateSegments(
        [
          {
            text: this.t(` Permission required · ${req.tool}`, ` 需要确认 · ${req.tool}`),
            style: { fg: "warning", bold: true },
          },
        ],
        width,
      ),
    );
    const reasonLines = wrapSegments([{ text: ` ${req.decision.reason}`, style: { fg: "text" } }], width);
    lines.push(...reasonLines.slice(0, 3));
    lines.push([]);
    const options = this.confirmOptions(req);
    const hints: DisplayLine[] = [
      [
        {
          text: this.t(
            " ←/→ choose · Enter confirm · y/n/a/e quick · PgUp/PgDn scroll · Esc deny",
            " ←/→ 选择 · Enter 确认 · y/n/a/e 快捷 · PgUp/PgDn 滚动 · Esc 拒绝",
          ),
          style: { fg: "muted", dim: true },
        },
      ],
    ];
    const previewLines = this.renderPreview(req.preview ?? "", width);
    // Reserve the blank separator, options row, hint row and a possible scroll indicator.
    const available = Math.max(1, height - lines.length - 4);
    const maxScroll = Math.max(0, previewLines.length - available);
    modal.scroll = Math.min(Math.max(0, modal.scroll), maxScroll);
    if (!previewLines.length) {
      lines.push([{ text: " (no preview)", style: { fg: "muted" } }]);
    } else {
      lines.push(...previewLines.slice(modal.scroll, modal.scroll + available));
      if (previewLines.length > available) {
        lines.push([
          {
            text: ` … lines ${modal.scroll + 1}-${Math.min(previewLines.length, modal.scroll + available)} of ${previewLines.length}`,
            style: { fg: "muted" },
          },
        ]);
      }
    }
    lines.push([]);
    const optionSegments: DisplayLine = [];
    options.forEach((option, index) => {
      if (index > 0) optionSegments.push({ text: "   " });
      optionSegments.push({
        text: `${index === modal.selected ? "› " : "  "}${option.label}`,
        style: index === modal.selected ? { inverse: true } : { fg: "text" },
      });
    });
    lines.push(truncateSegments(optionSegments, width));
    lines.push(...hints);
    return lines;
  }

  private renderPreview(preview: string, width: number): DisplayLine[] {
    const raw = preview.split("\n").slice(0, 600);
    const lines: DisplayLine[] = [];
    for (const line of raw) {
      let style: Style = { fg: "text" };
      if (line.startsWith("+++") || line.startsWith("---")) style = { fg: "muted" };
      else if (line.startsWith("@@")) style = { fg: "diffMeta" };
      else if (line.startsWith("+")) style = { fg: "diffAdd" };
      else if (line.startsWith("-")) style = { fg: "diffDel" };
      lines.push(
        ...wrapSegments([{ text: line, style }], width - 1).map((l) => [{ text: " " }, ...l]),
      );
    }
    if (preview.split("\n").length > raw.length) {
      lines.push([{ text: " … preview truncated", style: { fg: "muted" } }]);
    }
    return lines;
  }

  private confirmOptions(req: ConfirmationRequest): Array<{ label: string; answer: ConfirmationAnswer }> {
    const options: Array<{ label: string; answer: ConfirmationAnswer }> = [
      { label: this.t("[y] allow once", "[y] 允许一次"), answer: { type: "yes" } },
      { label: this.t("[n] deny", "[n] 拒绝"), answer: { type: "no" } },
      { label: this.t("[a] always this session", "[a] 本会话总是允许"), answer: { type: "always" } },
    ];
    if (req.kind === "exec") {
      options.push({ label: this.t("[e] edit command", "[e] 编辑命令"), answer: { type: "edit" } });
    }
    return options;
  }

  private askPermission(req: ConfirmationRequest): Promise<ConfirmationAnswer> {
    if (this.exiting) return Promise.resolve({ type: "no" });
    if (this.modal?.kind === "confirm") {
      this.modal.resolve({ type: "no" });
      this.modal = undefined;
    }
    return new Promise<ConfirmationAnswer>((resolve) => {
      this.modal = {
        kind: "confirm",
        req,
        resolve,
        selected: 1,
        scroll: 0,
      };
      this.requestRender(true);
    });
  }

  private picker(title: string, items: PickerItem[]): Promise<PickerItem | undefined> {
    return new Promise((resolve) => {
      this.modal = { kind: "picker", title, items, selected: 0, resolve, scroll: 0 };
      this.requestRender(true);
    });
  }

  private finishConfirm(answer: ConfirmationAnswer): void {
    const modal = this.modal;
    this.modal = undefined;
    if (modal?.kind === "confirm") modal.resolve(answer);
    this.menu = undefined;
    this.requestRender(true);
  }

  private startEdit(): void {
    const modal = this.modal;
    if (modal?.kind !== "confirm" || modal.req.kind !== "exec") return;
    this.modal = undefined;
    this.editMode = { req: modal.req, resolve: modal.resolve };
    this.editor.setText(String(modal.req.command ?? ""));
    this.requestRender(true);
  }

  private submitEdit(): void {
    const edit = this.editMode;
    if (!edit) return;
    this.editMode = undefined;
    const text = this.editor.text.trim();
    this.editor.clear();
    edit.resolve(text ? { type: "edit", editedCommand: text } : { type: "no" });
    this.autoScroll = true;
    this.scrollOffset = 0;
    this.requestRender(true);
  }

  private cancelEdit(): void {
    const edit = this.editMode;
    this.editMode = undefined;
    this.editor.clear();
    edit?.resolve({ type: "no" });
    this.requestRender(true);
  }

  private handleKey(key: Key): void {
    if (key.type === "ctrl" && key.char === "C") {
      this.handleCtrlC();
      return;
    }
    if (this.modal) {
      this.handleModalKey(key);
      return;
    }
    if (this.editMode) {
      if (key.type === "esc") {
        this.cancelEdit();
        return;
      }
      if (key.type === "enter") {
        this.submitEdit();
        return;
      }
    }
    if (key.type === "ctrl" && key.char === "L") {
      this.transcript.clear();
      this.scrollOffset = 0;
      this.screen.clear();
      this.requestRender(true);
      return;
    }
    if (key.type === "ctrl" && key.char === "D") {
      if (this.editor.isEmpty && !this.running) {
        void this.exit(0);
      } else {
        this.editor.deleteForward();
        this.refreshMenu();
        this.requestRender();
      }
      return;
    }
    if (key.type === "ctrl" && key.char === "U") {
      this.editor.deleteToLineStart();
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "ctrl" && key.char === "K") {
      this.editor.deleteToLineEnd();
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "ctrl" && key.char === "W") {
      this.editor.deleteWordBackward();
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "ctrl" && key.char === "A") {
      this.editor.moveHome();
      this.requestRender();
      return;
    }
    if (key.type === "ctrl" && key.char === "E") {
      this.editor.moveEnd();
      this.requestRender();
      return;
    }
    if (key.type === "esc") {
      if (this.menu) {
        this.menu = undefined;
        this.requestRender();
        return;
      }
      if (this.running) {
        this.agent.cancel();
        this.transcript.addNotice("info", "Interrupting…");
        this.requestRender(true);
        return;
      }
      return;
    }
    if (key.type === "pageup") {
      const all = this.transcript.render(this.screen.size.width - 2, {
        spinner: SPINNER[this.spinnerIndex % SPINNER.length],
        showReasoning: this.verbose,
      });
      this.scrollOffset = Math.min(all.length, this.scrollOffset + Math.max(1, this.screen.size.height - 8));
      this.autoScroll = false;
      this.requestRender();
      return;
    }
    if (key.type === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.screen.size.height - 8));
      if (this.scrollOffset === 0) this.autoScroll = true;
      this.requestRender();
      return;
    }
    if (key.type === "tab") {
      if (this.menu) this.applySelectedCompletion();
      else this.refreshMenu();
      this.requestRender();
      return;
    }
    if ((key.type === "up" || key.type === "down") && this.menu) {
      const count = this.menu.items.length;
      if (count) {
        this.menu.selected =
          key.type === "up" ? (this.menu.selected - 1 + count) % count : (this.menu.selected + 1) % count;
      }
      this.requestRender();
      return;
    }
    if (key.type === "enter") {
      this.handleEnter();
      return;
    }
    if (key.type === "newline") {
      this.editor.insert("\n");
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "char") {
      this.editor.insert(key.char);
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "paste") {
      this.editor.insert(key.text);
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "backspace") {
      this.editor.backspace();
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "delete") {
      this.editor.deleteForward();
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "left") {
      this.editor.moveLeft(Boolean(key.ctrl || key.alt));
      this.requestRender();
      return;
    }
    if (key.type === "right") {
      this.editor.moveRight(Boolean(key.ctrl || key.alt));
      this.requestRender();
      return;
    }
    if (key.type === "home") {
      this.editor.moveHome();
      this.requestRender();
      return;
    }
    if (key.type === "end") {
      this.editor.moveEnd();
      this.requestRender();
      return;
    }
    if (key.type === "up" || key.type === "down") {
      if (this.editor.text.includes("\n")) {
        const moved = key.type === "up" ? this.editor.moveUp() : this.editor.moveDown();
        if (moved) {
          this.requestRender();
          return;
        }
      }
      if (key.type === "up") this.editor.historyPrev();
      else this.editor.historyNext();
      this.refreshMenu();
      this.requestRender();
      return;
    }
    if (key.type === "alt") {
      // Ignore Alt+key chords we do not bind.
      return;
    }
  }

  private handleModalKey(key: Key): void {
    const modal = this.modal!;
    if (modal.kind === "picker") {
      if (key.type === "esc" || (key.type === "ctrl" && key.char === "C")) {
        this.modal = undefined;
        modal.resolve(undefined);
        this.requestRender(true);
        return;
      }
      if (key.type === "up") {
        modal.selected = Math.max(0, modal.selected - 1);
        this.requestRender();
        return;
      }
      if (key.type === "down") {
        modal.selected = Math.min(modal.items.length - 1, modal.selected + 1);
        this.requestRender();
        return;
      }
      if (key.type === "pageup") {
        modal.selected = Math.max(0, modal.selected - 10);
        this.requestRender();
        return;
      }
      if (key.type === "pagedown") {
        modal.selected = Math.min(modal.items.length - 1, modal.selected + 10);
        this.requestRender();
        return;
      }
      if (key.type === "enter") {
        const item = modal.items[modal.selected];
        this.modal = undefined;
        modal.resolve(item);
        this.requestRender(true);
        return;
      }
      return;
    }

    const options = this.confirmOptions(modal.req);
    if (key.type === "esc") {
      this.finishConfirm({ type: "no" });
      return;
    }
    if (key.type === "left" || (key.type === "tab" && key.shift)) {
      modal.selected = (modal.selected - 1 + options.length) % options.length;
      this.requestRender();
      return;
    }
    if (key.type === "right" || key.type === "tab") {
      modal.selected = (modal.selected + 1) % options.length;
      this.requestRender();
      return;
    }
    if (key.type === "pageup") {
      modal.scroll = Math.max(0, modal.scroll - 5);
      this.requestRender();
      return;
    }
    if (key.type === "pagedown") {
      modal.scroll += 5;
      this.requestRender();
      return;
    }
    if (key.type === "enter") {
      const option = options[Math.min(modal.selected, options.length - 1)]!;
      if (option.answer.type === "edit") this.startEdit();
      else this.finishConfirm(option.answer);
      return;
    }
    if (key.type === "char") {
      const ch = key.char.toLowerCase();
      if (ch === "y") this.finishConfirm({ type: "yes" });
      else if (ch === "n") this.finishConfirm({ type: "no" });
      else if (ch === "a") this.finishConfirm({ type: "always" });
      else if (ch === "e" && modal.req.kind === "exec") this.startEdit();
    }
  }

  private handleEnter(): void {
    if (this.editMode) {
      this.submitEdit();
      return;
    }
    if (this.running) {
      this.transcript.addNotice("info", "A task is running. Press Esc to interrupt before sending.");
      this.requestRender();
      return;
    }
    if (this.menu?.context.kind === "command") {
      const typed = this.menu.context.query;
      const exact = this.commandList().some((c) => c.name === typed);
      if (!exact && this.menu.items.length) {
        this.applySelectedCompletion();
        return;
      }
    }
    const text = this.editor.submit();
    this.menu = undefined;
    this.autoScroll = true;
    this.scrollOffset = 0;
    this.requestRender();
    if (!text) return;
    this.dispatchInput(text);
  }

  private dispatchInput(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.autoScroll = true;
    this.scrollOffset = 0;
    if (trimmed.startsWith("/")) {
      void this.executeCommand(trimmed);
    } else {
      void this.runPrompt(trimmed, trimmed);
    }
  }

  private refreshMenu(): void {
    if (this.modal || this.exiting) {
      this.menu = undefined;
      return;
    }
    const context = detectCompletion(this.editor.text, this.editor.cursorIndex);
    if (!context) {
      this.menu = undefined;
      return;
    }
    let items: MenuItem[] = [];
    if (context.kind === "command") {
      const query = context.query.toLowerCase();
      items = this.commandList()
        .filter((command) => query === "" || command.name.startsWith(query) || fuzzy(command.name, query))
        .slice(0, 10)
        .map((command) => ({
          label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
          description: command.description,
          completion: { name: command.name, kind: "command" as const },
        }));
    } else {
      items = this.pathCompleter.complete(context.query, 8).map((completion) => ({
        label: `@${completion.path}`,
        description: completion.isDir ? "dir" : "file",
        completion,
      }));
    }
    if (!items.length) {
      this.menu = undefined;
      return;
    }
    const previous = this.menu?.context.query === context.query ? this.menu.selected : 0;
    this.menu = { context, items, selected: Math.min(previous, items.length - 1) };
  }

  private applySelectedCompletion(): void {
    if (!this.menu) return;
    const item = this.menu.items[this.menu.selected];
    if (!item) return;
    applyCompletion(this.editor, this.menu.context, item.completion);
    this.menu = undefined;
    this.refreshMenu();
    this.requestRender(true);
  }

  private commandList(): Array<{ name: string; description: string; argumentHint?: string; custom?: CustomCommand }> {
    const custom = new Map(this.options.customCommands.map((command) => [command.name, command]));
    const list = BUILTIN_COMMANDS.map((command) => ({ ...command, custom: custom.get(command.name) }));
    for (const command of this.options.customCommands) {
      if (!BUILTIN_COMMANDS.some((b) => b.name === command.name)) {
        list.push({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint,
          custom: command,
        });
      }
    }
    return list;
  }

  private async executeCommand(line: string): Promise<void> {
    const match = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(line.trim());
    if (!match) {
      this.transcript.addNotice("warn", "Invalid command. Use /help to list commands.");
      this.requestRender(true);
      return;
    }
    const [, name, args] = match;
    this.transcript.addCommand(line.trim());
    this.requestRender(true);
    switch (name) {
      case "help":
        this.showHelp();
        return;
      case "model":
        await this.commandModel(args ?? "");
        return;
      case "clear":
        await this.commandClear();
        return;
      case "resume":
        await this.commandResume(args ?? "");
        return;
      case "cost":
        this.commandCost();
        return;
      case "permissions":
        this.commandPermissions();
        return;
      case "undo":
        this.commandUndo();
        return;
      case "init":
        this.commandInit();
        return;
      case "export":
        this.commandExport();
        return;
      case "rename":
        this.commandRename(args ?? "");
        return;
      case "verbose":
        this.verbose = !this.verbose;
        this.transcript.addNotice("info", `Verbose reasoning/debug: ${this.verbose ? "on" : "off"}`);
        this.requestRender(true);
        return;
      case "quit":
      case "exit":
        await this.exit(0);
        return;
      default: {
        const custom = this.options.customCommands.find((command) => command.name === name);
        if (!custom) {
          this.transcript.addNotice("warn", this.t(`Unknown command /${name}. Use /help.`, `未知命令 /${name}。使用 /help 查看帮助。`));
          this.requestRender(true);
          return;
        }
        const expanded = expandCustomCommand(custom, args ?? "");
        if (!expanded) {
          this.transcript.addNotice("warn", `Custom command /${name} produced an empty prompt.`);
          this.requestRender(true);
          return;
        }
        await this.runPrompt(expanded, line.trim());
      }
    }
  }

  private showHelp(): void {
    const builtins = BUILTIN_COMMANDS.map(
      (command) => `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}`,
    );
    const custom = this.options.customCommands.map(
      (command) => `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}`,
    );
    const lines = [
      this.t("Commands", "命令"),
      ...builtins,
      ...(custom.length ? ["", this.t("Custom commands", "自定义命令"), ...custom] : []),
      "",
      this.t("Keys", "快捷键"),
      "Enter send · Shift+Enter/Ctrl+J newline · Tab completion · ↑/↓ history",
      "@file/@dir attach workspace context · / commands · PgUp/PgDn scroll",
      "Esc interrupt · Ctrl+L clear view · Ctrl+C twice exit · Ctrl+D exit",
      "/rename <title> names the session; /export writes Markdown.",
      "",
      "Permission answers: y allow once · n deny · a always this session · e edit command",
    ];
    this.transcript.addSystem(lines.join("\n"));
    this.requestRender(true);
  }

  private async commandModel(args: string): Promise<void> {
    if (this.running) {
      this.transcript.addNotice("warn", "Cannot switch models while a task is running. Press Esc first.");
      this.requestRender(true);
      return;
    }
    const arg = args.trim();
    if (!arg) {
      const items: PickerItem[] = [];
      for (const [provider, config] of Object.entries(this.config.providers)) {
        for (const model of providerModelList(this.config, provider)) {
          items.push({
            label: `${provider}/${model}`,
            description: provider === this.agent.providerName && model === this.agent.model ? "current" : config.type,
            value: { provider, model },
          });
        }
      }
      const item = await this.picker("Select model", items);
      if (!item) return;
      const value = item.value as { provider: string; model: string };
      await this.switchModel(value.provider, value.model);
      return;
    }
    let provider = this.config.provider;
    let model = arg;
    const slash = arg.indexOf("/");
    if (slash > 0 && this.config.providers[arg.slice(0, slash)]) {
      provider = arg.slice(0, slash);
      model = arg.slice(slash + 1);
    }
    await this.switchModel(provider, model);
  }

  private async switchModel(provider: string, model: string): Promise<void> {
    try {
      const resolved = resolveProvider(this.config, provider, model);
      const instance = createProvider(resolved);
      this.config.provider = provider;
      this.config.model = model;
      this.agent.setProvider(instance, resolved);
      this.session.recordNote(`Model switched to ${provider}/${model}`);
      this.transcript.addNotice("info", `Model: ${provider}/${model}`);
      const hint = missingApiKeyHint(resolved);
      if (hint) this.transcript.addNotice("warn", hint);
      this.requestRender(true);
    } catch (err) {
      this.transcript.addNotice("error", `Failed to switch model: ${describeError(err)}`);
      this.requestRender(true);
    }
  }

  private async commandClear(): Promise<void> {
    if (this.running) {
      this.transcript.addNotice("warn", "Cannot start a new session while a task is running.");
      this.requestRender(true);
      return;
    }
    try {
      const session = SessionStore.create({
        cwd: this.workspace,
        provider: this.config.provider,
        model: this.config.model,
        traceId: generateTraceId(),
        autoSave: this.config.session.autoSave,
        titleMaxLength: this.config.session.titleMaxLength,
      });
      this.agent = this.options.createAgent(session);
      this.session = session;
      this.permissions.setSession(session.id);
      this.permissions.clearGrants();
      this.transcript.clear();
      this.todos = [];
      this.editor.clear();
      this.menu = undefined;
      this.scrollOffset = 0;
      this.autoScroll = true;
      this.transcript.addSystem(`Started session ${session.id}.`);
      this.addWelcome();
      this.requestRender(true);
    } catch (err) {
      this.transcript.addNotice("error", `Failed to start a new session: ${describeError(err)}`);
      this.requestRender(true);
    }
  }

  private async commandResume(args: string): Promise<void> {
    if (this.running) {
      this.transcript.addNotice("warn", "Cannot resume while a task is running. Press Esc first.");
      this.requestRender(true);
      return;
    }
    const id = args.trim();
    if (id) {
      await this.resumeSession(id);
      return;
    }
    const sessions = listSessions({ limit: 50 });
    if (!sessions.length) {
      this.transcript.addNotice("info", "No saved sessions found.");
      this.requestRender(true);
      return;
    }
    const item = await this.picker(
      "Resume session",
      sessions.map((summary) => ({
        label: summary.title || summary.id,
        description: `${summary.id} · ${summary.provider}/${summary.model} · ${formatRelativeTime(summary.updatedAt)}`,
        value: summary.id,
      })),
    );
    if (item) await this.resumeSession(String(item.value));
  }

  private async resumeSession(id: string): Promise<void> {
    try {
      const { store, loaded } = SessionStore.resume(id);
      if (this.config.providers[loaded.meta.provider]) {
        this.config.provider = loaded.meta.provider;
        this.config.model = loaded.meta.model;
      }
      const agent = this.options.createAgent(store, loaded);
      this.agent = agent;
      this.session = store;
      this.permissions.setSession(store.id);
      this.permissions.clearGrants();
      this.transcript.restore(loaded.messages);
      this.todos = loaded.todos;
      this.editor.setHistory(
        loaded.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .slice(-100),
      );
      this.editor.clear();
      this.menu = undefined;
      this.scrollOffset = 0;
      this.autoScroll = true;
      this.transcript.addNotice("info", `Resumed session ${store.id} (${loaded.messages.length} messages).`);
      this.requestRender(true);
    } catch (err) {
      this.transcript.addNotice("error", `Failed to resume ${id}: ${describeError(err)}`);
      this.requestRender(true);
    }
  }

  private commandCost(): void {
    const usage = this.agent.usage;
    const cost = this.agent.usageCostUsd();
    const lines = [
      `Model: ${this.agent.providerName}/${this.agent.model}`,
      `Input tokens: ${formatTokens(usage.inputTokens)}${usage.cacheReadTokens ? ` (cached ${formatTokens(usage.cacheReadTokens)})` : ""}`,
      `Output tokens: ${formatTokens(usage.outputTokens)}`,
      `Total: ${formatTokens(usage.inputTokens + usage.outputTokens)}`,
      `Estimated cost: ${cost === undefined ? "unknown (no price for this model)" : formatCost(cost)} (list price; may differ from billing)`,
      `Session: ${this.session.id}`,
      `Session file: ${this.session.file}`,
    ];
    this.transcript.addSystem(lines.join("\n"));
    this.requestRender(true);
  }

  private commandPermissions(): void {
    const permissions = this.permissions.permissions;
    const rules = permissions.rules
      .slice(-20)
      .map((rule) => `${rule.tool}${rule.match ? ` (${rule.match})` : ""} → ${rule.action}`);
    const grants = this.permissions.activeGrants().map((grant) => `${grant.tool}${grant.match ? ` (${grant.match})` : ""}`);
    const lines = [
      `Mode: ${permissions.mode}`,
      `Workspace boundary: ${permissions.workspaceOnly ? "enabled (symlinks resolved)" : "disabled"}`,
      `Read-before-write: ${permissions.requireReadBeforeWrite ? "required" : "not required"}`,
      `Dangerous command blocking: ${permissions.dangerous.enabled ? "enabled" : "disabled"}`,
      `Sensitive patterns: ${permissions.sensitivePatterns.length}`,
      `--yes allowlist: ${permissions.autoApproveYes.join(", ") || "(empty)"}`,
      "",
      "Rules (last match wins):",
      ...(rules.length ? rules : ["(none)"]),
      "",
      "Session grants:",
      ...(grants.length ? grants : ["(none)"]),
    ];
    this.transcript.addSystem(lines.join("\n"));
    this.requestRender(true);
  }

  private commandRename(args: string): void {
    const title = args.trim();
    if (!title) {
      this.transcript.addNotice("warn", "Usage: /rename <new title>");
      this.requestRender(true);
      return;
    }
    this.session.setTitle(title);
    this.transcript.addSystem(`Session renamed to "${title}".`);
    this.requestRender(true);
  }

  private commandUndo(): void {
    if (this.running) {
      this.transcript.addNotice("warn", "Cannot undo while a task is running.");
      this.requestRender(true);
      return;
    }
    const result = this.agent.getCheckpoints().undoLast();
    if (result.ok) {
      if (result.path) this.agent.getSnapshots().remove(result.path);
      this.session.recordNote(result.message);
      this.transcript.addSystem(`↩ ${result.message}`);
    } else {
      this.transcript.addNotice("warn", result.message);
    }
    this.requestRender(true);
  }

  private commandInit(): void {
    try {
      const result = initProject(this.workspace);
      const lines = [
        result.created.length ? `Created:\n${result.created.map((f) => `  ${displayPath(f, this.workspace)}`).join("\n")}` : "",
        result.skipped.length ? `Kept existing:\n${result.skipped.map((f) => `  ${displayPath(f, this.workspace)}`).join("\n")}` : "",
        result.notes.join("\n"),
      ].filter(Boolean);
      this.transcript.addSystem(lines.join("\n\n"));
    } catch (err) {
      this.transcript.addNotice("error", `init failed: ${describeError(err)}`);
    }
    this.requestRender(true);
  }

  private commandExport(): void {
    try {
      const loaded = readSession(this.session.id);
      const markdown = sessionToMarkdown(loaded);
      const dir = path.join(this.workspace, ".tcli", "exports");
      ensureDirSync(dir);
      const file = path.join(dir, `${this.session.id}.md`);
      writeFileAtomicSync(file, markdown);
      this.transcript.addSystem(`Exported session to ${displayPath(file, this.workspace)}`);
    } catch (err) {
      this.transcript.addNotice("error", `Export failed: ${describeError(err)}`);
    }
    this.requestRender(true);
  }

  private async runPrompt(prompt: string, displayPrompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || this.running) return;
    this.transcript.addUser(displayPrompt);
    this.running = true;
    this.runStartedAt = Date.now();
    this.spinnerIndex = 0;
    this.startSpinner();
    this.scrollOffset = 0;
    this.autoScroll = true;
    this.requestRender(true);
    try {
      for await (const event of this.agent.run(trimmed)) {
        if (this.exiting) break;
        this.handleAgentEvent(event);
      }
    } catch (err) {
      if (!this.exiting) {
        this.transcript.addError(describeError(err));
        this.logger.exception(err, "tui agent run failed");
      }
    } finally {
      this.running = false;
      this.stopSpinner();
      if (this.modal?.kind === "confirm") {
        const modal = this.modal;
        this.modal = undefined;
        modal.resolve({ type: "no" });
      }
      if (this.editMode) {
        this.editMode.resolve({ type: "no" });
        this.editMode = undefined;
      }
      this.requestRender(true);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text":
        this.transcript.appendAssistant(event.text);
        break;
      case "reasoning":
        this.transcript.appendReasoning(event.text);
        break;
      case "tool_start":
        this.transcript.startTool(event.invocation, event.preview);
        break;
      case "tool_result":
        this.transcript.finishTool(
          event.outcome.invocation.id,
          event.outcome.ok,
          event.display?.summary ?? (event.outcome.ok ? "done" : "failed"),
          event.display?.diff,
          event.outcome.denied,
        );
        break;
      case "permission":
        if (!event.allowed) {
          this.transcript.addNotice("warn", `Permission denied: ${event.reason}`);
        } else if (event.approvedBy !== "policy") {
          this.transcript.addNotice("info", `${event.tool}: allowed (${event.approvedBy})`);
        }
        break;
      case "todo":
        this.todos = event.todos;
        break;
      case "notice":
        this.transcript.addNotice(event.level, event.text);
        break;
      case "error":
        this.transcript.addError(event.message);
        break;
      case "retry":
        this.transcript.addNotice("info", `Retrying (${event.attempt}) in ${event.delayMs}ms: ${event.reason}`);
        break;
      case "compaction":
        this.transcript.addSystem(
          `Context compacted: ${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens.`,
        );
        break;
      case "debug":
        if (this.verbose) this.transcript.addSystem(event.text);
        break;
      case "subagent":
        this.transcript.addNotice(
          "info",
          `Subagent ${event.phase}: ${event.description}${event.phase === "end" ? (event.ok ? " (ok)" : " (failed)") : ""}`,
        );
        break;
      default:
        break;
    }
    this.requestRender();
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex++;
      this.requestRender();
    }, 120);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private handleCtrlC(): void {
    const now = Date.now();
    if (this.running) {
      this.agent.cancel();
    }
    if (now - this.lastCtrlC < 1500) {
      void this.exit(130);
      return;
    }
    this.lastCtrlC = now;
    this.transcript.addNotice("info", this.t("Press Ctrl+C again within 1.5s to exit.", "请在 1.5 秒内再次按 Ctrl+C 退出。"));
    this.requestRender(true);
  }

  private async exit(code: number): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.exitCode = code;
    this.agent.cancel();
    if (this.modal?.kind === "confirm") this.modal.resolve({ type: "no" });
    if (this.modal?.kind === "picker") this.modal.resolve(undefined);
    this.modal = undefined;
    if (this.editMode) {
      this.editMode.resolve({ type: "no" });
      this.editMode = undefined;
    }
    this.stopSpinner();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.renderScheduled = false;
    this.permissions.setAsker(undefined);
    process.off("SIGWINCH", this.sigwinchHandler);
    process.off("SIGTERM", this.sigtermHandler);
    process.off("SIGINT", this.sigintHandler);
    process.off("SIGHUP", this.sighupHandler);
    process.off("exit", this.exitHandler);
    try {
      await this.input.stop();
    } catch {
      /* ignore */
    }
    this.screen.leaveAlternateScreen();
    try {
      await this.options.onExit?.(this.session);
    } catch (err) {
      this.logger.exception(err, "tui exit hook failed");
    }
    if (code === 0 || code === 130) {
      process.stdout.write(
        `\nSession ${this.session.id} · ${this.session.meta.title}\n` +
          `Resume: tcli --resume ${this.session.id}\n`,
      );
    }
    this.doneResolve?.(this.exitCode);
  }
}

function fuzzy(text: string, query: string): boolean {
  let index = 0;
  for (const ch of text.toLowerCase()) {
    if (ch === query[index]) index++;
    if (index >= query.length) return true;
  }
  return query.length === 0;
}
