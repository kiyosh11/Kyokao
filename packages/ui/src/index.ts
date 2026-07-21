import { createInterface } from 'node:readline/promises';
import type { ReadStream, WriteStream } from 'node:tty';
import {
  displayWidth,
  EditorState,
  layoutEditor,
  padDisplay,
  TerminalInputParser,
  truncateDisplay,
  graphemes,
  graphemeWidth,
  type InputEvent,
} from './editor.js';
import { InteractiveScreen, withInteractiveScreen, type ScreenFrame } from './terminal.js';
import { createThemeContext, type ThemeContext } from './theme.js';
import {
  CodeRenderer,
  MarkdownRenderer,
  highlightCode as renderHighlightedCode,
  renderMarkdown as renderThemedMarkdown,
} from './markdown.js';
import { PromptScheduler, type PromptBackend, type SchedulerState } from '@kyokao/agent';
export * from './theme.js';
export * from './markdown.js';
export * from './editor.js';
export * from './terminal.js';

export function highlightCode(
  source: string,
  language = '',
  context = createThemeContext({ colorLevel: 0 }),
): string {
  return renderHighlightedCode(source, language, context);
}
export function renderMarkdown(
  value: string,
  context = createThemeContext({ colorLevel: 0 }),
): string {
  return renderThemedMarkdown(value, context);
}

export type WorkspaceCommand =
  | 'help'
  | 'exit'
  | 'clear'
  | 'new'
  | 'sessions'
  | 'resume'
  | 'model'
  | 'provider'
  | 'approval'
  | 'memory'
  | 'doctor'
  | 'diff'
  | 'queue'
  | 'capy'
  | 'theme';

export interface CommandDefinition {
  name: WorkspaceCommand;
  syntax: string;
  description: string;
}

export const workspaceCommands: readonly CommandDefinition[] = [
  { name: 'help', syntax: '/help [command]', description: 'Show commands and command syntax' },
  { name: 'new', syntax: '/new', description: 'Start a new session' },
  { name: 'sessions', syntax: '/sessions', description: 'List local sessions' },
  { name: 'resume', syntax: '/resume <id>', description: 'Resume a local session' },
  { name: 'model', syntax: '/model [id]', description: 'Show or change the active model' },
  {
    name: 'provider',
    syntax: '/provider [name]',
    description: 'Show or change the active provider',
  },
  {
    name: 'approval',
    syntax: '/approval [suggest|auto-edit|full-auto]',
    description: 'Show or change approval mode',
  },
  {
    name: 'memory',
    syntax: '/memory [list|set <key> <value>|delete <key>]',
    description: 'Manage memory',
  },
  { name: 'doctor', syntax: '/doctor', description: 'Check local provider setup' },
  { name: 'diff', syntax: '/diff', description: 'Show the working-tree diff' },
  { name: 'queue', syntax: '/queue [clear|retry]', description: 'List or manage queued prompts' },
  { name: 'capy', syntax: '/capy', description: 'Show Capy remote thread status and links' },
  {
    name: 'theme',
    syntax: '/theme [name|code <name>|save]',
    description: 'Preview, switch, or save themes',
  },
  { name: 'clear', syntax: '/clear', description: 'Clear the visible transcript' },
  { name: 'exit', syntax: '/exit', description: 'Exit Kyokao' },
] as const;

export interface ParsedCommand {
  name: WorkspaceCommand | undefined;
  args: string[];
  raw: string;
}

export function parseWorkspaceCommand(value: string): ParsedCommand | undefined {
  const raw = value.trim();
  if (!raw.startsWith('/')) return undefined;
  const [command = '', ...args] = raw.slice(1).split(/\s+/).filter(Boolean);
  const name = workspaceCommands.find((entry) => entry.name === command.toLowerCase())?.name;
  return { name, args, raw };
}

export function filterWorkspaceCommands(value: string): CommandDefinition[] {
  const query = value.trim().toLowerCase().replace(/^\//, '').split(/\s/, 1)[0] ?? '';
  return workspaceCommands.filter(
    (entry) => entry.name.startsWith(query) || entry.description.toLowerCase().includes(query),
  );
}

export function selectPalette(index: number, delta: number, length: number): number {
  if (!length) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}

export function visiblePaletteCommands(
  commands: readonly CommandDefinition[],
  selected: number,
  limit = 5,
): { commands: readonly CommandDefinition[]; start: number } {
  const size = Math.max(1, limit);
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), commands.length - size));
  return { commands: commands.slice(start, start + size), start };
}

export interface TranscriptEntry {
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'error' | 'status';
  text: string;
}

export function layoutWorkspace(width: number, height: number, paletteRows = 0) {
  const safeWidth = Math.max(12, width);
  return {
    width: safeWidth,
    contentWidth: Math.max(6, safeWidth - 4),
    transcriptHeight: Math.max(1, height - 9 - paletteRows),
  };
}

export function wrapWorkspaceText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const rows: string[] = [];
  let carriedActive = '';
  for (const source of value.split('\n')) {
    if (!source) {
      rows.push(carriedActive ? `${carriedActive}\x1b[0m` : '');
      continue;
    }
    const parts = source.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+|\x1b/g) ?? [];
    const tokens = parts.flatMap((part) =>
      part.startsWith('\x1b[')
        ? [{ raw: part, width: 0, whitespace: false, ansi: true }]
        : graphemes(part).map((raw) => ({
            raw,
            width: graphemeWidth(raw),
            whitespace: /^\s$/u.test(raw),
            ansi: false,
          })),
    );
    const groups: (typeof tokens)[] = [];
    let group: typeof tokens = [];
    let category: boolean | undefined;
    for (const token of tokens) {
      if (token.ansi) {
        group.push(token);
        continue;
      }
      if (category !== undefined && category !== token.whitespace) {
        groups.push(group);
        group = [];
      }
      category = token.whitespace;
      group.push(token);
    }
    if (group.length) groups.push(group);

    let line = carriedActive;
    let active = carriedActive;
    let cells = 0;
    const finish = () => {
      rows.push(`${line}${active ? '\x1b[0m' : ''}`);
      line = active;
      cells = 0;
    };
    const append = (token: (typeof tokens)[number]) => {
      if (token.ansi) {
        line += token.raw;
        if (token.raw.endsWith('m'))
          active = token.raw === '\x1b[0m' ? '' : `${active}${token.raw}`;
        return;
      }
      if (cells > 0 && cells + token.width > safeWidth) finish();
      line += token.raw;
      cells += token.width;
    };
    for (const item of groups) {
      const itemWidth = item.reduce((total, token) => total + token.width, 0);
      const isWord = item.some((token) => !token.ansi && !token.whitespace);
      if (isWord && cells > 0 && cells + itemWidth > safeWidth) finish();
      for (const token of item) append(token);
    }
    rows.push(line);
    carriedActive = active;
  }
  return rows;
}

export function renderTranscript(
  entries: TranscriptEntry[],
  width: number,
  context = createThemeContext({ colorLevel: 0 }),
): string[] {
  const contentWidth = Math.max(3, width - 5);
  const markdown = new MarkdownRenderer(context);
  return entries.flatMap((entry) => {
    const label =
      entry.kind === 'user'
        ? undefined
        : entry.kind === 'assistant'
          ? undefined
          : entry.kind === 'tool'
            ? context.tui('tool', 'Tool')
            : entry.kind === 'error'
              ? context.tui('error', 'Error')
              : context.tui('muted', entry.kind === 'status' ? 'Status' : 'System');
    const token =
      entry.kind === 'assistant'
        ? 'assistant'
        : entry.kind === 'tool'
          ? 'tool'
          : entry.kind === 'error'
            ? 'error'
            : 'primary';
    const rendered = markdown.render(entry.text);
    return [
      ...(label ? [label] : []),
      ...wrapWorkspaceText(rendered, contentWidth).map((line) => `  ${context.tui(token, line)}`),
      '',
    ];
  });
}

export interface WorkspaceHeader {
  workspace: string;
  provider: string;
  model: string;
  approval: string;
}
export type WorkspaceEventKind = TranscriptEntry['kind'];
export interface WorkspaceUsage {
  totalTokens: number;
  estimatedCostUsd: number;
}
export interface WorkspaceEmit {
  (kind: WorkspaceEventKind, text: string): void;
  (kind: 'usage', usage: WorkspaceUsage | undefined): void;
}
export interface WorkspaceCommandResult {
  close?: boolean;
  clear?: boolean;
  messages?: Array<{ kind?: WorkspaceEventKind; text: string }>;
}
export interface TerminalWorkspaceOptions {
  input?: ReadStream;
  output?: WriteStream;
  screen?: InteractiveScreen;
  themeContext?: ThemeContext;
  header: () => WorkspaceHeader;
  backend?: PromptBackend;
  onQueueChange?: (queue: readonly string[]) => Promise<void> | void;
  onApprovalHandler?: (approve: (action: string, detail: string) => Promise<boolean>) => void;
  onPrompt?: (
    prompt: string,
    emit: WorkspaceEmit,
    signal: AbortSignal,
    approve: (action: string, detail: string) => Promise<boolean>,
  ) => Promise<void>;
  onCommand: (
    command: ParsedCommand,
    emit: WorkspaceEmit,
    control: WorkspaceControl,
  ) => Promise<WorkspaceCommandResult | void>;
}

export interface WorkspaceControl {
  scheduler: () => SchedulerState;
  clearQueue: () => Promise<number>;
  retryQueue: () => Promise<void>;
  reset: () => Promise<void>;
  cancelActive: () => Promise<void>;
  enqueue: (prompt: string) => Promise<void>;
}

export interface WorkspaceRenderState {
  width: number;
  height: number;
  header: WorkspaceHeader;
  transcript: TranscriptEntry[];
  editor: EditorState;
  busy?: boolean;
  busyKind?: 'prompt' | 'command';
  approval?: { action: string; detail: string };
  scrollOffset?: number;
  paletteIndex?: number;
  animationFrame?: number;
  usage?: WorkspaceUsage;
  scheduler?: SchedulerState;
  themeContext?: ThemeContext;
}

function border(width: number, left: string, right: string, label = ''): string {
  const inner = Math.max(0, width - 2);
  const fitted = label ? ` ${truncateDisplay(label, Math.max(0, inner - 2))} ` : '';
  return `${left}${fitted}${'─'.repeat(Math.max(0, inner - displayWidth(fitted)))}${right}`;
}

function framed(value: string, width: number): string {
  return `│${padDisplay(` ${value}`, Math.max(0, width - 2))}│`;
}

export function formatWorkspaceUsage(usage: WorkspaceUsage): string {
  return `${usage.totalTokens.toLocaleString()} tokens · $${usage.estimatedCostUsd.toFixed(4)} estimated`;
}

export function renderWorkspaceFooter(width: number, usage?: WorkspaceUsage, busy = false): string {
  const hint = busy
    ? 'Enter replace · Shift/Alt+Enter newline · Ctrl+Enter queue'
    : 'Enter submit · Shift/Alt newline · Ctrl+Enter queue · ^C exit';
  const usageText = usage ? formatWorkspaceUsage(usage) : '';
  if (usageText && displayWidth(hint) + displayWidth(usageText) + 2 <= width) {
    const gap = ' '.repeat(width - displayWidth(hint) - displayWidth(usageText));
    return `${hint}${gap}${usageText}`;
  }
  return padDisplay(hint, width);
}

export function renderWorkspaceScreen(state: WorkspaceRenderState): ScreenFrame & {
  palette: CommandDefinition[];
  transcriptHeight: number;
} {
  const context = state.themeContext ?? createThemeContext({ colorLevel: 0 });
  const width = Math.max(12, state.width);
  const height = Math.max(8, state.height);
  const inner = width - 2;
  const matches =
    state.editor.text.startsWith('/') && state.busyKind !== 'command'
      ? filterWorkspaceCommands(state.editor.text)
      : [];
  const paletteIndex = selectPalette(state.paletteIndex ?? 0, 0, matches.length);
  const editorLayout = layoutEditor(state.editor.text, state.editor.cursor, Math.max(1, inner - 1));
  const queued = state.scheduler?.queue ?? [];
  const queueRows = queued.length ? Math.min(2, queued.length) + 1 : 0;
  const maxComposerRows = Math.max(1, Math.floor(height / 3));
  const composerRows = Math.min(editorLayout.rows.length, maxComposerRows);
  const composerStart = Math.max(
    0,
    Math.min(editorLayout.cursor.row - composerRows + 1, editorLayout.rows.length - composerRows),
  );
  const visibleComposer = editorLayout.rows.slice(composerStart, composerStart + composerRows);
  const footerRows = height >= 9 ? 1 : 0;
  const fixedRows = 5 + composerRows + footerRows + queueRows;
  const paletteLimit = Math.max(0, Math.min(5, height - fixedRows - 2));
  const paletteWindow = visiblePaletteCommands(matches, paletteIndex, Math.max(1, paletteLimit));
  const paletteRows = matches.length && paletteLimit ? paletteWindow.commands.length : 0;
  const paletteBlock = paletteRows ? paletteRows + 1 : 0;
  const transcriptHeight = Math.max(1, height - fixedRows - paletteBlock);
  const renderedTranscript = renderTranscript(state.transcript, width, context);
  const maxScroll = Math.max(0, renderedTranscript.length - transcriptHeight);
  const scrollOffset = Math.min(state.scrollOffset ?? 0, maxScroll);
  const end = renderedTranscript.length - scrollOffset;
  const visibleTranscript = renderedTranscript.slice(Math.max(0, end - transcriptHeight), end);
  const transcriptRows = visibleTranscript.map((row) => framed(row, width));
  while (transcriptRows.length < transcriptHeight) transcriptRows.push(framed('', width));

  const title = `KYOKAO  ${state.header.workspace}`;
  const meta = `${state.header.provider}/${state.header.model} · ${state.header.approval}`;
  const fittedMeta = truncateDisplay(meta, Math.max(1, Math.floor(inner * 0.55)));
  const fittedTitle = truncateDisplay(title, Math.max(1, inner - displayWidth(fittedMeta) - 1));
  const headerGap = ' '.repeat(
    Math.max(1, inner - displayWidth(fittedTitle) - displayWidth(fittedMeta)),
  );
  const status = state.approval
    ? `${state.approval.action}: ${state.approval.detail} [y/N]`
    : state.scheduler?.phase === 'stopping'
      ? 'Stopping…'
      : state.scheduler?.phase === 'starting-replacement'
        ? 'Starting replacement…'
        : state.scheduler?.phase === 'failed'
          ? 'Queue paused after error · /queue retry'
          : state.busy
            ? state.busyKind === 'command'
              ? `Running command ${['·', '••', '•••'][state.animationFrame ?? 0]} · input disabled`
              : `Working ${['·', '••', '•••'][state.animationFrame ?? 0]} · Ctrl-C cancels`
            : scrollOffset
              ? `Viewing earlier output (${scrollOffset} lines) · End returns`
              : 'Ready';
  const lines = [
    context.tui('border', border(width, '╭', '╮')),
    `│${context.tui('brand', fittedTitle)}${headerGap}${context.tui('muted', fittedMeta)}│`,
    context.tui('border', border(width, '├', '┤')),
    ...transcriptRows,
  ];
  if (paletteRows) {
    lines.push(context.tui('border', border(width, '├', '┤', 'Commands')));
    for (const [index, item] of paletteWindow.commands.entries()) {
      const absoluteIndex = paletteWindow.start + index;
      const marker = absoluteIndex === paletteIndex ? '›' : ' ';
      const syntaxWidth = Math.min(
        Math.max(4, displayWidth(item.syntax)),
        Math.max(4, Math.floor((inner - 4) * 0.45)),
      );
      const syntax = padDisplay(item.syntax, syntaxWidth);
      const row = framed(
        `${marker} ${syntax} ${truncateDisplay(item.description, inner - syntaxWidth - 4)}`,
        width,
      );
      lines.push(absoluteIndex === paletteIndex ? context.tui('selected', row) : row);
    }
  }
  if (queueRows) {
    lines.push(context.tui('border', border(width, '├', '┤', `Queue ${queued.length}`)));
    for (const prompt of queued.slice(0, 2))
      lines.push(
        context.tui(
          'tool',
          framed(`• ${truncateDisplay(prompt.replace(/\n/g, ' ↵ '), inner - 3)}`, width),
        ),
      );
  }
  const statusToken = state.approval
    ? 'warning'
    : state.scheduler?.phase === 'failed'
      ? 'error'
      : 'status';
  lines.push(context.tui(statusToken, border(width, '├', '┤', status)));
  for (const row of visibleComposer) lines.push(context.tui('inputAccent', framed(row, width)));
  lines.push(context.tui('border', border(width, '╰', '╯')));
  if (footerRows)
    lines.push(
      context.tui(
        'muted',
        renderWorkspaceFooter(
          width,
          state.usage,
          Boolean(state.scheduler?.active || state.scheduler?.phase === 'stopping'),
        ),
      ),
    );
  while (lines.length < height) lines.splice(3, 0, framed('', width));
  if (lines.length > height) lines.splice(3, lines.length - height);
  const composerTop = 3 + transcriptHeight + paletteBlock + queueRows + 1;
  const cursor =
    state.busyKind === 'command' || state.approval
      ? undefined
      : {
          row: composerTop + editorLayout.cursor.row - composerStart,
          column: Math.min(width - 2, 2 + editorLayout.cursor.column),
        };
  return { lines, cursor, palette: matches, transcriptHeight };
}

class PromptHistory {
  private entries: string[] = [];
  private index: number | undefined;
  private draft = '';

  get browsing(): boolean {
    return this.index !== undefined;
  }

  add(value: string): void {
    if (value && this.entries.at(-1) !== value) this.entries.push(value);
    this.index = undefined;
    this.draft = '';
  }

  browse(delta: -1 | 1, current: string): string {
    if (!this.entries.length) return current;
    if (this.index === undefined) {
      if (delta > 0) return current;
      this.draft = current;
      this.index = this.entries.length - 1;
    } else {
      const next = this.index + delta;
      if (next >= this.entries.length) {
        this.index = undefined;
        return this.draft;
      }
      this.index = Math.max(0, next);
    }
    return this.entries[this.index]!;
  }

  detach(): void {
    this.index = undefined;
  }
}

async function runTerminalWorkspace(
  options: TerminalWorkspaceOptions,
  screen: InteractiveScreen,
): Promise<void> {
  const input = screen.input;
  const output = screen.output;
  const context =
    options.themeContext ?? createThemeContext({ isTTY: output.isTTY, env: process.env });
  const editor = new EditorState();
  const history = new PromptHistory();
  const parser = new TerminalInputParser();
  let busy = false;
  let busyKind: 'prompt' | 'command' | undefined;
  let scrollOffset = 0;
  let paletteIndex = 0;
  let closed = false;
  let approval: { action: string; detail: string; resolve: (allowed: boolean) => void } | undefined;
  let transcript: TranscriptEntry[] = [];
  let usage: WorkspaceUsage | undefined;
  let schedulerState: SchedulerState = { phase: 'idle', queue: [] };

  const emit: WorkspaceEmit = (
    kind: WorkspaceEventKind | 'usage',
    value: string | WorkspaceUsage | undefined,
  ) => {
    if (kind === 'usage') {
      usage = value as WorkspaceUsage | undefined;
      draw();
      return;
    }
    const text = value as string;
    const previous = transcript.at(-1);
    if (kind === 'assistant' && previous?.kind === 'assistant') previous.text += text;
    else transcript.push({ kind, text });
    scrollOffset = 0;
    draw();
  };
  const legacyBackend: PromptBackend = {
    provider: options.header().provider,
    async run(prompt, backendEmit, signal) {
      if (!options.onPrompt) throw new Error('No prompt backend configured');
      await options.onPrompt(
        prompt,
        (kind: any, value: any) => backendEmit(kind, value),
        signal,
        askApproval,
      );
    },
    async cancel() {},
    async reset() {},
    async resume() {
      throw new Error('Resume is not supported by this workspace backend');
    },
    status: () => ({ provider: options.header().provider, state: schedulerState.phase }),
    session: () => undefined,
    async close() {},
  };
  const scheduler = new PromptScheduler({
    backend: options.backend ?? legacyBackend,
    emit: (kind, value) => {
      if (kind === 'usage') emit('usage', value as WorkspaceUsage | undefined);
      else emit(kind, String(value));
    },
    onState: (state) => {
      schedulerState = state;
      busy = Boolean(state.active) || ['stopping', 'starting-replacement'].includes(state.phase);
      busyKind = busy ? 'prompt' : undefined;
      draw();
    },
    onRunStart: (prompt) => emit('user', prompt),
    onQueueChange: options.onQueueChange,
  });
  const control: WorkspaceControl = {
    scheduler: () => scheduler.state(),
    clearQueue: () => scheduler.clearQueue(),
    retryQueue: () => scheduler.retry(),
    reset: () => scheduler.reset(),
    cancelActive: () => scheduler.cancelActive(),
    enqueue: (prompt) => scheduler.submit(prompt, 'queue'),
  };
  const palette = () =>
    editor.text.startsWith('/') && busyKind !== 'command'
      ? filterWorkspaceCommands(editor.text)
      : [];
  const draw = () => {
    if (closed) return;
    const matches = palette();
    paletteIndex = selectPalette(paletteIndex, 0, matches.length);
    const rendered = renderTranscript(transcript, output.columns ?? 80, context);
    const requestedScrollOffset = scrollOffset;
    let frame = renderWorkspaceScreen({
      width: output.columns ?? 80,
      height: output.rows ?? 24,
      header: options.header(),
      transcript,
      editor,
      busy,
      busyKind,
      approval,
      scrollOffset,
      paletteIndex,
      animationFrame: Math.floor(Date.now() / 350) % 3,
      usage,
      scheduler: schedulerState,
      themeContext: context,
    });
    const maxScroll = Math.max(0, rendered.length - frame.transcriptHeight);
    scrollOffset = Math.min(scrollOffset, maxScroll);
    if (scrollOffset !== requestedScrollOffset)
      frame = renderWorkspaceScreen({
        width: output.columns ?? 80,
        height: output.rows ?? 24,
        header: options.header(),
        transcript,
        editor,
        busy,
        busyKind,
        approval,
        scrollOffset,
        paletteIndex,
        animationFrame: Math.floor(Date.now() / 350) % 3,
        usage,
        scheduler: schedulerState,
        themeContext: context,
      });
    screen.draw(frame);
  };
  const askApproval = (action: string, detail: string) =>
    new Promise<boolean>((resolve) => {
      approval = { action, detail, resolve };
      draw();
    });
  options.onApprovalHandler?.(askApproval);
  const settleApproval = (allowed: boolean, message?: string) => {
    if (!approval) return;
    approval.resolve(allowed);
    approval = undefined;
    if (message) transcript.push({ kind: 'status', text: message });
  };
  const runPrompt = async (prompt: string, mode: 'replace' | 'queue') => {
    await scheduler.submit(prompt, mode);
  };
  const runCommand = async (raw: string) => {
    const parsed = parseWorkspaceCommand(raw)!;
    if (!parsed.name) {
      emit('error', `Unknown command "${raw}". Type / to browse commands.`);
      return;
    }
    busy = true;
    busyKind = 'command';
    draw();
    let close = false;
    try {
      const result = await options.onCommand(parsed, emit, control);
      if (result?.clear) transcript = [];
      for (const message of result?.messages ?? []) emit(message.kind ?? 'system', message.text);
      close = result?.close === true;
      return close;
    } catch (error) {
      emit('error', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      busy = Boolean(schedulerState.active);
      busyKind = busy ? 'prompt' : undefined;
      if (!close) draw();
    }
  };

  const onResize = () => draw();
  output.on('resize', onResize);
  const ticker = setInterval(() => busy && draw(), 350);
  let dataListener: ((chunk: string) => void) | undefined;
  let streamFinish: (() => void) | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    draw();
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      streamFinish = finish;
      const handleEvent = (event: InputEvent) => {
        if (approval) {
          if (event.type === 'text' && /^[yY]/.test(event.text)) settleApproval(true);
          else if (
            (event.type === 'key' &&
              ['interrupt', 'escape', 'enter', 'newline'].includes(event.key)) ||
            (event.type === 'text' && /^[nN]/.test(event.text))
          )
            settleApproval(false, 'Approval denied.');
          else return;
          draw();
          return;
        }
        if (event.type === 'key' && event.key === 'interrupt') {
          if (busyKind === 'prompt') void scheduler.cancelActive();
          else if (busyKind === 'command')
            emit('status', 'Command is running and cannot be cancelled.');
          else resolve();
          return;
        }
        if (event.type === 'key' && event.key === 'escape') {
          if (editor.text.startsWith('/')) {
            editor.set('');
            paletteIndex = 0;
            draw();
          }
          return;
        }
        if (busyKind === 'command') return;
        if (event.type === 'paste') {
          history.detach();
          editor.insert(event.text.replace(/\r\n?/g, '\n'));
          paletteIndex = 0;
          draw();
          return;
        }
        if (event.type === 'text') {
          history.detach();
          editor.insert(event.text);
          paletteIndex = 0;
          draw();
          return;
        }
        const key = event.key;
        if (key === 'up' || key === 'down') {
          const matches = palette();
          if (matches.length && !history.browsing) {
            paletteIndex = selectPalette(paletteIndex, key === 'up' ? -1 : 1, matches.length);
          } else if (editor.multiline) editor.vertical(key === 'up' ? -1 : 1);
          else editor.set(history.browse(key === 'up' ? -1 : 1, editor.text));
          draw();
          return;
        }
        if (key === 'page-up') scrollOffset += Math.max(1, (output.rows ?? 24) - 10);
        else if (key === 'page-down')
          scrollOffset = Math.max(0, scrollOffset - Math.max(1, (output.rows ?? 24) - 10));
        else if (key === 'backspace') editor.backspace();
        else if (key === 'delete') editor.delete();
        else if (key === 'left') editor.left();
        else if (key === 'right') editor.right();
        else if (key === 'home') editor.home();
        else if (key === 'end') {
          if (scrollOffset) scrollOffset = 0;
          else editor.end();
        } else if (key === 'ctrl-a') editor.start();
        else if (key === 'ctrl-e') editor.finish();
        else if (key === 'ctrl-u') editor.killBefore();
        else if (key === 'ctrl-k') editor.killAfter();
        else if (key === 'ctrl-w') editor.deleteWordBefore();
        else if (key === 'alt-left') editor.wordLeft();
        else if (key === 'alt-right') editor.wordRight();
        else if (key === 'newline') editor.insert('\n');
        else if (key === 'queue') {
          const prompt = editor.text.trim();
          if (prompt && !prompt.startsWith('/')) {
            history.add(prompt);
            editor.set('');
            paletteIndex = 0;
            void runPrompt(prompt, 'queue');
          }
        } else if (key === 'tab' && palette().length) {
          editor.set(`/${palette()[paletteIndex]!.name} `);
          history.detach();
        } else if (key === 'enter') {
          const prompt = editor.text.trim();
          if (prompt) {
            if (
              prompt.startsWith('/') &&
              palette().length &&
              !parseWorkspaceCommand(prompt)?.name
            ) {
              editor.set(`/${palette()[paletteIndex]!.name} `);
              draw();
              return;
            }
            history.add(prompt);
            editor.set('');
            paletteIndex = 0;
            if (prompt.startsWith('/')) {
              void runCommand(prompt).then((close) => close && resolve());
            } else void runPrompt(prompt, 'replace');
          }
        }
        draw();
      };
      const onData = (chunk: string) => {
        if (escapeTimer) clearTimeout(escapeTimer);
        for (const event of parser.feed(chunk)) handleEvent(event);
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          for (const event of parser.flushEscape()) handleEvent(event);
        }, 25);
      };
      dataListener = onData;
      input.on('data', dataListener);
      input.once('close', finish);
      input.once('error', finish);
      output.once('close', finish);
      output.once('error', finish);
    });
  } finally {
    closed = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    clearInterval(ticker);
    settleApproval(false);
    await scheduler.close();
    if (dataListener) input.removeListener('data', dataListener);
    if (streamFinish) {
      input.removeListener('close', streamFinish);
      input.removeListener('error', streamFinish);
      output.removeListener('close', streamFinish);
      output.removeListener('error', streamFinish);
    }
    output.removeListener('resize', onResize);
  }
}

export async function terminalWorkspace(options: TerminalWorkspaceOptions): Promise<void> {
  if (options.screen) return await runTerminalWorkspace(options, options.screen);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('interactive workspace requires a TTY');
  return await withInteractiveScreen({ input, output }, async (screen) => {
    await runTerminalWorkspace(options, screen);
  });
}

export function createUi(
  context = createThemeContext({ isTTY: process.stdout.isTTY, env: process.env }),
  streams: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {},
) {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const markdown = new MarkdownRenderer(context);
  const code = new CodeRenderer(context);
  return {
    info: (value: string) => stdout.write(`${context.tui('status', value)}\n`),
    error: (value: string) => stderr.write(`${context.tui('error', value)}\n`),
    assistant: (value: string) =>
      stdout.write(`${context.tui('assistant', markdown.render(value))}\n`),
    tool: (value: string) => stderr.write(`${context.tui('tool', `• ${value}`)}\n`),
    diff: (value: string) => stdout.write(`${code.render(value, 'diff')}\n`),
    async approve(action: string, detail: string) {
      if (!process.stdin.isTTY) return false;
      const r = createInterface({ input: process.stdin, output: stdout });
      const a = await r.question(`${context.tui('warning', `Allow ${action}`)} ${detail}? [y/N] `);
      r.close();
      return /^y(es)?$/i.test(a);
    },
  };
}

export const ui = createUi();

export * from './setup.js';
