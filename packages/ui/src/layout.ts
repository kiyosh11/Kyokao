import { displayWidth, padDisplay, truncateDisplay } from './editor.js';
import type { ThemeContext } from './theme.js';

export interface TuiGeometry {
  terminalWidth: number;
  margin: number;
  contentWidth: number;
}

export function tuiGeometry(width: number): TuiGeometry {
  const terminalWidth = Math.max(12, width);
  const margin = terminalWidth >= 72 ? 2 : 1;
  return {
    terminalWidth,
    margin,
    contentWidth: Math.max(8, terminalWidth - margin * 2),
  };
}

export function insetLine(value: string, geometry: TuiGeometry): string {
  return `${' '.repeat(geometry.margin)}${padDisplay(value, geometry.contentWidth)}`;
}

export function readableMuted(context: ThemeContext, value: string): string {
  return context.paint({ ...context.tuiTheme.muted, modifiers: [] }, value);
}

export function topBorder(width: number, label = '', rightLabel = ''): string {
  const inner = Math.max(0, width - 2);
  const left = label ? ` ${truncateDisplay(label, Math.max(0, inner - 2))} ` : '';
  const right = rightLabel
    ? ` ${truncateDisplay(rightLabel, Math.max(0, inner - displayWidth(left) - 2))} `
    : '';
  const rule = '─'.repeat(Math.max(0, inner - displayWidth(left) - displayWidth(right)));
  return `╭${left}${rule}${right}╮`;
}

export function bottomBorder(width: number, rightLabel = ''): string {
  const inner = Math.max(0, width - 2);
  const right = rightLabel ? ` ${truncateDisplay(rightLabel, Math.max(0, inner - 2))} ` : '';
  return `╰${'─'.repeat(Math.max(0, inner - displayWidth(right)))}${right}╯`;
}

export function captionedBottomBorder(
  width: number,
  rightLabel: string,
  context: ThemeContext,
): string {
  const inner = Math.max(0, width - 2);
  const caption = rightLabel ? ` ${truncateDisplay(rightLabel, Math.max(0, inner - 2))} ` : '';
  const rule = '─'.repeat(Math.max(0, inner - displayWidth(caption)));
  return `${context.tui('border', `╰${rule}`)}${readableMuted(context, caption)}${context.tui(
    'border',
    '╯',
  )}`;
}

export function borderedRow(value: string, width: number, context: ThemeContext): string {
  const inner = padDisplay(` ${value}`, Math.max(0, width - 2));
  return `${context.tui('border', '│')}${inner}${context.tui('border', '│')}`;
}
