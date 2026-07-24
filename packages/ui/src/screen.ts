import type { SchedulerState } from '@kyokao/agent';
import { displayWidth, EditorState, layoutEditor, padDisplay, truncateDisplay } from './editor.js';
import {
  borderedRow,
  bottomBorder,
  captionedBottomBorder,
  insetLine,
  readableMuted,
  topBorder,
  tuiGeometry,
} from './layout.js';
import {
  type CommandDefinition,
  type WorkspaceCommand,
  filterWorkspaceCommands,
  visiblePaletteCommands,
  workspaceCommands,
} from './palette.js';
import type { ScreenFrame } from './terminal.js';
import { createThemeContext, type ThemeContext } from './theme.js';
import { renderTranscript, type TranscriptEntry, wrapWorkspaceText } from './transcript.js';

export interface WorkspaceHeader {
  workspace: string;
  provider: string;
  model: string;
  buildModel?: string;
  spendingUsd?: number;
  spendingLabel?: string;
  approval: string;
}

export interface WorkspaceUsage {
  totalTokens: number;
  estimatedCostUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
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
  activityStartedAt?: number;
  usage?: WorkspaceUsage;
  scheduler?: SchedulerState;
  themeContext?: ThemeContext;
  paletteCommands?: CommandDefinition[];
  secretLabel?: string;
  sessionTitle?: string;
  sessionPlan?: string[];
  overlay?: 'transcript' | 'shortcuts' | 'raw';
}

function paintBorder(value: string, context: ThemeContext): string {
  return context.tui('border', value);
}

function renderRawTranscript(entries: TranscriptEntry[], width: number): string[] {
  if (!entries.length) return ['No transcript entries.'];
  return entries.flatMap((entry) =>
    wrapWorkspaceText(
      JSON.stringify({
        kind: entry.kind,
        ...(entry.timestamp != null ? { timestamp: entry.timestamp } : {}),
        text: entry.text,
      }),
      width,
    ),
  );
}

function formatContextTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}K`;
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1_000)}K`;
  if (tokens < 10_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.floor(tokens / 1_000_000)}M`;
}

function formatTurnTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(2)}k`;
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1_000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(2)}m`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatWorkspaceUsage(usage: WorkspaceUsage): string {
  return `${formatContextTokenCount(usage.totalTokens)} tok · $${usage.estimatedCostUsd.toFixed(4)}`;
}

function formatContextUsage(usage?: WorkspaceUsage): string | undefined {
  if (usage?.contextTokens == null) return undefined;
  return usage.contextWindow
    ? `${formatContextTokenCount(usage.contextTokens)} / ${formatContextTokenCount(
        usage.contextWindow,
      )}`
    : `${formatContextTokenCount(usage.contextTokens)} / ?`;
}

export function renderWorkspaceFooter(
  width: number,
  usage?: WorkspaceUsage,
  busy?: boolean,
  context?: ThemeContext,
): string;
export function renderWorkspaceFooter(
  width: number,
  usage?: WorkspaceUsage,
  busy?: boolean,
  context?: ThemeContext,
): string {
  const hints = [
    ['Esc', 'interrupt'],
    ['Ctrl+T', 'transcript'],
    ['?', 'shortcuts'],
    ['Ctrl+C', busy ? 'cancel' : 'quit'],
  ] as const;
  const contextUsage = formatContextUsage(usage);
  const visibleHints = [...hints];
  const separator = '  │  ';
  const rightPadding = contextUsage ? Math.min(2, Math.max(0, width - 1)) : 0;
  const plainHints = () => visibleHints.map(([key, label]) => `${key}:${label}`).join(separator);
  const right = contextUsage
    ? truncateDisplay(contextUsage, Math.max(0, width - rightPadding))
    : '';
  const minimumGap = right ? 1 : 0;
  while (
    visibleHints.length &&
    displayWidth(plainHints()) + minimumGap + displayWidth(right) + rightPadding > width
  ) {
    visibleHints.pop();
  }
  const left = truncateDisplay(
    plainHints(),
    Math.max(0, width - displayWidth(right) - minimumGap - rightPadding),
  );
  const gap = Math.max(0, width - displayWidth(left) - displayWidth(right) - rightPadding);
  const plain = `${left}${' '.repeat(gap)}${right}${' '.repeat(rightPadding)}`;
  if (!context || context.colorLevel === 0) {
    return plain;
  }
  const renderedLeft = visibleHints
    .map(
      ([key, label]) =>
        `${context.paint(
          { ...context.tuiTheme.user, modifiers: ['bold'] },
          key,
        )}${readableMuted(context, `:${label}`)}`,
    )
    .join(context.paint({ ...context.tuiTheme.muted, modifiers: ['dim'] }, separator));
  const renderedContext = right ? readableMuted(context, right) : '';
  return `${renderedLeft}${' '.repeat(gap)}${renderedContext}${' '.repeat(rightPadding)}`;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

function activitySeconds(state: WorkspaceRenderState): number | undefined {
  return state.activityStartedAt == null
    ? undefined
    : Math.max(0, Math.floor((Date.now() - state.activityStartedAt) / 1000));
}

function computeStatus(state: WorkspaceRenderState): string {
  if (state.secretLabel) return state.secretLabel;
  if (state.approval) return `${state.approval.action}: ${state.approval.detail} [y/N]`;
  const phase = state.scheduler?.phase;
  if (phase === 'stopping') return 'Stopping…';
  if (phase === 'starting-replacement') return 'Replacing…';
  if (phase === 'failed') return 'Paused · /queue retry';
  if (state.busy) {
    const spinner = SPINNER_FRAMES[(state.animationFrame ?? 0) % SPINNER_FRAMES.length]!;
    const seconds = activitySeconds(state);
    const elapsed = seconds == null ? '' : ` ${seconds}s`;
    return state.busyKind === 'command'
      ? `${spinner} Working…${elapsed}`
      : `${spinner} ${state.transcript.at(-1)?.kind === 'reasoning' ? 'Thinking' : 'Responding'}…${elapsed}`;
  }
  if (state.scrollOffset) return `↑ ${state.scrollOffset}`;
  return '';
}

function renderTopBar(state: WorkspaceRenderState, width: number, context: ThemeContext): string {
  const path = state.header.workspace?.trim() || '~';
  return padDisplay(readableMuted(context, truncateDisplay(path, width)), width);
}

function renderShortcutOverlay(width: number, context: ThemeContext): string[] {
  const shortcuts = [
    'Enter submit  ·  Tab queue while running  ·  Shift/Alt+Enter newline',
    'Esc interrupt/close  ·  Ctrl+C cancel/quit  ·  Ctrl+L clear',
    'Ctrl+T transcript  ·  Ctrl+O copy last response  ·  Ctrl+G editor',
    'Ctrl+R/Ctrl+S history  ·  Wheel/PgUp/PgDn scroll  ·  ? close',
    'Ctrl+A/E line start/end  ·  Ctrl+B/F left/right  ·  Ctrl+P/N up/down',
    'Ctrl+U/K kill to start/end  ·  Ctrl+W/Alt+D delete word  ·  Ctrl+Y yank',
  ];
  return [
    paintBorder(topBorder(width, 'keyboard shortcuts'), context),
    ...shortcuts.map((shortcut) =>
      borderedRow(readableMuted(context, truncateDisplay(shortcut, width - 4)), width, context),
    ),
    paintBorder(bottomBorder(width), context),
  ];
}

const PALETTE_SECTION_LABELS: Partial<Record<WorkspaceCommand, string>> = {
  provider: 'Providers',
  permissions: 'Approval modes',
  model: 'Models',
  approval: 'Approval modes',
  memory: 'Memory',
  queue: 'Queue actions',
  sessions: 'Sessions',
  resume: 'Sessions',
  plan: 'Plan',
  rename: 'Session title',
  help: 'Command help',
};

function sectionLabelFor(command: WorkspaceCommand): string | undefined {
  return (
    PALETTE_SECTION_LABELS[command] ??
    workspaceCommands.find((item) => item.name === command)?.group ??
    undefined
  );
}

function renderPaletteBox(
  state: WorkspaceRenderState,
  matches: CommandDefinition[],
  paletteIndex: number,
  maxRows: number,
  width: number,
  context: ThemeContext,
): string[] {
  if (!matches.length || maxRows <= 0) return [];
  const window = visiblePaletteCommands(matches, paletteIndex, maxRows);
  const commandName = state.editor.text.match(/^\/([a-z-]+)(?:\s|$)/i)?.[1]?.toLowerCase();
  const paletteCommand = workspaceCommands.find((entry) => entry.name === commandName)?.name as
    WorkspaceCommand | undefined;
  const label = /^\/settings\s+code-theme(?:\s|$)/i.test(state.editor.text)
    ? 'Code themes'
    : /^\/settings\s+theme(?:\s|$)/i.test(state.editor.text)
      ? 'TUI themes'
      : /^\/settings(?:\s|$)/i.test(state.editor.text)
        ? 'Settings'
        : paletteCommand
          ? (sectionLabelFor(paletteCommand) ?? 'Commands')
          : 'Commands';
  const lines = [
    paintBorder(topBorder(width, label, `${paletteIndex + 1} of ${matches.length}`), context),
  ];
  for (const [index, item] of window.commands.entries()) {
    const absoluteIndex = window.start + index;
    const selected = absoluteIndex === paletteIndex;
    const marker = selected ? '›' : ' ';
    const itemLabel = item.label ?? `/${item.name}`;
    const labelWidth = Math.min(
      Math.max(4, displayWidth(itemLabel) + 1),
      Math.max(4, Math.floor((width - 4) * 0.4)),
    );
    const content = `${marker} ${padDisplay(itemLabel, labelWidth)} ${truncateDisplay(
      item.description,
      Math.max(0, width - 4 - labelWidth),
    )}`;
    lines.push(borderedRow(selected ? context.tui('selected', content) : content, width, context));
  }
  lines.push(paintBorder(bottomBorder(width), context));
  return lines;
}

function renderQueueBox(
  queued: readonly string[],
  maxRows: number,
  width: number,
  context: ThemeContext,
): string[] {
  if (!queued.length || maxRows <= 0) return [];
  const lines = [paintBorder(topBorder(width, `queue · ${queued.length}`), context)];
  for (const prompt of queued.slice(0, maxRows)) {
    const preview = truncateDisplay(prompt.replace(/\n/g, ' ↵ '), width - 4);
    lines.push(borderedRow(readableMuted(context, `◆ ${preview}`), width, context));
  }
  lines.push(paintBorder(bottomBorder(width), context));
  return lines;
}

function renderPlanBox(
  plan: readonly string[],
  maxRows: number,
  width: number,
  context: ThemeContext,
): string[] {
  if (!plan.length || maxRows <= 0) return [];
  const lines = [
    paintBorder(
      topBorder(width, `plan · ${plan.length} step${plan.length === 1 ? '' : 's'}`),
      context,
    ),
  ];
  for (const [index, step] of plan.slice(0, maxRows).entries()) {
    const preview = truncateDisplay(step.replace(/\n/g, ' ↵ '), width - 8);
    lines.push(borderedRow(readableMuted(context, `${index + 1}. ${preview}`), width, context));
  }
  lines.push(paintBorder(bottomBorder(width), context));
  return lines;
}

function renderStatusStrip(
  state: WorkspaceRenderState,
  width: number,
  context: ThemeContext,
): string {
  const busy = Boolean(
    state.scheduler?.active || state.scheduler?.phase === 'stopping' || state.busy,
  );
  const left = busy ? computeStatus(state) : '';
  const seconds = busy ? activitySeconds(state) : undefined;
  const rightParts: string[] = [];
  if (seconds != null) rightParts.push(`${seconds}s`);
  if (state.usage?.totalTokens)
    rightParts.push(`⇣${formatTurnTokenCount(state.usage.totalTokens)}`);
  let right = rightParts.join(' ');
  if (busy && state.busyKind !== 'command') right += `${right ? ' ' : ''}[stop]`;
  if (!left && !right) return ' '.repeat(width);

  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  return padDisplay(
    `${readableMuted(context, left)}${' '.repeat(gap)}${readableMuted(context, right)}`,
    width,
  );
}

export function renderWorkspaceScreen(state: WorkspaceRenderState): ScreenFrame & {
  palette: CommandDefinition[];
  transcriptHeight: number;
  transcriptLength: number;
} {
  const context = state.themeContext ?? createThemeContext({ colorLevel: 0 });
  const baseGeometry = tuiGeometry(state.width);
  const geometry = {
    ...baseGeometry,
    margin: 0,
    contentWidth: baseGeometry.terminalWidth,
  };
  const terminalHeight = Math.max(8, state.height);
  const height = Math.max(6, terminalHeight - 2);
  const outerWidth = geometry.contentWidth;
  const contentWidth = Math.max(6, outerWidth - 2);
  const frameRow = (value: string): string =>
    context.background(
      insetLine(
        `${paintBorder('│', context)}${padDisplay(value, contentWidth)}${paintBorder('│', context)}`,
        geometry,
      ),
    );

  const matches =
    state.paletteCommands ??
    (state.editor.text.startsWith('/') && state.busyKind !== 'command'
      ? (filterWorkspaceCommands(state.editor.text, context) as CommandDefinition[])
      : []);
  const paletteIndex = Math.max(
    0,
    Math.min(state.paletteIndex ?? 0, Math.max(0, matches.length - 1)),
  );

  if (state.overlay) {
    const overlayHeight = Math.max(1, height - 2);
    const overlayRows =
      state.overlay === 'shortcuts'
        ? renderShortcutOverlay(contentWidth, context)
        : state.overlay === 'raw'
          ? renderRawTranscript(state.transcript, contentWidth)
          : renderTranscript(state.transcript, contentWidth, context);
    const maxScroll = Math.max(0, overlayRows.length - overlayHeight);
    const scrollOffset = Math.min(state.scrollOffset ?? 0, maxScroll);
    const end = overlayRows.length - scrollOffset;
    const visibleRows = overlayRows.slice(Math.max(0, end - overlayHeight), end).map(frameRow);
    while (visibleRows.length < overlayHeight) visibleRows.push(frameRow(''));
    const overlayHint =
      state.overlay === 'raw'
        ? 'raw transcript - Up/Down/PgUp/PgDn scroll - Esc close'
        : state.overlay === 'shortcuts'
          ? '? close  ·  Esc close'
          : '↑↓/PgUp/PgDn scroll  ·  Ctrl+T close  ·  Esc close';
    const bodyLines = [
      frameRow(renderTopBar(state, contentWidth, context)),
      ...visibleRows,
      frameRow(readableMuted(context, padDisplay(overlayHint, contentWidth))),
    ];
    return {
      lines: [
        context.background(
          insetLine(paintBorder(topBorder(outerWidth, 'kyokao'), context), geometry),
        ),
        ...bodyLines,
        context.background(insetLine(paintBorder(bottomBorder(outerWidth), context), geometry)),
      ],
      background: context.backgroundEscape(),
      palette: [],
      transcriptHeight: overlayHeight,
      transcriptLength: overlayRows.length,
    };
  }

  const editorWidth = Math.max(1, contentWidth - 4);
  const editorLayout = layoutEditor(state.editor.text, state.editor.cursor, editorWidth);
  const maxComposerRows = Math.max(1, Math.min(4, Math.floor(height / 4)));
  const composerRows = Math.min(editorLayout.rows.length, maxComposerRows);
  const composerStart = Math.max(
    0,
    Math.min(editorLayout.cursor.row - composerRows + 1, editorLayout.rows.length - composerRows),
  );
  const visibleComposer = editorLayout.rows.slice(composerStart, composerStart + composerRows);

  const topGapRows = height >= 12 ? 1 : 0;
  const hintRows = height >= 9 ? 1 : 0;
  const promptBoxRows = composerRows + 2;
  const chromeRows = 1 + topGapRows + 1 + promptBoxRows + hintRows;
  let availableRows = Math.max(1, height - chromeRows);

  let paletteRows = 0;
  if (matches.length && availableRows >= 4) {
    paletteRows = Math.min(7, matches.length, availableRows - 3);
    availableRows -= paletteRows + 2;
  }

  let queueRows = 0;
  if (state.scheduler?.queue?.length && availableRows >= 4) {
    queueRows = Math.min(2, state.scheduler.queue.length, availableRows - 3);
    availableRows -= queueRows + 2;
  }

  let planRows = 0;
  if (state.sessionPlan?.length && availableRows >= 4) {
    planRows = Math.min(5, state.sessionPlan.length, availableRows - 3);
    availableRows -= planRows + 2;
  }

  const transcriptHeight = Math.max(1, availableRows);
  const renderedTranscript = renderTranscript(state.transcript, contentWidth, context);
  const maxScroll = Math.max(0, renderedTranscript.length - transcriptHeight);
  const scrollOffset = Math.min(state.scrollOffset ?? 0, maxScroll);
  const end = renderedTranscript.length - scrollOffset;
  const visibleTranscript = renderedTranscript.slice(Math.max(0, end - transcriptHeight), end);
  const transcriptRows = visibleTranscript.map(frameRow);
  while (transcriptRows.length < transcriptHeight) transcriptRows.push(frameRow(''));

  const bodyLines: string[] = [frameRow(renderTopBar(state, contentWidth, context))];
  if (topGapRows) bodyLines.push(frameRow(''));
  bodyLines.push(...transcriptRows);

  if (planRows) {
    bodyLines.push(
      ...renderPlanBox(state.sessionPlan!, planRows, contentWidth, context).map(frameRow),
    );
  }
  if (paletteRows) {
    bodyLines.push(
      ...renderPaletteBox(state, matches, paletteIndex, paletteRows, contentWidth, context).map(
        frameRow,
      ),
    );
  }
  if (queueRows) {
    bodyLines.push(
      ...renderQueueBox(state.scheduler!.queue!, queueRows, contentWidth, context).map(frameRow),
    );
  }

  bodyLines.push(frameRow(renderStatusStrip(state, contentWidth, context)));
  const promptBoxTop = bodyLines.length;
  bodyLines.push(frameRow(paintBorder(topBorder(contentWidth), context)));
  for (const row of visibleComposer) {
    const prefix = row.startsWith('❯ ') ? '❯ ' : row.startsWith('  ') ? '  ' : '';
    const rest = prefix ? row.slice(prefix.length) : row;
    const painted = prefix
      ? `${context.tui('inputAccent', prefix)}${context.tui('primary', rest)}`
      : context.tui('primary', row);
    bodyLines.push(frameRow(borderedRow(painted, contentWidth, context)));
  }
  const modelLabel = state.header.buildModel
    ? `Captain ${state.header.model} · Build ${state.header.buildModel}`
    : state.header.model;
  const spendingLabel =
    state.header.spendingUsd != null
      ? `$${state.header.spendingUsd.toFixed(2)} ${state.header.spendingLabel ?? 'spent'}`
      : undefined;
  const infoLabel = [modelLabel, spendingLabel, state.header.approval].filter(Boolean).join(' · ');
  bodyLines.push(frameRow(captionedBottomBorder(contentWidth, infoLabel, context)));

  if (hintRows) {
    const isSessionsPalette = state.editor.text.startsWith('/sessions') && matches.length;
    const footer = isSessionsPalette
      ? '↑↓ scroll · enter open · ctrl+d delete · esc cancel'
      : state.approval || state.secretLabel
        ? computeStatus(state)
        : renderWorkspaceFooter(contentWidth, state.usage, state.busy, context);
    const painted =
      state.approval || state.secretLabel
        ? context.tui('warning', footer)
        : context.colorLevel === 0
          ? readableMuted(context, footer)
          : footer;
    bodyLines.push(frameRow(painted));
  }

  while (bodyLines.length < height)
    bodyLines.splice(1 + topGapRows + transcriptHeight, 0, frameRow(''));
  if (bodyLines.length > height) bodyLines.splice(1 + topGapRows, bodyLines.length - height);

  const lines = [
    context.background(insetLine(paintBorder(topBorder(outerWidth, 'kyokao'), context), geometry)),
    ...bodyLines,
    context.background(insetLine(paintBorder(bottomBorder(outerWidth), context), geometry)),
  ];

  const cursor =
    (state.busyKind === 'command' && !state.secretLabel) || state.approval
      ? undefined
      : {
          row: promptBoxTop + 2 + (editorLayout.cursor.row - composerStart),
          column: Math.min(
            geometry.terminalWidth - geometry.margin - 3,
            geometry.margin + 3 + editorLayout.cursor.column,
          ),
        };

  return {
    lines,
    background: context.backgroundEscape(),
    cursor,
    palette: matches,
    transcriptHeight,
    transcriptLength: renderedTranscript.length,
  };
}
