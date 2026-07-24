import { createThemeContext, type ThemeContext } from './theme.js';
import { MarkdownRenderer } from './markdown.js';
import { graphemes, graphemeWidth, padDisplay, truncateDisplay } from './editor.js';

export interface TranscriptEntry {
  kind: 'system' | 'user' | 'assistant' | 'reasoning' | 'tool' | 'error' | 'status';
  text: string;
  /** Wall-clock time captured when the block was first emitted. */
  timestamp?: number | string;
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

function splitToolLine(text: string): { header: string; body?: string } {
  const newline = text.indexOf('\n');
  const firstLine = newline >= 0 ? text.slice(0, newline) : text;
  const rest = newline >= 0 ? text.slice(newline + 1) : '';

  const callMatch = firstLine.match(/^([a-z_]+)\s*\{(.*)\}\s*$/i);
  if (callMatch) {
    const [, name, rawArgs] = callMatch;
    const summary = summarizeToolArgs(rawArgs!);
    const header = summary ? `${name}  ${summary}` : name!;
    return rest.trim() ? { header, body: rest } : { header };
  }
  const colonMatch = firstLine.match(/^([a-z_]+)\s*:\s*(.*)$/i);
  if (colonMatch) {
    const [, name, result] = colonMatch;
    const body = [result, rest].filter(Boolean).join('\n').trim();
    return body ? { header: name!, body } : { header: name! };
  }
  return rest.trim() ? { header: firstLine, body: rest } : { header: firstLine };
}

function summarizeToolArgs(rawArgs: string): string | undefined {
  try {
    const parsed = JSON.parse(`{${rawArgs}}`);
    const path = parsed.path ?? parsed.file ?? parsed.filepath ?? parsed.filename;
    if (typeof path === 'string') return path;
    const command = parsed.command ?? parsed.cmd;
    if (typeof command === 'string') return command;
    const query = parsed.query ?? parsed.pattern ?? parsed.search;
    if (typeof query === 'string') return query;
    const entries = Object.entries(parsed);
    if (entries.length === 1) return String(entries[0]![1]);
    return undefined;
  } catch {
    return undefined;
  }
}

function userPillLine(
  text: string,
  width: number,
  context: ThemeContext,
  prefix: '❯ ' | '  ',
): string {
  const source = `${prefix}${text.replace(/\n/g, ' ↵ ')}`;
  const content = truncateDisplay(source, Math.max(1, width - 1));
  const padded = padDisplay(content, width);
  if (context.colorLevel === 0) return padded;
  const base = context.tuiTheme.background;
  const border = context.tuiTheme.border;
  const bg = base
    ? {
        ansi16: border.ansi16,
        ansi256: context.tuiTheme.dark ? 236 : 254,
        rgb: base.rgb.map((channel, index) =>
          Math.round(channel * 0.65 + border.rgb[index]! * 0.35),
        ) as unknown as readonly [number, number, number],
      }
    : border;
  const fg = context.tuiTheme.primary;
  const level = context.colorLevel;
  const bgCode =
    level === 3
      ? `\x1b[48;2;${bg.rgb.join(';')}m`
      : level === 2
        ? `\x1b[48;5;${bg.ansi256}m`
        : `\x1b[${bg.ansi16 + 10}m`;
  const fgCode =
    level === 3
      ? `\x1b[38;2;${fg.rgb.join(';')}m`
      : level === 2
        ? `\x1b[38;5;${fg.ansi256}m`
        : `\x1b[${fg.ansi16}m`;
  return `${bgCode}${fgCode}${padded}\x1b[0m`;
}

/**
 * Scrollback blocks:
 * - user: full-width elevated row with a `❯` prefix and indented continuations
 * - assistant: free-flowing markdown, no left rail
 * - tool: muted diamond bullet
 */
export function renderTranscript(
  entries: TranscriptEntry[],
  width: number,
  context = createThemeContext({ colorLevel: 0 }),
): string[] {
  const contentWidth = Math.max(3, width);
  const markdown = new MarkdownRenderer(context);
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.kind === 'tool') {
      const { header, body } = splitToolLine(entry.text);
      const wrappedHeader = wrapWorkspaceText(header, Math.max(3, contentWidth - 2));
      wrappedHeader.forEach((line, i) => {
        if (i === 0) {
          const value = `◆ ${line}`;
          lines.push(context.tui('muted', value));
        } else lines.push(`  ${context.tui('muted', line)}`);
      });
      if (body) {
        for (const line of wrapWorkspaceText(
          markdown.render(body),
          Math.max(3, contentWidth - 2),
        )) {
          lines.push(`  ${context.tui('muted', line)}`);
        }
      }
      lines.push('');
      continue;
    }

    if (entry.kind === 'user') {
      for (const [index, part] of entry.text.split('\n').entries()) {
        lines.push(userPillLine(part || ' ', contentWidth, context, index === 0 ? '❯ ' : '  '));
      }
      lines.push('');
      continue;
    }

    if (entry.kind === 'reasoning') {
      lines.push(context.tui('muted', '◆ Thinking'));
      const rendered = wrapWorkspaceText(
        markdown.render(entry.text),
        Math.max(3, contentWidth - 2),
      );
      for (const line of rendered) lines.push(`  ${context.tui('muted', line)}`);
      lines.push('');
      continue;
    }

    if (entry.kind === 'status') {
      lines.push(context.tui('muted', `✦ ${entry.text}`));
      lines.push('');
      continue;
    }

    if (entry.kind === 'error') {
      const rendered = wrapWorkspaceText(entry.text, contentWidth);
      for (const line of rendered) lines.push(context.tui('error', line));
      lines.push('');
      continue;
    }

    if (entry.kind === 'system') {
      const rendered = wrapWorkspaceText(entry.text, contentWidth);
      for (const line of rendered) lines.push(context.tui('muted', line));
      lines.push('');
      continue;
    }

    // assistant: free-flow markdown, no accent rail
    const rendered = markdown.render(entry.text);
    const wrapped = wrapWorkspaceText(rendered, contentWidth);
    for (const line of wrapped) lines.push(line);
    lines.push('');
  }

  return lines;
}
