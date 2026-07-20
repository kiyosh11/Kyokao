import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  filterWorkspaceCommands,
  parseWorkspaceCommand,
  selectPalette,
  terminalWorkspace,
  visiblePaletteCommands,
  type WorkspaceEmit,
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
    input.send('\n');
    await tick();
    input.send('\n');
    await tick();
    input.send('write it');
    input.send('\n');
    await tick();
    input.send('/exit\n');
    await done;
    expect(commands).toEqual(['help', 'exit']);
    expect(output.text).toContain('write_file: completed');
    expect(output.text).toContain('done');
    expect(input.isRaw).toBe(false);
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
    input.send('/doctor\n');
    await tick();
    input.send('/model another\n');
    input.send('\u0003');
    expect(commands).toEqual(['doctor']);
    expect(output.text).toContain('Command is running and cannot be cancelled.');
    release();
    await tick();
    input.send('/exit\n');
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
    input.send('approve\n');
    await tick();
    input.send('\u001b');
    await tick();
    expect(decisions).toEqual([false]);
    expect(output.text).toContain('Approval denied.');
    input.send('approve\n');
    await tick();
    input.emit('close');
    await done;
    await tick();
    expect(decisions).toEqual([false, false]);
  });
});
