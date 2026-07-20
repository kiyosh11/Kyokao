import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  CURSOR_SHOW,
  ENHANCED_KEYBOARD_DISABLE,
  ENHANCED_KEYBOARD_ENABLE,
  MODIFY_OTHER_KEYS_DISABLE,
  MODIFY_OTHER_KEYS_ENABLE,
  EditorState,
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
    expect(output.text).toContain('write_file: completed');
    expect(output.text).toContain('done');
    expect(output.text).not.toContain('Ready. Type a task');
    expect(input.isRaw).toBe(false);
    expect(count(output.text, ALT_SCREEN_ENTER)).toBe(1);
    expect(count(output.text, ALT_SCREEN_LEAVE)).toBe(1);
  });

  it('cancels an active request before exiting and rejects non-TTY startup', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let aborted = false;
    const done = terminalWorkspace({
      input: input as never,
      output: output as never,
      header: () => ({ workspace: '~', provider: 'fake', model: 'fake', approval: 'suggest' }),
      onPrompt: async (_prompt, _emit, signal) =>
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
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
    input.send('\u0003');
    await tick();
    expect(aborted).toBe(true);
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

  it('edits while active, queues with Ctrl-Enter, and replaces in the same session order', async () => {
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
    input.send('queued\n');
    await tick();
    expect(plain(output.text)).toContain('Queue 1');
    expect(plain(output.text)).toContain('Ctrl+Enter queue');
    const queuedFrame = plain(output.text.split('\x1b[H\x1b[2J').at(-1)!);
    expect(queuedFrame.split('\n').filter((line) => /\bYou\b/.test(line))).toHaveLength(1);
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
  });

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
    expect(count(output.text, ENHANCED_KEYBOARD_ENABLE)).toBe(1);
    expect(count(output.text, ENHANCED_KEYBOARD_DISABLE)).toBe(1);
    expect(count(output.text, MODIFY_OTHER_KEYS_ENABLE)).toBe(1);
    expect(count(output.text, MODIFY_OTHER_KEYS_DISABLE)).toBe(1);
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
    const editor = new EditorState('one 👩🏽‍💻 two\nsecond');
    editor.cursor = 5;
    editor.backspace();
    expect(editor.text).toBe('one  two\nsecond');
    editor.delete();
    expect(editor.text).toBe('one two\nsecond');

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

  it('distinguishes Shift/Ctrl/Alt Enter encodings and keeps paste literal', () => {
    const parser = new TerminalInputParser();
    expect(parser.feed('\x1b[13;2u\x1b[27;2;13~\x1b\r\x1b[13;5u\x1b[27;5;13~\n')).toEqual([
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'newline' },
      { type: 'key', key: 'queue' },
      { type: 'key', key: 'queue' },
      { type: 'key', key: 'queue' },
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
      { type: 'key', key: 'queue' },
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
      { type: 'key', key: 'queue' },
      { type: 'key', key: 'ctrl-k' },
      { type: 'key', key: 'ctrl-u' },
      { type: 'key', key: 'ctrl-w' },
    ]);
  });

  it('anchors a bordered composer at the bottom and positions wrapped input cursor', () => {
    const editor = new EditorState('alpha βeta gamma delta');
    editor.left();
    const frame = renderWorkspaceScreen({
      width: 30,
      height: 16,
      header: { workspace: '~', provider: 'wide-provider', model: '模型', approval: 'suggest' },
      transcript: [],
      editor,
    });
    expect(frame.lines).toHaveLength(16);
    expect(frame.lines.at(-2)).toContain('╰');
    const readyBorder = frame.lines.find((line) => line.includes('Ready'));
    expect(readyBorder).toContain('├ Ready ');
    expect(frame.lines.filter((line) => line.includes('Ready'))).toHaveLength(1);
    expect(frame.lines.some((line) => line.includes('Prompt'))).toBe(false);
    expect(frame.lines[frame.lines.indexOf(readyBorder!) + 1]).toContain('› alpha');
    expect(frame.cursor?.row).toBeGreaterThan(10);
    expect(frame.lines.every((line) => plain(line).length <= 30)).toBe(true);

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
    expect(short.lines.at(-1)).toContain('╰');
  });

  it('right-aligns footer usage and hides it before it can overlap the shortcut hint', () => {
    const usage = { totalTokens: 904, estimatedCostUsd: 0 };
    const wide = renderWorkspaceFooter(130, usage);
    expect(displayWidth(wide)).toBe(130);
    expect(wide.startsWith('Enter submit · Shift/Alt newline · Ctrl+Enter queue')).toBe(true);
    expect(wide.endsWith('904 tokens · $0.0000 estimated')).toBe(true);

    const narrow = renderWorkspaceFooter(54, usage);
    expect(displayWidth(narrow)).toBe(54);
    expect(narrow).not.toContain('904 tokens');
    expect(narrow).toContain('Enter submit');
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
    expect(plain(output.text)).toContain('904 tokens · $0.0000 estimated');
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
    const resized = plain(output.text.split('\x1b[2J').at(-1)!);
    expect(resized).toContain('Ready');
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
    expect(screen).toContain('KYOKAO');
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

  it('selects a discovered Capy model and remote project without rendering credentials', async () => {
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
    await expect(done).resolves.toMatchObject({
      provider: 'capy',
      model: 'captain-model',
      projectId: 'project-1',
    });
    expect(plain(output.text)).toContain('remote connected repositories');
    expect(output.text).not.toContain('secret');
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
