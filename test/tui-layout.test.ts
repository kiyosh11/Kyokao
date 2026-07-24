import { describe, expect, it } from 'vitest';
import {
  createThemeContext,
  displayWidth,
  EditorState,
  renderSetupFrame,
  renderWorkspaceScreen,
  stripAnsi,
  type ScreenFrame,
} from '@kyokao/ui';

function expectSafeFrame(frame: ScreenFrame, width: number, height: number): void {
  expect(frame.lines).toHaveLength(height);
  expect(frame.lines.every((line) => displayWidth(line) <= width)).toBe(true);
  if (frame.cursor) {
    expect(frame.cursor.row).toBeGreaterThanOrEqual(0);
    expect(frame.cursor.row).toBeLessThan(height);
    expect(frame.cursor.column).toBeGreaterThanOrEqual(0);
    expect(frame.cursor.column).toBeLessThan(width);
  }
}

describe('rebuilt TUI layout contract', () => {
  it('renders /raw as escaped transcript records instead of formatted Markdown or terminal control', () => {
    const frame = renderWorkspaceScreen({
      width: 80,
      height: 14,
      header: {
        workspace: '~/projects/kyokao',
        provider: 'openai',
        model: 'model',
        approval: 'suggest',
      },
      transcript: [
        {
          kind: 'assistant',
          text: '# heading\n\x1b[31munsafe\x1b[0m',
          timestamp: 123,
        },
      ],
      editor: new EditorState(''),
      overlay: 'raw',
      themeContext: createThemeContext({ colorLevel: 0 }),
    });
    const rendered = frame.lines.map(stripAnsi).join('\n');
    expect(rendered).toContain('"kind":"assistant"');
    expect(rendered).toContain('\\u001b[31munsafe');
    expect(rendered).toContain('raw transcript');
    expectSafeFrame(frame, 80, 14);
  });

  it('fills the terminal edges with the GrokNight workspace background', () => {
    const frame = renderWorkspaceScreen({
      width: 72,
      height: 20,
      header: {
        workspace: '~/projects/kyokao',
        provider: 'nvidia',
        model: 'openai/gpt-oss-120b',
        approval: 'full-auto',
      },
      transcript: [],
      editor: new EditorState(''),
      themeContext: createThemeContext({ tuiTheme: 'kyokao-dark', colorLevel: 3 }),
    });
    const rows = frame.lines.map(stripAnsi);
    expect(frame.lines.every((line) => displayWidth(line) === 72)).toBe(true);
    expect(rows[0]!.startsWith('╭')).toBe(true);
    expect(rows[0]!.endsWith('╮')).toBe(true);
    expect(rows.at(-1)!.startsWith('╰')).toBe(true);
    expect(rows.at(-1)!.endsWith('╯')).toBe(true);
    expect(frame.background).toBe('\x1b[48;2;20;20;20m');
    expect(frame.lines.every((line) => line.includes('\x1b[48;2;20;20;20m'))).toBe(true);
  });

  it.each([
    [20, 8],
    [39, 14],
    [72, 20],
    [111, 30],
    [160, 40],
  ])('keeps every workspace row out of the wrap column at %ix%i', (width, height) => {
    const frame = renderWorkspaceScreen({
      width,
      height,
      header: {
        workspace: '~/projects/kyokao',
        provider: 'openai',
        model: 'openai/gpt-oss-120b',
        approval: 'full-auto',
      },
      transcript: [
        { kind: 'system', text: 'Session restored', timestamp: '2:20' },
        { kind: 'user', text: 'Fix the renderer', timestamp: '2:21' },
        {
          kind: 'assistant',
          text: '# Result\nThe layout now keeps timestamps and borders on their intended rows.',
          timestamp: '2:22',
        },
        { kind: 'tool', text: 'write_file: packages/ui/src/screen.ts', timestamp: '2:23' },
        { kind: 'error', text: 'Example error state', timestamp: '2:24' },
      ],
      editor: new EditorState('/'),
      paletteIndex: 2,
      usage: {
        totalTokens: 9_450,
        estimatedCostUsd: 0,
        contextTokens: 9_500,
        contextWindow: 500_000,
      },
      scheduler: {
        phase: 'idle',
        queue: ['queued follow-up', 'second queued follow-up'],
      },
      sessionPlan: ['Inspect rendering', 'Replace layout', 'Verify all states'],
    });
    expectSafeFrame(frame, width, height);
  });

  it('renders one activity status without chat timestamps and keeps composer metadata in place', () => {
    const frame = renderWorkspaceScreen({
      width: 111,
      height: 30,
      header: {
        workspace: '~',
        provider: 'openai',
        model: 'openai/gpt-oss-120b',
        approval: 'full-auto',
      },
      transcript: [{ kind: 'user', text: 'hey', timestamp: '2:24' }],
      editor: new EditorState(''),
      busy: true,
      busyKind: 'prompt',
      activityStartedAt: Date.now() - 4_000,
      usage: {
        totalTokens: 0,
        estimatedCostUsd: 0,
        contextTokens: 0,
        contextWindow: 128_000,
      },
    });
    const rows = frame.lines.map(stripAnsi);
    const text = rows.join('\n');
    expectSafeFrame(frame, 111, 30);
    expect(text.match(/Responding/g)).toHaveLength(1);
    expect(rows.find((row) => row.includes('❯ hey'))).not.toContain('2:24');
    expect(rows.find((row) => row.includes('openai/gpt-oss-120b'))).toContain('full-auto');
    expect(rows[0]).not.toContain('Responding');
    expect(text).not.toContain('◆ Thinking…');
  });

  it('keeps approval and secret prompts focused and cursor-safe', () => {
    const approval = renderWorkspaceScreen({
      width: 72,
      height: 20,
      header: { workspace: '~', provider: 'openai', model: 'model', approval: 'suggest' },
      transcript: [],
      editor: new EditorState(''),
      approval: { action: 'Run command', detail: 'pnpm test' },
    });
    expectSafeFrame(approval, 72, 20);
    expect(approval.cursor).toBeUndefined();
    expect(approval.lines.map(stripAnsi).join('\n')).toContain('[y/N]');

    const secret = renderWorkspaceScreen({
      width: 72,
      height: 20,
      header: { workspace: '~', provider: 'openai', model: 'model', approval: 'suggest' },
      transcript: [],
      editor: new EditorState('••••••'),
      secretLabel: 'API key',
    });
    expectSafeFrame(secret, 72, 20);
    expect(secret.cursor).toBeDefined();
    expect(secret.lines.map(stripAnsi).join('\n')).not.toContain('undefined');
  });

  it.each([
    [20, 8],
    [39, 14],
    [72, 20],
    [111, 30],
  ])('uses the same safe geometry for setup at %ix%i', (width, height) => {
    const frame = renderSetupFrame({
      width,
      height,
      step: 'provider',
      title: 'Choose a provider',
      items: Array.from({ length: 15 }, (_, index) => ({
        name: `provider-${index}`,
        description: 'OpenAI-compatible endpoint',
      })),
      selected: 8,
      themeContext: createThemeContext({ tuiTheme: 'dracula', colorLevel: 3 }),
    });
    expectSafeFrame(frame, width, height);
    const rows = frame.lines.map(stripAnsi);
    expect(rows[0]).toContain('kyokao');
    expect(rows[0]).not.toContain('╭');
    expect(rows.at(-1)).toContain('Enter');
  });

  it('renders setup input, review, warning, and busy states without exposing secrets', () => {
    const key = renderSetupFrame({
      width: 111,
      height: 30,
      step: 'key',
      title: 'CAPY_API_KEY (input is hidden)',
      value: 'not-for-rendering',
      secret: true,
      message: 'The key will be stored locally.',
    });
    const keyText = key.lines.map(stripAnsi).join('\n');
    expectSafeFrame(key, 111, 30);
    expect(keyText).not.toContain('not-for-rendering');
    expect(keyText).toContain('••••');
    expect(keyText).toContain('stored locally');
    expect(key.cursor).toBeDefined();

    const longValue = renderSetupFrame({
      width: 39,
      height: 14,
      step: 'model',
      title: 'Model ID',
      value: 'model-'.repeat(40),
    });
    expectSafeFrame(longValue, 39, 14);
    expect(longValue.cursor).toBeDefined();
    expect(longValue.cursor!.column).toBeLessThan(
      displayWidth(longValue.lines[longValue.cursor!.row]!) - 1,
    );

    const busy = renderSetupFrame({
      width: 111,
      height: 30,
      step: 'key',
      title: 'Checking credentials',
      value: 'hidden',
      secret: true,
      busy: true,
    });
    expectSafeFrame(busy, 111, 30);
    expect(busy.cursor).toBeUndefined();
    expect(busy.lines.map(stripAnsi).join('\n')).toContain('Checking models…');

    const review = renderSetupFrame({
      width: 111,
      height: 30,
      step: 'review',
      title: 'Review setup',
      review: ['Provider: capy', 'Model: captain', 'Capy project: project-1', 'Approval: suggest'],
    });
    expectSafeFrame(review, 111, 30);
    const reviewText = review.lines.map(stripAnsi).join('\n');
    expect(reviewText).toContain('◆ Provider: capy');
    expect(reviewText).toContain('Enter save');
  });
});
