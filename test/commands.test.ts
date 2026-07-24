import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Command } from '../packages/cli/node_modules/commander/esm.mjs';
import { defaults, readConfig } from '@kyokao/config';
import { registerCommands } from '../packages/cli/src/commands.js';
import { LocalStore } from '@kyokao/memory';
import { compressMessages, estimateTokens } from '@kyokao/agent';
import type { ChatMessage } from '@kyokao/providers';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('slash-command backing logic (0.8.0)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kyokao-cmd-'));
    process.env.KYOKAO_HOME = home;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.KYOKAO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  describe('top-level command resource and persistence behavior', () => {
    function commandProgram(runtime: () => Promise<any>) {
      const program = new Command().name('kyokao').exitOverride();
      registerCommands({
        program,
        runtime,
        ask: vi.fn(),
        tui: vi.fn(),
        setupProvider: vi.fn(async () => true),
        cliConfig: () => ({}),
        opts: () => ({}),
        createBackendFor: vi.fn(),
        runHeadless: vi.fn(),
        resolveOutputFormat: () => 'plain',
        readStdin: vi.fn(async () => ''),
      } as never);
      return program;
    }

    it('closes runtime resources after memory commands', async () => {
      const close = vi.fn(async () => {});
      const runtime = vi.fn(async () => ({
        config: { ...defaults, providers: {}, limits: { ...defaults.limits } },
        store: { getMemory: vi.fn(async () => ({ remembered: 'yes' })) },
        tools: { close },
      }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await commandProgram(runtime).parseAsync(['node', 'kyokao', 'memory', 'list']);
      expect(close).toHaveBeenCalledOnce();
    });

    it('lists all Capy models with role eligibility and diagnoses both active roles', async () => {
      const close = vi.fn(async () => {});
      const models = [
        {
          id: 'captain',
          name: 'Captain',
          provider: 'OpenAI',
          captainEligible: true,
        },
        {
          id: 'builder',
          name: 'Builder',
          provider: 'Anthropic',
          captainEligible: false,
        },
      ];
      const runtime = vi.fn(async () => ({
        config: {
          ...defaults,
          provider: 'capy',
          model: 'captain',
          providers: {
            capy: {
              projectId: 'project-1',
              model: 'captain',
              buildModel: 'builder',
            },
          },
          limits: { ...defaults.limits },
        },
        root: 'C:\\workspace',
        provider: { baseURL: 'https://capy.test/v1' },
        providerOptions: {
          apiKey: 'configured',
          model: 'captain',
        },
        capy: {
          models: vi.fn(async () => models),
          projects: vi.fn(async () => [{ id: 'project-1', name: 'Project One' }]),
        },
        tools: { close },
      }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await commandProgram(runtime).parseAsync(['node', 'kyokao', 'models']);
      expect(log).toHaveBeenCalledWith('captain\tCaptain\tOpenAI\tCaptain + Build');
      expect(log).toHaveBeenCalledWith('builder\tBuilder\tAnthropic\tBuild');

      log.mockClear();
      await commandProgram(runtime).parseAsync(['node', 'kyokao', 'doctor']);
      expect(log).toHaveBeenCalledWith('Captain model: captain (eligible)');
      expect(log).toHaveBeenCalledWith('Build model: builder');
    });

    it('requires a provider model and refuses incomplete Capy activation', async () => {
      const program = commandProgram(vi.fn());
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await expect(
        program.parseAsync(['node', 'kyokao', 'provider', 'use', 'openai']),
      ).rejects.toThrow('No model is saved');
      expect((await readConfig(join(home, 'config.json'))).provider).toBeUndefined();

      await commandProgram(vi.fn()).parseAsync([
        'node',
        'kyokao',
        'provider',
        'use',
        'openai',
        'gpt-test',
      ]);
      expect(await readConfig(join(home, 'config.json'))).toMatchObject({
        provider: 'openai',
        model: 'gpt-test',
        providers: { openai: { model: 'gpt-test' } },
      });

      await expect(
        commandProgram(vi.fn()).parseAsync([
          'node',
          'kyokao',
          'provider',
          'use',
          'capy',
          'captain',
        ]),
      ).rejects.toThrow('requires a saved project');
      expect((await readConfig(join(home, 'config.json'))).provider).toBe('openai');
    });

    it('rejects invalid theme names before writing them', async () => {
      await expect(
        commandProgram(vi.fn()).parseAsync(['node', 'kyokao', 'theme', 'save', 'not-a-theme']),
      ).rejects.toThrow('Unknown TUI theme');
      expect((await readConfig(join(home, 'config.json'))).theme).toBeUndefined();
    });
  });

  describe('/context — estimateTokens against a budget', () => {
    it('counts tokens for a small transcript and stays under a typical budget', () => {
      const messages = [user('refactor the auth module'), assistant('I will start by reading it.')];
      const tokens = estimateTokens(messages);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(16000);
    });

    it('reports zero for an empty transcript', () => {
      expect(estimateTokens([])).toBe(0);
    });
  });

  describe('/compact — compressMessages', () => {
    it('is a no-op when the transcript is within budget', () => {
      const messages = [user('hi'), assistant('hello')];
      const result = compressMessages(messages, 16000);
      expect(result.removed).toBe(0);
      expect(result.messages).toBe(messages);
    });

    it('drops middle messages and emits a summary when over budget', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'system prompt' },
        ...Array.from({ length: 20 }, (_, i) => user(`turn ${i} ${'x'.repeat(200)}`)),
        ...Array.from({ length: 20 }, (_, i) => assistant(`reply ${i} ${'y'.repeat(200)}`)),
        user('latest prompt'),
      ];
      const before = estimateTokens(messages);
      const result = compressMessages(messages, 500);
      expect(result.removed).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
      expect(estimateTokens(result.messages)).toBeLessThan(before);

      expect(result.messages[0]?.role).toBe('system');
      expect(result.messages[0]?.content).toBe('system prompt');

      expect(result.messages.at(-1)?.content).toBe('latest prompt');
    });
  });

  describe('/plan — Session.plan round-trip through LocalStore', () => {
    it('persists plan steps and reloads them', async () => {
      const store = new LocalStore(home);
      const session = await store.create('plan task', '/repo');
      session.plan = ['read auth.ts', 'write tests', 'refactor'];
      await store.saveSession(session);
      const reloaded = await store.loadSession(session.id);
      expect(reloaded.plan).toEqual(['read auth.ts', 'write tests', 'refactor']);
    });

    it('defaults to undefined for sessions created before 0.8.0', async () => {
      const store = new LocalStore(home);
      const session = await store.create('old task');
      expect(session.plan).toBeUndefined();
    });
  });

  describe('/rename — Session.task mutation', () => {
    it('overwrites the task title and persists', async () => {
      const store = new LocalStore(home);
      const session = await store.create('first prompt here');
      session.task = 'auth-refactor';
      await store.saveSession(session);
      const reloaded = await store.loadSession(session.id);
      expect(reloaded.task).toBe('auth-refactor');
    });
  });

  describe('/rewind — turn boundary detection', () => {
    function rewindBoundary(messages: ChatMessage[]): number {
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'user') {
          lastUser = i;
          break;
        }
      }
      return lastUser < 0 ? messages.length : lastUser;
    }

    it('drops everything from the last user prompt onward', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        user('first prompt'),
        assistant('first reply'),
        user('second prompt'),
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: '1', type: 'function', function: { name: 'edit', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: '1', content: 'edited' },
        assistant('second reply after tool'),
      ];
      const end = rewindBoundary(messages);
      expect(end).toBe(3);
      expect(messages.slice(0, end).map((m) => m.content)).toEqual([
        'sys',
        'first prompt',
        'first reply',
      ]);
    });

    it('returns the full length when there is no user message to drop', () => {
      const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
      expect(rewindBoundary(messages)).toBe(messages.length);
    });
  });
});
