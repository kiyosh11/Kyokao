import pc from 'picocolors';
import { createInterface } from 'node:readline/promises';
import type { ReadStream, WriteStream } from 'node:tty';
import { theme } from './theme.js';
export { theme } from './theme.js';

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
  const safeWidth = Math.max(24, width);
  return {
    width: safeWidth,
    contentWidth: Math.max(16, safeWidth - 6),
    transcriptHeight: Math.max(3, height - 10 - paletteRows),
  };
}

export function wrapWorkspaceText(value: string, width: number): string[] {
  const rows: string[] = [];
  for (const source of value.split('\n')) {
    if (!source) {
      rows.push('');
      continue;
    }
    let line = source;
    while (line.length > width) {
      const split = line.lastIndexOf(' ', width);
      const at = split > 0 ? split : width;
      rows.push(line.slice(0, at));
      line = line.slice(at).trimStart();
    }
    rows.push(line);
  }
  return rows;
}

export function renderTranscript(entries: TranscriptEntry[], width: number): string[] {
  const contentWidth = Math.max(12, width - 6);
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

export async function terminalWorkspace(options: TerminalWorkspaceOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('interactive workspace requires a TTY');
  const previousRaw = input.isRaw;
  const previousEncoding = input.readableEncoding;
  let buffer = '';
  let busy = false;
  let busyKind: 'prompt' | 'command' | undefined;
  let scrollOffset = 0;
  let paletteIndex = 0;
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
  const palette = () => (buffer.startsWith('/') && !busy ? filterWorkspaceCommands(buffer) : []);
  const draw = () => {
    const width = output.columns ?? 80;
    const height = output.rows ?? 24;
    const matches = palette();
    paletteIndex = selectPalette(paletteIndex, 0, matches.length);
    const metrics = layoutWorkspace(
      width,
      height,
      matches.length ? Math.min(5, matches.length) + 1 : 0,
    );
    const header = options.header();
    const title = ` KYOKAO  ${header.workspace} `;
    const meta = `${header.provider}/${header.model} · ${header.approval}`;
    const fit = (value: string, max: number) =>
      value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
    const inner = metrics.width - 2;
    const fittedTitle = fit(title, Math.max(1, inner - meta.length - 1));
    const rendered = renderTranscript(transcript, metrics.width);
    const maxScroll = Math.max(0, rendered.length - metrics.transcriptHeight);
    scrollOffset = Math.min(scrollOffset, maxScroll);
    const end = rendered.length - scrollOffset;
    const visible = rendered.slice(Math.max(0, end - metrics.transcriptHeight), end);
    const line = '─'.repeat(Math.max(0, metrics.width - 2));
    output.write('\x1b[?25l\x1b[H\x1b[2J');
    output.write(`${theme.muted(`╭${line}╮`)}\n`);
    output.write(
      `│${theme.brand(fittedTitle)}${' '.repeat(Math.max(1, inner - fittedTitle.length - meta.length))}${theme.muted(meta)}│\n`,
    );
    output.write(`${theme.muted(`├${line}┤`)}\n`);
    output.write(`${visible.join('\n')}\n`);
    output.write(`${theme.muted(`├${line}┤`)}\n`);
    const status = approval
      ? `${approval.action}: ${approval.detail} [y/N]`
      : busy
        ? busyKind === 'command'
          ? `Running command ${['·', '••', '•••'][Math.floor(Date.now() / 350) % 3]}  input disabled`
          : `Working ${['·', '••', '•••'][Math.floor(Date.now() / 350) % 3]}  Ctrl-C cancels`
        : scrollOffset
          ? `Viewing earlier output (${scrollOffset} lines) · End returns`
          : 'Ready';
    output.write(`│ ${fit(status, inner - 1).padEnd(Math.max(0, inner - 1))}│\n`);
    output.write(`${theme.muted(`╰${line}╯`)}\n`);
    if (matches.length) {
      const paletteRows = visiblePaletteCommands(matches, paletteIndex);
      output.write(`${theme.muted('Commands')}\n`);
      for (const [index, item] of paletteRows.commands.entries()) {
        const absoluteIndex = paletteRows.start + index;
        output.write(
          `${absoluteIndex === paletteIndex ? theme.user('›') : ' '} ${theme.user(item.syntax)} ${theme.muted(item.description)}\n`,
        );
      }
    }
    output.write(
      `${theme.muted(busy ? (busyKind === 'command' ? 'Command running' : 'Ctrl-C cancel') : 'Enter submit')}  ${theme.muted('Alt-Enter newline')}  ${theme.muted('/ commands')}  ${theme.muted('Ctrl-C exit')}\n`,
    );
    const composerRows = buffer.split('\n');
    output.write(`${theme.user('›')} ${composerRows.join(`\n  `)}`);
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
    try {
      const result = await options.onCommand(parsed, emit);
      if (result?.clear) transcript = [];
      for (const message of result?.messages ?? []) emit(message.kind ?? 'system', message.text);
      return result?.close === true;
    } catch (error) {
      emit('error', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      busy = false;
      busyKind = undefined;
      draw();
    }
  };

  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  const onResize = () => draw();
  output.on('resize', onResize);
  const ticker = setInterval(() => busy && draw(), 350);
  let dataListener: ((chunk: string) => void) | undefined;
  draw();
  try {
    await new Promise<void>((resolve) => {
      const onData = (chunk: string) => {
        const characters = Array.from(chunk);
        if (
          characters.length > 1 &&
          !chunk.startsWith('\u001b[') &&
          chunk !== '\u001b\r' &&
          chunk !== '\u001b\n'
        ) {
          for (const character of characters) onData(character);
          return;
        }
        if (approval) {
          if (/^[yY]/.test(chunk)) settleApproval(true);
          else if (chunk === '\u0003' || chunk === '\u001b' || /^[nN\r\n]/.test(chunk))
            settleApproval(false, 'Approval denied.');
          else return;
          draw();
          return;
        }
        if (chunk === '\u0003') {
          if (busyKind === 'prompt') controller?.abort();
          else if (busyKind === 'command')
            emit('status', 'Command is running and cannot be cancelled.');
          else resolve();
          return;
        }
        if (chunk === '\u001b') {
          if (buffer.startsWith('/')) {
            buffer = '';
            paletteIndex = 0;
            draw();
          }
          return;
        }
        if (chunk === '\u001b[A' || chunk === '\u001b[B') {
          const matches = palette();
          if (matches.length) {
            paletteIndex = selectPalette(
              paletteIndex,
              chunk === '\u001b[A' ? -1 : 1,
              matches.length,
            );
          } else scrollOffset = Math.max(0, scrollOffset + (chunk === '\u001b[A' ? 4 : -4));
          draw();
          return;
        }
        if (chunk === '\u001b[5~') scrollOffset += 8;
        else if (chunk === '\u001b[6~') scrollOffset = Math.max(0, scrollOffset - 8);
        else if (chunk === '\u001b[F' || chunk === '\u001b[4~') scrollOffset = 0;
        else if (chunk === '\u007f') buffer = buffer.slice(0, -1);
        else if (chunk === '\t' && palette().length) buffer = `/${palette()[paletteIndex]!.name} `;
        else if ((chunk === '\u001b\r' || chunk === '\u001b\n') && !busy) buffer += '\n';
        else if ((chunk === '\r' || chunk === '\n') && !busy) {
          const prompt = buffer.trim();
          if (prompt) {
            if (
              prompt.startsWith('/') &&
              palette().length &&
              !parseWorkspaceCommand(prompt)?.name
            ) {
              buffer = `/${palette()[paletteIndex]!.name} `;
              draw();
              return;
            }
            buffer = '';
            paletteIndex = 0;
            if (prompt.startsWith('/')) {
              void runCommand(prompt).then((close) => close && resolve());
            } else void runPrompt(prompt);
          }
        } else if (!busy && chunk >= ' ') {
          buffer += chunk;
          paletteIndex = 0;
        }
        draw();
      };
      dataListener = onData;
      input.on('data', dataListener);
      input.once('close', resolve);
      input.once('error', resolve);
    });
  } finally {
    clearInterval(ticker);
    controller?.abort();
    settleApproval(false);
    if (dataListener) input.removeListener('data', dataListener);
    output.removeListener('resize', onResize);
    input.setRawMode(previousRaw ?? false);
    if (previousEncoding) input.setEncoding(previousEncoding);
    input.pause();
    output.write('\x1b[?25h\n');
  }
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
