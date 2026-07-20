import pc from 'picocolors';
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
import { theme } from './theme.js';
export { theme } from './theme.js';
export * from './editor.js';
export * from './terminal.js';

const keywords =
  /\b(const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|new|true|false|null|undefined)\b/g;
export function highlightCode(source: string, language = ''): string {
  const color = (value: string) =>
    language.toLowerCase().includes('json') ? pc.yellow(value) : pc.cyan(value);
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) return pc.dim(line);
      return line
        .replace(keywords, (keyword) => pc.magenta(keyword))
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (value) => color(value));
    })
    .join('\n');
}
export function renderMarkdown(value: string): string {
  return value.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, language: string, code: string) =>
      `\n${highlightCode(code.replace(/\n$/, ''), language)}\n`,
  );
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
  | 'diff';

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
  for (const source of value.split('\n')) {
    if (!source) {
      rows.push('');
      continue;
    }
    let line = '';
    let cells = 0;
    for (const value of graphemes(source)) {
      const next = graphemeWidth(value);
      if (line && cells + next > safeWidth) {
        rows.push(line);
        line = '';
        cells = 0;
      }
      line += value;
      cells += next;
    }
    rows.push(line);
  }
  return rows;
}

export function renderTranscript(entries: TranscriptEntry[], width: number): string[] {
  const contentWidth = Math.max(4, width - 4);
  return entries.flatMap((entry) => {
    const label =
      entry.kind === 'user'
        ? theme.user('You')
        : entry.kind === 'assistant'
          ? theme.assistant('Kyokao')
          : entry.kind === 'tool'
            ? theme.tool('Tool')
            : entry.kind === 'error'
              ? theme.error('Error')
              : theme.muted(entry.kind === 'status' ? 'Status' : 'System');
    const paint =
      entry.kind === 'assistant'
        ? theme.assistant
        : entry.kind === 'tool'
          ? theme.tool
          : entry.kind === 'error'
            ? theme.error
            : (value: string) => value;
    return [
      `${label}`,
      ...wrapWorkspaceText(entry.text, contentWidth).map(
        (line) => `  ${paint(renderMarkdown(line))}`,
      ),
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
export type WorkspaceEmit = (kind: WorkspaceEventKind, text: string) => void;
export interface WorkspaceCommandResult {
  close?: boolean;
  clear?: boolean;
  messages?: Array<{ kind?: WorkspaceEventKind; text: string }>;
}
export interface TerminalWorkspaceOptions {
  input?: ReadStream;
  output?: WriteStream;
  screen?: InteractiveScreen;
  header: () => WorkspaceHeader;
  onPrompt: (
    prompt: string,
    emit: WorkspaceEmit,
    signal: AbortSignal,
    approve: (action: string, detail: string) => Promise<boolean>,
  ) => Promise<void>;
  onCommand: (
    command: ParsedCommand,
    emit: WorkspaceEmit,
  ) => Promise<WorkspaceCommandResult | void>;
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
}

function border(width: number, left: string, right: string, label = ''): string {
  const inner = Math.max(0, width - 2);
  const fitted = label ? ` ${truncateDisplay(label, Math.max(0, inner - 2))} ` : '';
  return `${left}${fitted}${'─'.repeat(Math.max(0, inner - displayWidth(fitted)))}${right}`;
}

function framed(value: string, width: number): string {
  return `│${padDisplay(` ${value}`, Math.max(0, width - 2))}│`;
}

export function renderWorkspaceScreen(state: WorkspaceRenderState): ScreenFrame & {
  palette: CommandDefinition[];
  transcriptHeight: number;
} {
  const width = Math.max(12, state.width);
  const height = Math.max(8, state.height);
  const inner = width - 2;
  const matches =
    state.editor.text.startsWith('/') && !state.busy
      ? filterWorkspaceCommands(state.editor.text)
      : [];
  const paletteIndex = selectPalette(state.paletteIndex ?? 0, 0, matches.length);
  const editorLayout = layoutEditor(state.editor.text, state.editor.cursor, Math.max(1, inner - 1));
  const maxComposerRows = Math.max(1, Math.floor(height / 3));
  const composerRows = Math.min(editorLayout.rows.length, maxComposerRows);
  const composerStart = Math.max(
    0,
    Math.min(editorLayout.cursor.row - composerRows + 1, editorLayout.rows.length - composerRows),
  );
  const visibleComposer = editorLayout.rows.slice(composerStart, composerStart + composerRows);
  const footerRows = height >= 9 ? 1 : 0;
  const fixedRows = 6 + composerRows + footerRows;
  const paletteLimit = Math.max(0, Math.min(5, height - fixedRows - 2));
  const paletteWindow = visiblePaletteCommands(matches, paletteIndex, Math.max(1, paletteLimit));
  const paletteRows = matches.length && paletteLimit ? paletteWindow.commands.length : 0;
  const paletteBlock = paletteRows ? paletteRows + 1 : 0;
  const transcriptHeight = Math.max(1, height - fixedRows - paletteBlock);
  const renderedTranscript = renderTranscript(state.transcript, width);
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
    : state.busy
      ? state.busyKind === 'command'
        ? `Running command ${['·', '••', '•••'][state.animationFrame ?? 0]} · input disabled`
        : `Working ${['·', '••', '•••'][state.animationFrame ?? 0]} · Ctrl-C cancels`
      : scrollOffset
        ? `Viewing earlier output (${scrollOffset} lines) · End returns`
        : 'Ready';
  const lines = [
    theme.muted(border(width, '╭', '╮')),
    `│${theme.brand(fittedTitle)}${headerGap}${theme.muted(fittedMeta)}│`,
    theme.muted(border(width, '├', '┤')),
    ...transcriptRows,
    framed(truncateDisplay(status, inner - 1), width),
  ];
  if (paletteRows) {
    lines.push(theme.muted(border(width, '├', '┤', 'Commands')));
    for (const [index, item] of paletteWindow.commands.entries()) {
      const absoluteIndex = paletteWindow.start + index;
      const marker = absoluteIndex === paletteIndex ? '›' : ' ';
      const syntaxWidth = Math.min(
        Math.max(4, displayWidth(item.syntax)),
        Math.max(4, Math.floor((inner - 4) * 0.45)),
      );
      const syntax = padDisplay(item.syntax, syntaxWidth);
      lines.push(
        framed(
          `${marker} ${syntax} ${truncateDisplay(item.description, inner - syntaxWidth - 4)}`,
          width,
        ),
      );
    }
  }
  lines.push(theme.muted(border(width, '├', '┤', 'Prompt')));
  for (const row of visibleComposer) lines.push(framed(row, width));
  lines.push(theme.muted(border(width, '╰', '╯')));
  if (footerRows)
    lines.push(
      padDisplay(
        state.busy
          ? state.busyKind === 'command'
            ? 'Command running'
            : 'Ctrl-C cancel'
          : 'Enter submit · Alt-Enter/Ctrl-J newline · / commands · Ctrl-C exit',
        width,
      ),
    );
  while (lines.length < height) lines.splice(3, 0, framed('', width));
  if (lines.length > height) lines.splice(3, lines.length - height);
  const composerTop = 3 + transcriptHeight + 1 + paletteBlock + 1;
  const cursor = state.busy
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
  const editor = new EditorState();
  const history = new PromptHistory();
  const parser = new TerminalInputParser();
  let busy = false;
  let busyKind: 'prompt' | 'command' | undefined;
  let scrollOffset = 0;
  let paletteIndex = 0;
  let closed = false;
  let controller: AbortController | undefined;
  let approval: { action: string; detail: string; resolve: (allowed: boolean) => void } | undefined;
  let transcript: TranscriptEntry[] = [
    { kind: 'system', text: 'Ready. Type a task or / for commands.' },
  ];

  const emit: WorkspaceEmit = (kind, text) => {
    const previous = transcript.at(-1);
    if (kind === 'assistant' && previous?.kind === 'assistant') previous.text += text;
    else transcript.push({ kind, text });
    scrollOffset = 0;
    draw();
  };
  const palette = () =>
    editor.text.startsWith('/') && !busy ? filterWorkspaceCommands(editor.text) : [];
  const draw = () => {
    if (closed) return;
    const matches = palette();
    paletteIndex = selectPalette(paletteIndex, 0, matches.length);
    const rendered = renderTranscript(transcript, output.columns ?? 80);
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
      });
    screen.draw(frame);
  };
  const askApproval = (action: string, detail: string) =>
    new Promise<boolean>((resolve) => {
      approval = { action, detail, resolve };
      draw();
    });
  const settleApproval = (allowed: boolean, message?: string) => {
    if (!approval) return;
    approval.resolve(allowed);
    approval = undefined;
    if (message) transcript.push({ kind: 'status', text: message });
  };
  const runPrompt = async (prompt: string) => {
    busy = true;
    busyKind = 'prompt';
    controller = new AbortController();
    emit('user', prompt);
    try {
      await options.onPrompt(prompt, emit, controller.signal, askApproval);
    } catch (error) {
      if (controller.signal.aborted) emit('status', 'Request cancelled.');
      else emit('error', error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      busyKind = undefined;
      controller = undefined;
      draw();
    }
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
      const result = await options.onCommand(parsed, emit);
      if (result?.clear) transcript = [];
      for (const message of result?.messages ?? []) emit(message.kind ?? 'system', message.text);
      close = result?.close === true;
      return close;
    } catch (error) {
      emit('error', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      busy = false;
      busyKind = undefined;
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
          if (busyKind === 'prompt') controller?.abort();
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
        if (busy) return;
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
        else if (key === 'tab' && palette().length) {
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
            } else void runPrompt(prompt);
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
    controller?.abort();
    settleApproval(false);
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

export const ui = {
  info: (s: string) => console.log(pc.cyan(s)),
  error: (s: string) => console.error(pc.red(s)),
  assistant: (s: string) => console.log(pc.green(renderMarkdown(s))),
  tool: (s: string) => console.error(pc.dim(`• ${s}`)),
  diff: (s: string) =>
    console.log(
      s
        .split('\n')
        .map((l) => (l.startsWith('+') ? pc.green(l) : l.startsWith('-') ? pc.red(l) : l))
        .join('\n'),
    ),
  async approve(action: string, detail: string) {
    if (!process.stdin.isTTY) return false;
    const r = createInterface({ input: process.stdin, output: process.stdout });
    const a = await r.question(`${pc.yellow(`Allow ${action}`)} ${detail}? [y/N] `);
    r.close();
    return /^y(es)?$/i.test(a);
  },
};

export * from './setup.js';
