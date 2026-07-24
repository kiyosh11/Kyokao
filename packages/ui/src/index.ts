import { createThemeContext, type ThemeContext } from './theme.js';
import {
  highlightCode as renderHighlightedCode,
  renderMarkdown as renderThemedMarkdown,
} from './markdown.js';

export * from './theme.js';
export * from './markdown.js';
export * from './editor.js';
export * from './layout.js';
export * from './terminal.js';
export * from './palette.js';
export * from './transcript.js';
export * from './screen.js';
export * from './workspace.js';
export * from './log.js';
export * from './setup-render.js';
export * from './setup.js';

export function highlightCode(
  source: string,
  language = '',
  context: ThemeContext = createThemeContext({ colorLevel: 0 }),
): string {
  return renderHighlightedCode(source, language, context);
}

export function renderMarkdown(
  value: string,
  context: ThemeContext = createThemeContext({ colorLevel: 0 }),
): string {
  return renderThemedMarkdown(value, context);
}
