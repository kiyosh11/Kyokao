import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE_THEME_NAMES,
  TUI_THEME_NAMES,
  codeThemes,
  detectColorLevel,
  suggestName,
  tuiThemes,
} from '@kyokao/themes';
import {
  CodeRenderer,
  EditorState,
  MarkdownRenderer,
  MarkdownStreamRenderer,
  createThemeContext,
  createUi,
  displayWidth,
  renderWorkspaceScreen,
  renderTranscript,
  stripAnsi,
  terminalWorkspace,
  wrapWorkspaceText,
  type ParsedCommand,
} from '@kyokao/ui';
import { loadConfig, saveGlobalThemes } from '@kyokao/config';
import type { PromptBackend } from '@kyokao/agent';
const tokenKeys = ['ansi16', 'ansi256', 'rgb'] as const;
describe('theme registry and terminal capability', () => {
  it('contains unique, frozen, schema-complete built-ins', () => {
    expect(new Set(TUI_THEME_NAMES).size).toBe(TUI_THEME_NAMES.length);
    expect(new Set(CODE_THEME_NAMES).size).toBe(CODE_THEME_NAMES.length);
    expect(Object.keys(tuiThemes).sort()).toEqual([...TUI_THEME_NAMES].sort());
    expect(Object.keys(codeThemes).sort()).toEqual([...CODE_THEME_NAMES].sort());
    for (const theme of [...Object.values(tuiThemes), ...Object.values(codeThemes)]) {
      expect(Object.isFrozen(theme)).toBe(true);
      for (const value of Object.values(theme)) {
        if (typeof value !== 'object') continue;
        for (const key of tokenKeys) expect(value).toHaveProperty(key);
        expect(value.rgb).toHaveLength(3);
      }
    }
  });
  it('honors NO_COLOR, non-TTY defaults, force color, and common levels', () => {
    expect(detectColorLevel({ env: { NO_COLOR: '' }, isTTY: true, forceColor: 3 })).toBe(0);
    expect(detectColorLevel({ env: {}, isTTY: false })).toBe(0);
    expect(detectColorLevel({ env: { FORCE_COLOR: '2' }, isTTY: false })).toBe(2);
    expect(detectColorLevel({ env: { TERM: 'xterm-256color' }, isTTY: true })).toBe(2);
    expect(detectColorLevel({ env: { COLORTERM: 'truecolor' }, isTTY: true })).toBe(3);
    expect(detectColorLevel({ env: { WT_SESSION: 'terminal-session' }, isTTY: true })).toBe(3);
  });
  it('suggests close valid names without changing context state', () => {
    const context = createThemeContext({ tuiTheme: 'nord', codeTheme: 'kyokao', colorLevel: 1 });
    expect(suggestName('dracla', TUI_THEME_NAMES)[0]).toBe('dracula');
    expect(() => context.setTuiTheme('dracla')).toThrow('Unknown');
    expect(context.names).toEqual({ tui: 'nord', code: 'kyokao' });
  });
  it('scopes diff rendering to the selected code theme and NO_COLOR', () => {
    const themedOutput = {
      text: '',
      write(value: string) {
        this.text += value;
        return true;
      },
    };
    createUi(createThemeContext({ codeTheme: 'github-light', colorLevel: 3 }), {
      stdout: themedOutput as never,
    }).diff('+added\n-removed');
    expect(themedOutput.text).toContain('\x1b[38;2;17;99;41m');
    expect(stripAnsi(themedOutput.text)).toBe('+added\n-removed\n');
    const plainOutput = {
      text: '',
      write(value: string) {
        this.text += value;
        return true;
      },
    };
    createUi(
      createThemeContext({
        codeTheme: 'dracula',
        env: { NO_COLOR: '' },
        isTTY: true,
        forceColor: 3,
      }),
      { stdout: plainOutput as never },
    ).diff('+added\n-removed');
    expect(plainOutput.text).not.toContain('\x1b[');
    expect(plainOutput.text).toBe('+added\n-removed\n');
  });
});
describe('theme configuration', () => {
  it('applies global, profile, environment, and CLI precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kyokao-theme-config-'));
    const global = join(root, 'global.json');
    await writeFile(
      global,
      JSON.stringify({
        theme: 'nord',
        codeTheme: 'nord',
        profiles: { demo: { theme: 'dracula', codeTheme: 'dracula' } },
      }),
    );
    const base = await loadConfig({ cwd: root, globalPath: global, env: {} });
    expect(base).toMatchObject({ theme: 'nord', codeTheme: 'nord' });
    const profile = await loadConfig({
      cwd: root,
      globalPath: global,
      profile: 'demo',
      env: {},
    });
    expect(profile).toMatchObject({ theme: 'dracula', codeTheme: 'dracula' });
    const environment = await loadConfig({
      cwd: root,
      globalPath: global,
      profile: 'demo',
      env: { KYOKAO_THEME: 'solarized-light', KYOKAO_CODE_THEME: 'github-light' },
    });
    expect(environment).toMatchObject({
      theme: 'solarized-light',
      codeTheme: 'github-light',
    });
    const cli = await loadConfig({
      cwd: root,
      globalPath: global,
      env: { KYOKAO_THEME: 'solarized-light', KYOKAO_CODE_THEME: 'github-light' },
      cli: { theme: 'high-contrast', codeTheme: 'kyokao' },
    });
    expect(cli).toMatchObject({ theme: 'high-contrast', codeTheme: 'kyokao' });
  });
  it('validates names and atomically preserves unrelated global settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kyokao-theme-save-'));
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ provider: 'ollama', custom: { retained: true } }));
    await saveGlobalThemes('dracula', 'github-light', path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      provider: 'ollama',
      custom: { retained: true },
      theme: 'dracula',
      codeTheme: 'github-light',
    });
    await writeFile(path, JSON.stringify({ theme: 'unknown' }));
    await expect(loadConfig({ cwd: root, globalPath: path, env: {} })).rejects.toThrow('theme');
  });
});
const languageCases: Record<string, string> = {
  typescript: 'const value: number = 42; // answer\n',
  javascript: 'function answer() { return "42"; }\n',
  python: 'def answer():\n    return "42"  # value\n',
  json: '{"answer": 42, "ok": true}\n',
  bash: 'if true; then echo "42"; fi # answer\n',
  go: 'func answer() int { return 42 }\n',
  rust: 'fn answer() -> i32 { 42 }\n',
  java: 'int answer() { return 42; }\n',
  c: 'int answer(void) { return 42; }\n',
  cpp: 'std::string answer = "42";\n',
  html: '<div class="answer">42</div><!-- ok -->\n',
  css: '.answer { color: #123; /* ok */ }\n',
  yaml: 'answer: 42 # value\n',
  sql: 'SELECT answer FROM values_table WHERE id = 42; -- ok\n',
  markdown: '# Answer\n`42`\n',
  diff: '@@ -1 +1 @@\n-old\n+new\n',
};
describe('code and Markdown rendering', () => {
  const context = createThemeContext({
    tuiTheme: 'dracula',
    codeTheme: 'dracula',
    colorLevel: 3,
  });
  it.each(Object.entries(languageCases))(
    'preserves exact visible %s source while highlighting',
    (language, source) => {
      const rendered = new CodeRenderer(context).render(source, language);
      expect(rendered).toContain('\x1b[');
      expect(stripAnsi(rendered)).toBe(source);
    },
  );
  it('does not tokenize comment or string contents as code', () => {
    const rendered = new CodeRenderer(context).render(
      '// "string" 123 const\nconst text = "return 99";',
      'typescript',
    );
    expect(stripAnsi(rendered)).toBe('// "string" 123 const\nconst text = "return 99";');
    expect(rendered.match(/\x1b\[[^m]*m/g)?.length).toBeGreaterThan(4);
  });
  it('themes complete and incomplete Markdown without changing source', () => {
    const markdown = [
      '# Heading',
      '',
      '**bold** and *emphasis* with `inline()` and [link](https://example.test).',
      '- list',
      '> quote',
      '---',
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n');
    const renderer = new MarkdownRenderer(context);
    expect(stripAnsi(renderer.render(markdown))).toBe(markdown);
    const partial = 'before\n```python\ndef answer():\n    return "open';
    expect(stripAnsi(renderer.render(partial))).toBe(partial);
  });
  it('streams partial fences without duplication or content changes', () => {
    const renderer = new MarkdownStreamRenderer(context);
    const chunks = ['# Result\n```t', 's\nconst answer', ' = 42;\n``', '`\ndone'];
    const rendered = chunks.map((chunk) => renderer.write(chunk)).join('') + renderer.end();
    expect(stripAnsi(rendered)).toBe(chunks.join(''));
    expect(rendered).toContain('\x1b[');
  });
  it('keeps dark/light themed layout widths stable', () => {
    const state = {
      width: 72,
      height: 20,
      header: { workspace: '~', provider: 'fake', model: 'model', approval: 'suggest' },
      transcript: [{ kind: 'assistant' as const, text: '# Result\n```ts\nconst x = 42;\n```' }],
      editor: new EditorState('/settings theme '),
    };
    const dark = renderWorkspaceScreen({
      ...state,
      themeContext: createThemeContext({
        tuiTheme: 'dracula',
        codeTheme: 'dracula',
        colorLevel: 3,
      }),
    });
    const light = renderWorkspaceScreen({
      ...state,
      themeContext: createThemeContext({
        tuiTheme: 'solarized-light',
        codeTheme: 'github-light',
        colorLevel: 2,
      }),
    });
    expect(dark.lines.map(displayWidth)).toEqual(light.lines.map(displayWidth));
    expect(dark.lines.every((line) => displayWidth(line) <= 72)).toBe(true);
  });
  it.each([39, 79, 119])(
    'wraps ANSI and Unicode losslessly at Windows-like width %i',
    (terminalWidth) => {
      const source =
        'Readable wrapping keeps whole words, emoji 🧪, CJK 東京, combining e\u0301, and supercalifragilisticexpialidocious intact.';
      const colored = context.tui('assistant', source);
      const rows = wrapWorkspaceText(colored, terminalWidth - 5);
      expect(rows.every((row) => displayWidth(row) <= terminalWidth - 5)).toBe(true);
      expect(stripAnsi(rows.join(''))).toBe(source);
      expect(stripAnsi(rows[0]!)).toMatch(/\s$/);
      const transcript = renderTranscript(
        [{ kind: 'assistant', text: source }],
        terminalWidth,
        context,
      );
      const body = transcript.slice(0, -1);
      const reconstructed = body.map((row) => stripAnsi(row)).join('');
      expect(reconstructed).toBe(source);
      expect(body.every((row) => displayWidth(row) <= terminalWidth)).toBe(true);
    },
  );
  it('renders clean user text, free assistant text, and diamond tool bullets', () => {
    const rendered = renderTranscript(
      [
        { kind: 'user', text: 'Build it', timestamp: '8:19 AM' },
        { kind: 'reasoning', text: 'Inspecting the repository.' },
        { kind: 'assistant', text: 'Done', timestamp: '8:20 AM' },
        { kind: 'tool', text: 'write_file: completed', timestamp: '8:21 AM' },
      ],
      80,
      context,
    );
    const userRow = rendered.find((row) => stripAnsi(row).includes('❯ Build it'));
    expect(userRow).toBeDefined();
    expect(userRow).not.toMatch(/\x1b\[48/);
    expect(displayWidth(userRow!)).toBeLessThan(80);
    const transcript = rendered.map(stripAnsi);
    expect(transcript.some((row) => row.includes('❯ Build it'))).toBe(true);
    expect(transcript.some((row) => row.includes('◆ Thinking'))).toBe(true);
    expect(transcript.some((row) => row.includes('Inspecting the repository.'))).toBe(true);
    expect(transcript.some((row) => row.includes('Done'))).toBe(true);
    expect(transcript.some((row) => row.includes('write_file'))).toBe(true);
    expect(transcript.join('\n')).not.toContain('8:19 AM');
    expect(transcript.join('\n')).not.toContain('8:20 AM');
    expect(transcript.join('\n')).not.toContain('8:21 AM');
    expect(transcript.some((row) => row.includes('◆'))).toBe(true);
    expect(transcript.some((row) => row.includes('You'))).toBe(false);
    expect(transcript.some((row) => row.includes('Kyokao'))).toBe(false);
  });
  it('hard-wraps oversized tokens without dropping graphemes or adding ellipses', () => {
    const source = `prefix ${'abcdefghij'.repeat(7)} 東京 suffix`;
    const rows = wrapWorkspaceText(context.code('string', source), 13);
    expect(stripAnsi(rows.join(''))).toBe(source);
    expect(rows.every((row) => displayWidth(row) <= 13)).toBe(true);
    expect(rows.join('')).not.toContain('…');
  });
  it('carries ANSI state across physical lines without changing visible text', () => {
    const source = '/* first line\nsecond line */';
    const rendered = context.code('comment', source);
    const rows = wrapWorkspaceText(rendered, 40);
    expect(rows.map(stripAnsi)).toEqual(['/* first line', 'second line */']);
    expect(rows[1]).toContain('\x1b[');
  });
});
class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
  setEncoding() {
    return this;
  }
  pause() {
    return this;
  }
  resume() {
    return this;
  }
  send(value: string) {
    this.emit('data', value);
  }
}
class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 90;
  rows = 28;
  text = '';
  write(value: string) {
    this.text += value;
    return true;
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('live workspace theme switching', () => {
  it('switches while active without backend reset and preserves queue continuity', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const context = createThemeContext({
      tuiTheme: 'dracula',
      codeTheme: 'dracula',
      colorLevel: 1,
    });
    const runs: string[] = [];
    const releases: Array<() => void> = [];
    let resets = 0;
    let cancels = 0;
    const backend: PromptBackend = {
      provider: 'fake',
      async run(prompt, emit) {
        runs.push(prompt);
        emit('assistant', `running ${prompt}`);
        await new Promise<void>((resolve) => releases.push(resolve));
      },
      async cancel() {
        cancels++;
        releases.shift()?.();
      },
      async reset() {
        resets++;
      },
      async resume() {},
      status: () => ({ provider: 'fake', state: 'running' }),
      session: () => undefined,
      async close() {},
    };
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      backend,
      themeContext: context,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onCommand(command: ParsedCommand) {
        if (command.name === 'settings' && command.args[0] === 'theme') {
          context.setTuiTheme(command.args[1]!);
          return { messages: [{ text: `TUI theme changed to ${context.names.tui}.` }] };
        }
        if (command.name === 'exit') return { close: true };
      },
    });
    input.send('first\r');
    await tick();
    input.send('queued\t');
    await tick();
    input.send('/settings theme solarized-light\r');
    await tick();
    expect(context.names.tui).toBe('solarized-light');
    expect(runs).toEqual(['first']);
    expect(resets).toBe(0);
    expect(cancels).toBe(0);
    releases.shift()?.();
    await tick();
    expect(runs).toEqual(['first', 'queued']);
    releases.shift()?.();
    await tick();
    input.send('/exit\r');
    await done;
    expect(stripAnsi(output.text)).toContain('TUI theme changed to solarized-light.');
  });
});
