import { displayWidth, graphemes, padDisplay, truncateDisplay } from './editor.js';
import {
  borderedRow,
  bottomBorder,
  insetLine,
  readableMuted,
  topBorder,
  tuiGeometry,
} from './layout.js';
import type { ScreenFrame } from './terminal.js';
import { createThemeContext, type ThemeContext } from './theme.js';
import { wrapWorkspaceText } from './transcript.js';

export interface SetupItem {
  name: string;
  description?: string;
  danger?: boolean;
}

export interface SetupFrameInput {
  width: number;
  height?: number;
  step: string;
  title: string;
  items?: SetupItem[];
  selected?: number;
  value?: string;
  secret?: boolean;
  review?: string[];
  message?: string;
  busy?: boolean;
  themeContext?: ThemeContext;
}

export const approvalChoices = [
  { value: 'suggest', description: 'Propose changes; ask before every edit or command.' },
  { value: 'auto-edit', description: 'Apply file edits automatically; ask before commands.' },
  {
    value: 'full-auto',
    description: 'Run edits and commands without approval. Use only in a trusted workspace.',
  },
] as const;

export function validateProviderName(value: string): string | undefined {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ? undefined : 'Use letters, numbers, _ or -.';
}

export function validateBaseURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? undefined : 'Use an http(s) URL.';
  } catch {
    return 'Enter a valid http(s) URL.';
  }
}

export function setupSelect(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index + delta));
}

export function maskSecret(value: string): string {
  return value ? '•'.repeat(Math.min(graphemes(value).length, 24)) : '';
}

export function setupWordmark(width: number): string[] {
  return width < 36 ? ['kyokao'] : ['kyokao', 'Terminal coding agent'];
}

export function visibleSetupItems<T>(
  items: T[],
  selected: number,
  height: number,
  chromeRows = 10,
): { items: T[]; start: number; before: boolean; after: boolean } {
  const size = Math.max(1, Math.min(items.length, Math.max(1, height - chromeRows)));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
  return {
    items: items.slice(start, start + size),
    start,
    before: start > 0,
    after: start + size < items.length,
  };
}

function headerLine(input: SetupFrameInput, width: number, context: ThemeContext): string {
  const left = context.tui('brand', 'kyokao');
  const right = readableMuted(context, `SETUP · ${input.step.toUpperCase()}`);
  const gap = width - displayWidth(left) - displayWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : truncateDisplay(left, width);
}

function renderItems(
  input: SetupFrameInput,
  capacity: number,
  width: number,
  context: ThemeContext,
): string[] {
  const items = input.items ?? [];
  if (!items.length || capacity <= 0) return [];
  const listSize = Math.max(1, Math.min(9, capacity - (items.length > capacity ? 2 : 0)));
  const window = visibleSetupItems(items, input.selected ?? 0, listSize, 0);
  const rows: string[] = [];
  if (window.before) rows.push(readableMuted(context, '  ↑ more'));
  for (const [offset, item] of window.items.entries()) {
    const index = window.start + offset;
    const selected = index === input.selected;
    const marker = selected ? context.tui('inputAccent', '›') : readableMuted(context, ' ');
    const available = Math.max(1, width - 3);
    const nameWidth = Math.max(4, Math.min(Math.floor(available * 0.38), available));
    const name = padDisplay(item.name, nameWidth);
    const description = item.description
      ? `  ${truncateDisplay(item.description, Math.max(0, available - nameWidth - 2))}`
      : '';
    const content = `${marker} ${name}${description}`;
    rows.push(
      item.danger
        ? context.tui('error', content)
        : selected
          ? context.tui('primary', content)
          : readableMuted(context, content),
    );
  }
  if (window.after) rows.push(readableMuted(context, '  ↓ more'));
  return rows.slice(0, capacity);
}

function renderReview(rows: string[], width: number, context: ThemeContext): string[] {
  return rows.flatMap((row) => {
    const separator = row.indexOf(':');
    const label = separator >= 0 ? row.slice(0, separator) : '';
    const value = separator >= 0 ? row.slice(separator + 1).trim() : row;
    const prefix = label
      ? `${context.tui('inputAccent', '◆')} ${readableMuted(context, `${label}:`)} `
      : `${context.tui('inputAccent', '◆')} `;
    const wrapped = wrapWorkspaceText(value, Math.max(1, width - displayWidth(prefix)));
    return wrapped.map((line, index) =>
      index === 0 ? `${prefix}${context.tui('primary', line)}` : `  ${line}`,
    );
  });
}

function controlsFor(input: SetupFrameInput): string {
  if (input.busy) return 'Checking models…  Ctrl+C cancel';
  if (input.step === 'review') return 'Enter save  ·  Esc back  ·  Ctrl+C cancel';
  if (input.items) return '↑↓ move  ·  Enter choose  ·  Esc back  ·  Ctrl+C cancel';
  return 'Enter continue  ·  Esc back  ·  Ctrl+C cancel';
}

export function renderSetupFrame(input: SetupFrameInput): ScreenFrame {
  const context = input.themeContext ?? createThemeContext({ colorLevel: 0 });
  const geometry = tuiGeometry(input.width);
  const height = Math.max(8, input.height ?? 28);
  const compact = height < 12;
  const header = [
    headerLine(input, geometry.contentWidth, context),
    ...(compact ? [] : [readableMuted(context, 'Terminal coding agent')]),
    '',
    context.tui('primary', truncateDisplay(input.title, geometry.contentWidth)),
  ];
  const footer = [
    context.tui('border', '─'.repeat(geometry.contentWidth)),
    readableMuted(context, controlsFor(input)),
  ];
  const capacity = Math.max(1, height - header.length - footer.length);
  const body: string[] = [];
  let cursorBodyRow: number | undefined;
  let cursorValueWidth = 0;

  if (input.items) {
    body.push('', ...renderItems(input, Math.max(1, capacity - 1), geometry.contentWidth, context));
  } else if (input.value !== undefined) {
    const value = input.secret
      ? maskSecret(input.value)
      : truncateDisplay(input.value, Math.max(1, geometry.contentWidth - 6), '');
    body.push('', context.tui('border', topBorder(geometry.contentWidth)));
    cursorBodyRow = body.length;
    cursorValueWidth = displayWidth(value);
    body.push(
      borderedRow(
        `${context.tui('inputAccent', '› ')}${context.tui('primary', value)}`,
        geometry.contentWidth,
        context,
      ),
    );
    body.push(context.tui('border', bottomBorder(geometry.contentWidth)));
  } else if (input.review) {
    body.push('', ...renderReview(input.review, geometry.contentWidth, context));
  }

  if (input.message) {
    body.push(
      '',
      ...wrapWorkspaceText(input.message, geometry.contentWidth).map((row) =>
        context.tui('warning', row),
      ),
    );
  }

  const visibleBody = body.slice(0, capacity);
  while (visibleBody.length < capacity) visibleBody.push('');
  const lines = [...header, ...visibleBody, ...footer].map((row) =>
    context.background(insetLine(row, geometry)),
  );

  const cursor =
    cursorBodyRow == null || input.busy || cursorBodyRow >= capacity
      ? undefined
      : {
          row: header.length + cursorBodyRow,
          column: Math.min(
            geometry.terminalWidth - geometry.margin - 1,
            geometry.margin + 4 + cursorValueWidth,
          ),
        };

  return { lines, background: context.backgroundEscape(), cursor };
}

export function renderSetupScreen(input: SetupFrameInput): string {
  return renderSetupFrame(input).lines.join('\n');
}
