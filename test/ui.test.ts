import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  AUTOWRAP_DISABLE,
  AUTOWRAP_ENABLE,
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  CURSOR_SHOW,
  ENHANCED_KEYBOARD_DISABLE,
  ENHANCED_KEYBOARD_ENABLE,
  MODIFY_OTHER_KEYS_DISABLE,
  MODIFY_OTHER_KEYS_ENABLE,
  MOUSE_TRACKING_DISABLE,
  MOUSE_TRACKING_ENABLE,
  EditorState,
  createThemeContext,
  displayWidth,
  filterWorkspaceCommands,
  layoutEditor,
  parseWorkspaceCommand,
  renderWorkspaceScreen,
  renderWorkspaceFooter,
  selectPalette,
  terminalWorkspace,
  TerminalInputParser,
  visiblePaletteCommands,
  withInteractiveScreen,
  type WorkspaceEmit,
  renderSetupScreen,
  setupSelect,
  setupWizard,
  validateBaseURL,
  visibleSetupItems,
  workspaceCommands,
} from '@kyokao/ui';
class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readableEncoding = 'utf8';
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
  setEncoding(value: BufferEncoding) {
    this.readableEncoding = value;
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
  columns = 88;
  rows = 28;
  text = '';
  write(value: string) {
    this.text += value;
    return true;
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const plain = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
const count = (value: string, needle: string) => value.split(needle).length - 1;
describe('terminal workspace helpers', () => {
  it('parses commands, filters the palette, and clamps selection', () => {
    expect(parseWorkspaceCommand('/model gpt-4o-mini')).toEqual({
      name: 'model',
      args: ['gpt-4o-mini'],
      raw: '/model gpt-4o-mini',
    });
    expect(parseWorkspaceCommand('hello')).toBeUndefined();
    expect(parseWorkspaceCommand('/wat')?.name).toBeUndefined();
    expect(filterWorkspaceCommands('/pro').map((entry) => entry.name)).toContain('provider');
    expect(parseWorkspaceCommand('/resume')?.name).toBe('resume');
    expect(parseWorkspaceCommand('/permissions full-auto')?.name).toBe('permissions');
    expect(filterWorkspaceCommands('/sta').map((entry) => entry.name)).toContain('status');
    const officialCommands = [
      'model',
      'permissions',
      'experimental',
      'review',
      'rename',
      'new',
      'archive',
      'delete',
      'resume',
      'fork',
      'init',
      'compact',
      'plan',
      'goal',
      'agent',
      'copy',
      'raw',
      'diff',
      'mention',
      'status',
      'usage',
      'debug-config',
      'mcp',
      'apps',
      'plugins',
      'logout',
      'quit',
      'exit',
      'feedback',
      'rollout',
      'ps',
      'stop',
      'clear',
      'personality',
      'test-approval',
      'subagents',
      'settings',
    ];
    const registered = workspaceCommands.map((entry) => entry.name);
    expect(registered).toEqual(expect.arrayContaining(officialCommands));
    expect(new Set(registered).size).toBe(registered.length);
    expect(parseWorkspaceCommand('/theme')?.name).toBeUndefined();
    expect(filterWorkspaceCommands('/sett').map((entry) => entry.name)).toEqual(['settings']);
    expect(selectPalette(0, -1, 3)).toBe(0);
    expect(selectPalette(2, 1, 3)).toBe(2);
    const commands = filterWorkspaceCommands('/');
    const window = visiblePaletteCommands(commands, 8);
    expect(window.commands).toContain(commands[8]);
    expect(window.start).toBeGreaterThan(0);
  });
  it('renders startup, palette help, streaming tool activity, and clean exit', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const commands: string[] = [];
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({
        workspace: '~/project',
        provider: 'fake',
        model: 'fake-model',
        approval: 'auto-edit',
      }),
      async onPrompt(prompt: string, emit: WorkspaceEmit) {
        expect(prompt).toBe('write it');
        emit('reasoning', 'Checking the request.');
        emit('tool', 'write_file {"path":"answer.txt"}');
        emit('tool', 'write_file: completed\nWrote answer.txt');
        emit('assistant', 'done');
      },
      async onCommand(command) {
        commands.push(command.name ?? 'unknown');
        if (command.name === 'help') return { messages: [{ text: 'help shown' }] };
        if (command.name === 'exit') return { close: true };
      },
    });
    input.send('/he');
    input.send('\r');
    await tick();
    input.send('\r');
    await tick();
    input.send('write it');
    input.send('\r');
    await tick();
    input.send('/exit\r');
    await done;
    expect(commands).toEqual(['help', 'exit']);
    expect(output.text).toContain('write_file');
    expect(output.text).toContain('Checking the request.');
    expect(output.text).toContain('Thinking');
    expect(output.text).toContain('Wrote answer.txt');
    expect(output.text).toContain('done');
    expect(output.text).not.toContain('Ready. Type a task');
    expect(input.isRaw).toBe(false);
    expect(count(output.text, ALT_SCREEN_ENTER)).toBe(1);
    expect(count(output.text, ALT_SCREEN_LEAVE)).toBe(1);
  });
  it('keeps reasoning out of the rendered transcript when thinking is disabled', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      showThinking: () => false,
      header: () => ({
        workspace: '~/project',
        provider: 'nvidia',
        model: 'openai/gpt-oss-120b',
        approval: 'auto-edit',
      }),
      async onPrompt(_prompt: string, emit: WorkspaceEmit) {
        emit('reasoning', 'Hidden model thinking.');
        emit('assistant', 'Visible final answer.');
      },
      async onCommand(command) {
        if (command.name === 'exit') return { close: true };
      },
    });
    input.send('answer this\r');
    await tick();
    input.send('/exit\r');
    await done;
    expect(output.text).not.toContain('Hidden model thinking.');
    expect(output.text).not.toContain('◆ Thinking');
    expect(output.text).toContain('Visible final answer.');
  });
  it('navigates a provider palette and masked credential input with arrows and Enter', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const commands: string[] = [];
    const secrets: Array<string | undefined> = [];
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      themeContext: createThemeContext({
        tuiTheme: 'kyokao-dark',
        codeTheme: 'kyokao',
        colorLevel: 0,
      }),
      commandPalette(value) {
        if (!/^\/provider(?:\s|$)/.test(value)) return undefined;
        const query = value.replace(/^\/provider\s*/, '');
        return ['openai', 'custom']
          .filter((name) => name.startsWith(query))
          .map((name) => ({
            name: 'provider',
            syntax: `/provider ${name}`,
            label: name,
            description: name === 'openai' ? 'active · built-in' : 'configured',
            completion: `/provider ${name}`,
            submit: true,
          }));
      },
      header: () => ({
        workspace: '~',
        provider: 'fake',
        model: 'fake',
        approval: 'suggest',
      }),
      async onPrompt() {},
      async onCommand(command, _emit, control) {
        commands.push(command.raw);
        if (command.name === 'exit') return { close: true };
        if (command.name === 'provider') {
          secrets.push(await control.promptSecret(`API token for ${command.args[0]}`));
          return { messages: [{ text: 'provider selected' }] };
        }
        return { messages: [{ text: `selected ${command.raw}` }] };
      },
    });
    input.send('/provider');
    await tick();
    const providerFrame = plain(output.text.split('\x1b[H\x1b[2J').at(-1)!);
    expect(providerFrame).toContain('Providers');
    expect(providerFrame).not.toContain('/provider custom');
    input.send('\x1b[B\r');
    await tick();
    expect(commands).toContain('/provider custom');
    expect(plain(output.text.split('\x1b[H\x1b[2J').at(-1)!)).toContain('API token for custom');
    input.send('secret-token');
    await tick();
    expect(output.text).not.toContain('secret-token');
    expect(plain(output.text.split('\x1b[H\x1b[2J').at(-1)!)).toContain('••••');
    input.send('\r');
    await tick();
    expect(secrets).toEqual(['secret-token']);
    expect(output.text).not.toContain('secret-token');
    input.send('/provider custom\r');
    await tick();
    input.send('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(secrets).toEqual(['secret-token', undefined]);
    input.send('/exit\r');
    await done;
  });
  it('cancels active requests with Escape or Ctrl-C and exits on Ctrl-C while idle', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let aborts = 0;
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      onPrompt: async (_prompt, _emit, signal) =>
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborts++;
            resolve();
          });
        }),
      async onCommand(command) {
        return command.name === 'exit' ? { close: true } : undefined;
      },
    });
    input.send('wait');
    input.send('\r');
    await tick();
    input.send('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 35));
    await tick();
    expect(aborts).toBe(1);
    input.send('wait again\r');
    await tick();
    input.send('\u0003');
    await tick();
    expect(aborts).toBe(2);
    input.send('\u0003');
    await done;
    expect(count(output.text, ALT_SCREEN_ENTER)).toBe(1);
    expect(count(output.text, ALT_SCREEN_LEAVE)).toBe(1);
    const notTty = new FakeInput();
    notTty.isTTY = false;
    await expect(
      terminalWorkspace({
        input: notTty as never,
        output: output as never,
        header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
        onPrompt: async () => {},
        onCommand: async () => undefined,
      }),
    ).rejects.toThrow('TTY');
  });
  it('edits while active, queues with Tab, and replaces in the same session order', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 110;
    output.rows = 60;
    const prompts: string[] = [];
    const releases = new Map<string, () => void>();
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt(prompt, emit, signal) {
        prompts.push(prompt);
        emit('assistant', `started ${prompt}`);
        await new Promise<void>((resolve) => {
          releases.set(prompt, resolve);
          signal.addEventListener(
            'abort',
            () => {
              emit('assistant', `\ntrailing ${prompt}`);
              resolve();
            },
            { once: true },
          );
        });
      },
      async onCommand(command) {
        return command.name === 'exit' ? { close: true } : undefined;
      },
    });
    input.send('first\r');
    await tick();
    input.send('queued\t');
    await tick();
    expect(plain(output.text)).toContain('queue · 1');
    expect(plain(output.text)).toMatch(/queue/i);
    const queuedFrame = plain(output.text.split('\x1b[H\x1b[2J').at(-1)!);
    expect(queuedFrame.split('\n').some((line) => /^\s*│\s*You\s*│/.test(line))).toBe(false);
    expect(queuedFrame.split('\n').some((line) => /^\s*│\s*Kyokao\s*│/.test(line))).toBe(false);
    expect(queuedFrame).toContain('started first');
    expect(queuedFrame).not.toContain('started queued');
    input.send('replacement\r');
    await tick();
    expect(prompts).toEqual(['first', 'replacement']);
    expect(plain(output.text)).toContain('Stopping');
    releases.get('replacement')!();
    await tick();
    expect(prompts).toEqual(['first', 'replacement', 'queued']);
    releases.get('queued')!();
    await tick();
    input.send('line one\x1b[13;2uline two\r');
    await tick();
    expect(prompts.at(-1)).toBe('line one\nline two');
    releases.get('line one\nline two')!();
    await tick();
    input.send('/exit\r');
    await done;
    const finalFrame = plain(output.text.split('\x1b[H\x1b[2J').at(-1)!);
    const ordered = [
      'first',
      'started first',
      'trailing first',
      'Request cancelled.',
      'replacement',
      'started replacement',
      'queued',
      'started queued',
    ].map((value) => finalFrame.indexOf(value));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(finalFrame.lastIndexOf('trailing first')).toBeLessThan(finalFrame.indexOf('queued'));
    expect(input.isRaw).toBe(false);
  }, 10_000);
  it('serializes commands and keeps a selected palette row visible after five entries', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const commands: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      onPrompt: async () => {},
      async onCommand(command) {
        commands.push(command.name ?? 'unknown');
        if (command.name === 'doctor') await gate;
        return command.name === 'exit' ? { close: true } : undefined;
      },
    });
    input.send('/');
    for (let i = 0; i < 8; i++) input.send('\u001b[B');
    expect(plain(output.text)).toContain(`› /${filterWorkspaceCommands('/')[8]!.name}`);
    input.send('\u001b');
    input.send('/doctor\r');
    await tick();
    input.send('/model another\r');
    input.send('\u0003');
    expect(commands).toEqual(['doctor']);
    expect(output.text).toContain('Command is running and cannot be cancelled.');
    release();
    await tick();
    input.send('/exit\r');
    await done;
  });
  it('denies pending approval on escape and terminal close', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const decisions: boolean[] = [];
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt(_prompt, _emit, _signal, approve) {
        decisions.push(await approve('write_file', 'answer.txt'));
      },
      async onCommand(command) {
        return command.name === 'exit' ? { close: true } : undefined;
      },
    });
    input.send('approve\r');
    await tick();
    input.send('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(decisions).toEqual([false]);
    expect(output.text).toContain('Approval denied.');
    input.send('approve\r');
    await tick();
    input.send('y');
    await tick();
    expect(decisions).toEqual([false, true]);
    input.send('approve\r');
    await tick();
    input.emit('close');
    await done;
    await tick();
    expect(decisions).toEqual([false, true, false]);
  });
});
describe('interactive screen lifecycle and editor', () => {
  it('balances alternate screen, paste mode, cursor, raw mode, and exceptions exactly once', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    await expect(
      withInteractiveScreen({ input: input as never, output: output as never }, async (screen) => {
        screen.enter();
        screen.draw({ lines: ['frame'], cursor: { row: 0, column: 2 } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(count(output.text, ALT_SCREEN_ENTER)).toBe(1);
    expect(count(output.text, ALT_SCREEN_LEAVE)).toBe(1);
    expect(count(output.text, BRACKETED_PASTE_ENABLE)).toBe(1);
    expect(count(output.text, BRACKETED_PASTE_DISABLE)).toBe(1);
    expect(count(output.text, MOUSE_TRACKING_ENABLE)).toBe(1);
    expect(count(output.text, MOUSE_TRACKING_DISABLE)).toBe(1);
    expect(count(output.text, ENHANCED_KEYBOARD_ENABLE)).toBe(1);
    expect(count(output.text, ENHANCED_KEYBOARD_DISABLE)).toBe(1);
    expect(count(output.text, MODIFY_OTHER_KEYS_ENABLE)).toBe(1);
    expect(count(output.text, MODIFY_OTHER_KEYS_DISABLE)).toBe(1);
    expect(count(output.text, AUTOWRAP_DISABLE)).toBe(1);
    expect(count(output.text, AUTOWRAP_ENABLE)).toBeGreaterThanOrEqual(2);
    expect(output.text).toContain(`${AUTOWRAP_DISABLE}\x1b[H\x1b[2Jframe\r\n`);
    expect(MODIFY_OTHER_KEYS_ENABLE).toBe('\x1b[>4;2m');
    expect(MODIFY_OTHER_KEYS_DISABLE).toBe('\x1b[>4;0m');
    expect(output.text).toContain(`${ENHANCED_KEYBOARD_ENABLE}${MODIFY_OTHER_KEYS_ENABLE}`);
    expect(output.text).toContain(`${MODIFY_OTHER_KEYS_DISABLE}${ENHANCED_KEYBOARD_DISABLE}`);
    expect(output.text.indexOf(ENHANCED_KEYBOARD_ENABLE)).toBeLessThan(
      output.text.indexOf(MODIFY_OTHER_KEYS_ENABLE),
    );
    expect(output.text.indexOf(MODIFY_OTHER_KEYS_DISABLE)).toBeLessThan(
      output.text.indexOf(ENHANCED_KEYBOARD_DISABLE),
    );
    expect(output.text.endsWith(ALT_SCREEN_LEAVE)).toBe(true);
    expect(input.isRaw).toBe(false);
  });
  it('clears the full terminal canvas using the frame background before drawing', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const background = '\x1b[48;2;20;20;20m';
    await withInteractiveScreen(
      { input: input as never, output: output as never },
      async (screen) => screen.draw({ lines: ['frame'], background }),
    );
    expect(output.text).toContain(`${AUTOWRAP_DISABLE}${background}\x1b[H\x1b[2J\x1b[0mframe`);
  });
  it('uses a clearing fallback and emits nothing when interactive startup is rejected', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    await withInteractiveScreen(
      { input: input as never, output: output as never, alternate: false },
      async (screen) => screen.draw({ lines: ['temporary'] }),
    );
    expect(output.text).not.toContain(ALT_SCREEN_ENTER);
    expect(output.text).not.toContain(ALT_SCREEN_LEAVE);
    expect(output.text.endsWith('\x1b[H\x1b[2J')).toBe(true);
    const nonTtyInput = new FakeInput();
    const nonTtyOutput = new FakeOutput();
    nonTtyInput.isTTY = false;
    await expect(
      withInteractiveScreen(
        { input: nonTtyInput as never, output: nonTtyOutput as never },
        async () => undefined,
      ),
    ).rejects.toThrow('TTY');
    expect(nonTtyOutput.text).toBe('');
  });
  it('edits graphemes, words, lines, and multiline cursor positions', () => {
    const editor = new EditorState('one 👩‍💻 two\nsecond');
    editor.cursor = 5;
    editor.backspace();
    expect(editor.text.includes('second')).toBe(true);
    editor.delete();
    expect(editor.text.split('\n').at(-1)).toBe('second');
    editor.set('one\ntwo', 1);
    editor.vertical(1);
    expect(editor.cursor).toBe(5);
    editor.home();
    editor.insert('X');
    editor.end();
    editor.insert('!');
    expect(editor.text).toBe('one\nXtwo!');
    editor.set('alpha beta');
    editor.wordLeft();
    editor.deleteWordBefore();
    expect(editor.text).toBe('beta');
    editor.set('alpha beta');
    editor.start();
    editor.wordRight();
    editor.killAfter();
    expect(editor.text).toBe('alpha ');
    editor.set('alpha beta', 6);
    editor.killBefore();
    expect(editor.text).toBe('beta');
  });
  it('parses split escapes, multiple keys, and bracketed multiline paste literally', () => {
    const parser = new TerminalInputParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.feed('[D\x1b[C')).toEqual([
      { type: 'key', key: 'left' },
      { type: 'key', key: 'right' },
    ]);
    expect(parser.feed('\x1b[20')).toEqual([]);
    expect(parser.feed('0~line 1\n/exit')).toEqual([]);
    expect(parser.feed('\nline 3\x1b[20')).toEqual([]);
    expect(parser.feed('1~')).toEqual([{ type: 'paste', text: 'line 1\n/exit\nline 3' }]);
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.flushEscape()).toEqual([{ type: 'key', key: 'escape' }]);
    expect(parser.feed('\x1b[3~\x1b[H\x1b[F\x01\x05\x15\x0b\x17\x1bb\x1bf')).toEqual([
      { type: 'key', key: 'delete' },
      { type: 'key', key: 'home' },
      { type: 'key', key: 'end' },
      { type: 'key', key: 'ctrl-a' },
      { type: 'key', key: 'ctrl-e' },
      { type: 'key', key: 'ctrl-u' },
      { type: 'key', key: 'ctrl-k' },
      { type: 'key', key: 'ctrl-w' },
      { type: 'key', key: 'alt-left' },
      { type: 'key', key: 'alt-right' },
    ]);
  });
  it('parses SGR mouse-wheel input for transcript scrolling', () => {
    const parser = new TerminalInputParser();
    expect(parser.feed('\x1b[<64;40;12M\x1b[<65;40;12M')).toEqual([
      { type: 'key', key: 'scroll-up' },
      { type: 'key', key: 'scroll-down' },
    ]);
    expect(parser.feed('\x1b[<6')).toEqual([]);
    expect(parser.feed('4;20;8M')).toEqual([{ type: 'key', key: 'scroll-up' }]);
  });
  it('distinguishes Shift/Ctrl/Alt Enter encodings and keeps paste literal', () => {
    const parser = new TerminalInputParser();
    expect(parser.feed('\x1b[13;2u\x1b[27;2;13~\x1b\r\x1b[13;5u\x1b[27;5;13~\n')).toEqual([
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'queue' },
      { type: 'key', key: 'queue' },
      { type: 'key', key: 'newline' },
    ]);
    expect(parser.feed('\x1b[200~a\nb\x1b[13;5u\x1b[201~')).toEqual([
      { type: 'paste', text: 'a\nb\x1b[13;5u' },
    ]);
  });
  it('parses control bindings while enhanced keyboard reporting is enabled', () => {
    const parser = new TerminalInputParser();
    expect(
      parser.feed(
        '\x1b[27;5;97~\x1b[27;5;99~\x1b[27;5;101~\x1b[27;5;106~\x1b[27;5;107~\x1b[27;5;117~\x1b[27;5;119~',
      ),
    ).toEqual([
      { type: 'key', key: 'ctrl-a' },
      { type: 'key', key: 'interrupt' },
      { type: 'key', key: 'ctrl-e' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'ctrl-k' },
      { type: 'key', key: 'ctrl-u' },
      { type: 'key', key: 'ctrl-w' },
    ]);
    expect(
      parser.feed('\x1b[97;5u\x1b[99;5u\x1b[101;5u\x1b[106;5u\x1b[107;5u\x1b[117;5u\x1b[119;5u'),
    ).toEqual([
      { type: 'key', key: 'ctrl-a' },
      { type: 'key', key: 'interrupt' },
      { type: 'key', key: 'ctrl-e' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'ctrl-k' },
      { type: 'key', key: 'ctrl-u' },
      { type: 'key', key: 'ctrl-w' },
    ]);
  });
  it('parses the Codex-compatible global and Emacs editing controls', () => {
    const parser = new TerminalInputParser();
    expect(
      parser.feed(
        '\x02\x04\x06\x07\x08\x0a\x0c\x0e\x0f\x10\x12\x13\x14\x19\x1bd\x1b[1;5D\x1b[1;5C',
      ),
    ).toEqual([
      { type: 'key', key: 'ctrl-b' },
      { type: 'key', key: 'ctrl-d' },
      { type: 'key', key: 'ctrl-f' },
      { type: 'key', key: 'ctrl-g' },
      { type: 'key', key: 'ctrl-h' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'ctrl-l' },
      { type: 'key', key: 'ctrl-n' },
      { type: 'key', key: 'ctrl-o' },
      { type: 'key', key: 'ctrl-p' },
      { type: 'key', key: 'ctrl-r' },
      { type: 'key', key: 'ctrl-s' },
      { type: 'key', key: 'ctrl-t' },
      { type: 'key', key: 'ctrl-y' },
      { type: 'key', key: 'alt-delete' },
      { type: 'key', key: 'alt-left' },
      { type: 'key', key: 'alt-right' },
    ]);
  });
  it('anchors a bordered composer at the bottom and positions wrapped input cursor', () => {
    const editor = new EditorState('alpha beta gamma delta');
    editor.left();
    const frame = renderWorkspaceScreen({
      width: 80,
      height: 16,
      header: { workspace: '~', provider: 'wide-provider', model: 'model', approval: 'suggest' },
      transcript: [],
      editor,
    });
    expect(frame.lines).toHaveLength(16);
    expect(frame.lines.some((line) => line.includes('╰'))).toBe(true);
    expect(frame.lines.some((line) => line.includes('Prompt'))).toBe(false);
    expect(frame.lines.some((line) => line.includes('alpha'))).toBe(true);
    expect(frame.lines.some((line) => line.includes('❯'))).toBe(true);
    expect(frame.cursor?.row).toBeGreaterThan(10);
    expect(frame.lines.every((line) => plain(line).length <= 80)).toBe(true);
    const boxed = frame.lines.map((line) => plain(line));
    expect(boxed[0]).toContain('kyokao');
    expect(boxed[0]!.trimStart()).toMatch(/^╭.*╮$/);
    expect(boxed.at(-1)!.trimStart()).toMatch(/^╰.*╯$/);
    expect(
      boxed
        .slice(1, -1)
        .every((line) => line.trimStart().startsWith('│') && line.trimEnd().endsWith('│')),
    ).toBe(true);
    const layout = layoutEditor('1234567890🙂x', 11, 8);
    expect(layout.rows.length).toBeGreaterThan(1);
    expect(layout.cursor.row).toBeGreaterThan(0);
    const short = renderWorkspaceScreen({
      width: 20,
      height: 8,
      header: { workspace: '~', provider: 'p', model: 'm', approval: 'suggest' },
      transcript: [],
      editor: new EditorState('x'),
    });
    expect(short.lines).toHaveLength(8);
    expect(short.cursor?.row).toBeLessThan(8);
    expect(short.lines.some((line) => line.includes('╰'))).toBe(true);
  });
  it('keeps the reference shortcut legend stable with or without usage', () => {
    const usage = { totalTokens: 904, estimatedCostUsd: 0.001 };
    const wide = renderWorkspaceFooter(130, usage);
    expect(displayWidth(wide)).toBe(130);
    expect(wide).toContain('Esc:interrupt');
    expect(wide).toContain('Ctrl+T:transcript');
    expect(wide).toContain('?:shortcuts');
    expect(wide).toContain('Ctrl+C:quit');
    expect(renderWorkspaceFooter(130, usage, true)).toContain('Ctrl+C:cancel');
    expect(wide).not.toContain('$0.0010');
    const narrow = renderWorkspaceFooter(54, usage);
    expect(displayWidth(narrow)).toBe(54);
    expect(narrow).toContain('Esc:interrupt');
    expect(narrow).toContain('Ctrl+T');
  });
  it('anchors context usage at the far-right edge of the footer', () => {
    const footer = renderWorkspaceFooter(100, {
      totalTokens: 0,
      estimatedCostUsd: 0,
      contextTokens: 0,
      contextWindow: 16_000,
    });
    expect(footer).toContain('Esc:interrupt  │  Ctrl+T:transcript  │  ?:shortcuts  │  Ctrl+C:quit');
    expect(footer.endsWith('0 / 16K  ')).toBe(true);
    expect(displayWidth(footer)).toBe(100);
  });
  it('marks model capacity unknown instead of inventing the configured default', () => {
    const footer = renderWorkspaceFooter(100, {
      totalTokens: 0,
      estimatedCostUsd: 0,
      contextTokens: 66,
    });
    expect(footer).toContain('66 / ?');
    expect(footer.endsWith('66 / ?  ')).toBe(true);
  });
  it('formats Capy million-token model capacities without a fake 16K limit', () => {
    const footer = renderWorkspaceFooter(100, {
      totalTokens: 0,
      estimatedCostUsd: 0,
      contextTokens: 66,
      contextWindow: 1_000_000,
    });
    expect(footer.endsWith('66 / 1M  ')).toBe(true);
  });
  it('formats reference-scale context and live token counts without losing zeroes', () => {
    const frame = renderWorkspaceScreen({
      width: 100,
      height: 16,
      header: {
        workspace: '~/Documents',
        provider: 'capy',
        model: 'grok-4-5',
        approval: 'always-approve',
      },
      transcript: [],
      editor: new EditorState(''),
      busy: true,
      busyKind: 'prompt',
      activityStartedAt: Date.now() - 15_000,
      usage: {
        totalTokens: 9_450,
        estimatedCostUsd: 0,
        contextTokens: 9_500,
        contextWindow: 500_000,
      },
    });
    const screen = frame.lines.map(plain).join('\n');
    expect(screen).toContain('9.5K / 500K');
    expect(screen).toMatch(/1[45]s ⇣9\.45k \[stop\]/);
    expect(screen).toMatch(/Responding… 1[45]s/);
  });
  it('keeps the live 111-column workspace inset without wrapping or duplicate status', () => {
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
    const rows = frame.lines.map(plain);
    const workspace = rows.join('\n');
    expect(rows).toHaveLength(30);
    expect(frame.lines.every((line) => displayWidth(line) === 111)).toBe(true);
    expect(rows[1]).not.toContain('0 / 128K');
    expect(rows.find((line) => line.includes('Esc:interrupt'))).toMatch(/0 \/ 128K\s*│$/);
    expect(rows.find((line) => line.includes('❯ hey'))).not.toContain('2:24');
    expect(workspace.match(/Responding/g)).toHaveLength(1);
    expect(workspace).not.toContain('◆ Thinking');
    expect(workspace).toContain('openai/gpt-oss-120b · full-auto');
  });
  it('keeps usage updates out of the transcript', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt(_prompt, emit) {
        emit('assistant', 'complete');
        emit('usage', { totalTokens: 904, estimatedCostUsd: 0 });
      },
      async onCommand(command) {
        return command.name === 'exit' ? { close: true } : undefined;
      },
    });
    input.send('work\r');
    await tick();
    input.send('/exit\r');
    await done;
    expect(plain(output.text)).toContain('904');
    expect(plain(output.text)).not.toContain('Status');
  });
  it('supports editor bindings, history draft restoration, literal paste, and tab completion', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const prompts: string[] = [];
    const commands: string[] = [];
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt(prompt) {
        prompts.push(prompt);
      },
      async onCommand(command) {
        commands.push(command.name ?? 'unknown');
        return command.name === 'exit' ? { close: true } : undefined;
      },
    });
    input.send('abcd\x1b[D\x1b[D\x1b[3~\x7f\x01X\x05Z\r');
    await tick();
    input.send('second\r');
    await tick();
    input.send('draft\x1b[A\x1b[B\r');
    await tick();
    input.send('\x1b[200~line 1\n/exit\nline 3\x1b[201~');
    await tick();
    expect(commands).toEqual([]);
    input.send('\r');
    await tick();
    input.send('/he\t\r');
    await tick();
    input.send('history draft\x1b[A\x1b[B\r');
    await tick();
    input.send('/exit\r');
    await done;
    expect(prompts).toEqual(['XadZ', 'second', 'draft', 'line 1\n/exit\nline 3', 'history draft']);
    expect(commands).toEqual(['help', 'exit']);
    expect(output.text).toContain(CURSOR_SHOW);
  });
  it('opens Codex-style transcript and shortcut views and supports editor/copy/clear controls', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const prompts: string[] = [];
    const commands: string[] = [];
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt(prompt) {
        prompts.push(prompt);
      },
      async onCommand(command) {
        commands.push(command.name ?? 'unknown');
        return command.name === 'quit' ? { close: true } : undefined;
      },
      async openExternalEditor(draft) {
        return `${draft} edited`.trim();
      },
    });
    input.send('draft\x07');
    await tick();
    input.send('\r');
    await tick();
    expect(prompts).toEqual(['draft edited']);

    input.send('\x14');
    expect(plain(output.text.split('\x1b[2J').at(-1)!)).toContain('Ctrl+T close');
    input.send('\x14');
    input.send('?');
    expect(plain(output.text.split('\x1b[2J').at(-1)!)).toContain('keyboard shortcuts');
    input.send('?');

    input.send('\x0f');
    await tick();
    expect(commands).toContain('copy');
    input.send('\x0c');
    expect(plain(output.text.split('\x1b[2J').at(-1)!)).not.toContain('draft edited');
    input.send('/quit\r');
    await done;
    expect(commands).toContain('quit');
  });
  it('opens a preloaded remote-history picker on the first frame', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      initialDraft: '/resume ',
      header: () => ({ workspace: '~', provider: 'capy', model: 'fake', approval: 'suggest' }),
      commandPalette: (value) =>
        value === '/resume '
          ? [
              {
                name: 'resume',
                group: 'session',
                syntax: '/resume capy:thread-1',
                label: 'Remote Capy conversation',
                description: 'Capy ready',
                completion: '/resume capy:thread-1',
                submit: true,
              },
            ]
          : undefined,
      async onPrompt() {},
      async onCommand() {},
    });

    const frame = plain(output.text.split('\x1b[2J').at(-1)!);
    expect(frame).toContain('Remote Capy conversation');
    expect(frame).toContain('/resume ');
    input.send('\x03');
    await done;
  });
  it('scrolls the live transcript with the mouse wheel', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt() {},
      async onCommand(command) {
        if (command.name === 'help')
          return {
            messages: [
              {
                text: Array.from({ length: 50 }, (_, index) => `history line ${index + 1}`).join(
                  '\n',
                ),
              },
            ],
          };
        return command.name === 'quit' ? { close: true } : undefined;
      },
    });
    input.send('/help\r');
    await tick();
    const before = plain(output.text.split('\x1b[2J').at(-1)!);
    expect(before).toContain('history line 50');
    input.send('\x1b[<64;40;12M');
    const scrolled = plain(output.text.split('\x1b[2J').at(-1)!);
    expect(scrolled).toContain('history line 30');
    expect(scrolled).not.toContain('history line 50');
    input.send('\x1b[<65;40;12M');
    expect(plain(output.text.split('\x1b[2J').at(-1)!)).toContain('history line 50');
    input.send('/quit\r');
    await done;
  });
  it('cleans stale palette rows and restores the screen on close and Ctrl-C', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt() {},
      async onCommand() {},
    });
    input.send('/');
    expect(plain(output.text.split('\x1b[2J').at(-1)!)).toContain('Commands');
    input.send('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(plain(output.text.split('\x1b[2J').at(-1)!)).not.toContain('Commands');
    output.columns = 30;
    output.rows = 14;
    output.emit('resize');
    const resized = plain(output.text.split('\x1b[2J').at(-1)!).replace(/\r/g, '');
    expect(resized).toMatch(/kyokao|suggest|fake/);
    expect(
      resized
        .split('\n')
        .slice(0, 14)
        .every((line) => line.length <= 30),
    ).toBe(true);
    output.emit('close');
    await done;
    expect(output.text.endsWith(ALT_SCREEN_LEAVE)).toBe(true);
    const interruptInput = new FakeInput();
    const interruptOutput = new FakeOutput();
    const interrupted = terminalWorkspace({
      input: interruptInput as never,
      output: interruptOutput as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      async onPrompt() {},
      async onCommand() {},
    });
    interruptInput.send('\x03');
    await interrupted;
    expect(interruptOutput.text.endsWith(ALT_SCREEN_LEAVE)).toBe(true);
  });
  it('shares one screen lifecycle across setup and workspace handoff', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const session = withInteractiveScreen(
      { input: input as never, output: output as never },
      async (screen) => {
        const setup = setupWizard({
          screen,
          configPath: '/tmp/config.json',
          providers: [{ name: 'ollama', description: 'Local', local: true }],
        });
        input.send('\r');
        await tick();
        input.send('model\r');
        await tick();
        input.send('\r');
        await tick();
        input.send('\r');
        expect(await setup).toMatchObject({ provider: 'ollama', model: 'model' });
        const workspace = terminalWorkspace({
          screen,
          header: () => ({
            workspace: '~',
            provider: 'ollama',
            model: 'model',
            approval: 'suggest',
          }),
          async onPrompt() {},
          async onCommand(command) {
            return command.name === 'exit' ? { close: true } : undefined;
          },
        });
        input.send('/exit\r');
        await workspace;
      },
    );
    await session;
    expect(count(output.text, ALT_SCREEN_ENTER)).toBe(1);
    expect(count(output.text, ALT_SCREEN_LEAVE)).toBe(1);
  });
});
describe('first-run setup helpers', () => {
  it('renders a narrow, masked setup screen and validates custom endpoints', () => {
    const screen = plain(
      renderSetupScreen({
        width: 28,
        step: 'key',
        title: 'API key',
        value: 'super-secret-key',
        secret: true,
      }),
    );
    expect(screen).toContain('kyokao');
    expect(screen).toContain('••••');
    expect(screen).not.toContain('super-secret-key');
    expect(validateBaseURL('not a url')).toContain('valid');
    expect(validateBaseURL('https://gateway.test/v1')).toBeUndefined();
    expect(setupSelect(0, -1, 2)).toBe(0);
  });
  it('navigates first-run setup with keys, preserves environment keys, and restores terminal', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = setupWizard({
      input: input as never,
      output: output as never,
      configPath: '/tmp/kyokao.json',
      providers: [
        { name: 'hosted', description: 'Hosted API', env: 'HOSTED_KEY' },
        {
          name: 'ollama',
          description: 'Local server',
          local: true,
          baseURL: 'http://localhost:11434/v1',
        },
      ],
      keySource: (provider) => (provider.name === 'hosted' ? 'environment' : 'not configured'),
    });
    input.send('\u001b');
    input.send('[B');
    input.send('\n');
    await tick();
    input.send('llama3.2');
    input.send('\n');
    await tick();
    input.send('\n');
    await tick();
    input.send('\n');
    const result = await done;
    expect(result).toMatchObject({ provider: 'ollama', model: 'llama3.2', approval: 'suggest' });
    expect(plain(output.text)).toContain('Key: not configured');
    expect(input.isRaw).toBe(false);
    expect(output.text).toContain('\x1b[?25h');
  });
  it('supports custom provider navigation, back, and cancellation', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = setupWizard({
      input: input as never,
      output: output as never,
      configPath: '/tmp/kyokao.json',
      providers: [{ name: '__custom__', description: 'Custom endpoint' }],
    });
    input.send('\n');
    input.send('acme\n');
    input.send('\u001b');
    input.send('acme\n');
    input.send('https://api.acme.test/v1\n');
    input.send('\u0003');
    await expect(done).resolves.toBeUndefined();
    expect(input.isRaw).toBe(false);
  });
  it('selects a Capy project, Captain model, and Build model without rendering credentials', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = setupWizard({
      input: input as never,
      output: output as never,
      configPath: '/tmp/kyokao.json',
      providers: [
        {
          name: 'capy',
          description: 'Remote agent',
          remote: true,
          env: 'CAPY_API_KEY',
          baseURL: 'https://capy.ai/api/v1',
        },
      ],
      keySource: () => 'environment',
      fetchModels: async () => ['captain-model'],
      fetchBuildModels: async () => ['captain-model', 'build-model'],
      fetchProjects: async () => [{ id: 'project-1', name: 'Project', description: 'owner/repo' }],
    });
    input.send('\r');
    await tick();
    input.send('\r');
    await tick();
    input.send('\r');
    await tick();
    input.send('\r');
    await tick();
    input.send('\r');
    await tick();
    input.send('\r');
    await tick();
    input.send('\r');
    await expect(done).resolves.toMatchObject({
      provider: 'capy',
      model: 'captain-model',
      buildModel: 'captain-model',
      projectId: 'project-1',
    });
    const setupText = plain(output.text);
    expect(setupText.indexOf('Choose a Capy project')).toBeLessThan(
      setupText.indexOf('Choose the Capy Captain model'),
    );
    expect(setupText.indexOf('Choose the Capy Captain model')).toBeLessThan(
      setupText.indexOf('Choose the Capy Build model'),
    );
    expect(setupText).toContain('remote connected repositories');
    expect(output.text).not.toContain('secret');
  });
  it('keeps Capy setup on the key step when API discovery fails', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const done = setupWizard({
      input: input as never,
      output: output as never,
      configPath: '/tmp/kyokao.json',
      providers: [
        {
          name: 'capy',
          description: 'Remote agent',
          remote: true,
          env: 'CAPY_API_KEY',
          baseURL: 'https://capy.ai/api/v1',
        },
      ],
      fetchProjects: async () => {
        throw new Error('Capy API rejected the key');
      },
      fetchModels: async () => [],
      fetchBuildModels: async () => [],
    });
    input.send('\r');
    await tick();
    input.send('bad-key\r');
    await tick();
    expect(plain(output.text)).toContain('Capy API rejected the key');
    expect(plain(output.text)).toContain('SETUP · KEY');
    input.send('\u0003');
    await expect(done).resolves.toBeUndefined();
  });
});
describe('setup wizard resilience', () => {
  it('keeps selected providers visible in a height-aware window', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      name: `provider-${i}`,
      description: '',
    }));
    expect(visibleSetupItems(items, 8, 24, 10).items).toContain(items[12]);
    const screen = plain(
      renderSetupScreen({
        width: 70,
        height: 24,
        step: 'provider',
        title: 'Choose',
        items,
        selected: 8,
      }),
    );
    expect(screen).toContain('› provider-8');
    expect(screen).toContain('↑ more');
    expect(screen).toContain('↓ more');
  });
  it('requires confirmation for explicit replacement and cleans up on close', async () => {
    const output = new FakeOutput();
    const input = new FakeInput();
    const cancelled = setupWizard({
      input: input as never,
      output: output as never,
      configPath: '/tmp/config.json',
      confirmReplace: true,
      providers: [{ name: 'ollama', description: 'Local', local: true }],
    });
    input.send('\n');
    await expect(cancelled).resolves.toBeUndefined();
    const closingInput = new FakeInput();
    const closing = setupWizard({
      input: closingInput as never,
      output: output as never,
      configPath: '/tmp/config.json',
      providers: [{ name: 'hosted', description: 'Hosted' }],
      fetchModels: async () => await new Promise<string[]>(() => {}),
    });
    closingInput.send('\n');
    await tick();
    closingInput.send('\n');
    await tick();
    closingInput.send('j');
    expect(plain(output.text)).toContain('Checking models');
    closingInput.emit('close');
    await expect(closing).resolves.toBeUndefined();
    expect(closingInput.isRaw).toBe(false);
  });
});
