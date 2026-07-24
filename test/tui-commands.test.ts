import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults, readConfig } from '@kyokao/config';
import { LocalStore } from '@kyokao/memory';
import { createThemeContext, parseWorkspaceCommand, workspaceCommands } from '@kyokao/ui';
import { handleTuiCommand } from '../packages/cli/src/tui-commands.js';
import { buildCommandPalette } from '../packages/cli/src/tui-palette.js';

function parsed(value: string) {
  const command = parseWorkspaceCommand(value);
  if (!command?.name) throw new Error(`Unable to parse test command: ${value}`);
  return command;
}

describe('TUI slash command integration', () => {
  let root: string;
  let home: string;
  let store: LocalStore;
  let currentSession: any;
  let ctx: any;
  let control: any;
  let emitted: Array<{ kind: string; value: unknown }>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kyokao-tui-command-root-'));
    home = await mkdtemp(join(tmpdir(), 'kyokao-tui-command-home-'));
    process.env.KYOKAO_HOME = home;
    store = new LocalStore(home);
    emitted = [];
    const config = {
      ...defaults,
      provider: 'openai',
      model: 'old-model',
      providers: {},
      profiles: {},
      aliases: {},
      mcp: {},
      plugins: [],
      limits: { ...defaults.limits },
      subagents: { enabled: false },
    };
    const backend = {
      provider: 'openai',
      session: () => currentSession,
      close: vi.fn(async () => {}),
    };
    ctx = {
      r: {
        config,
        store,
        root,
        provider: {
          baseURL: 'https://provider.test/v1',
          validateModel: vi.fn(async () => ({ id: 'old-model' })),
        },
        providerOptions: { apiKey: 'configured' },
        tools: {
          execute: vi.fn(async () => ({ isError: false, content: '' })),
          close: vi.fn(async () => {}),
        },
        capy: undefined,
      },
      backend,
      themeContext: createThemeContext({ colorLevel: 0 }),
      sessionChoices: [],
      memoryChoices: {},
      providerModels: ['old-model', 'new-model'],
      modelContextWindow: undefined,
      projectChoices: [],
      capyModelChoices: [],
      capyAvailableModels: [],
      capyModelRole: undefined,
      capyThreadChoices: [],
      skipModelCheck: true,
      refreshProviderModels: vi.fn(),
      refreshCapyThreads: vi.fn(async () => {}),
      refreshCapySpending: vi.fn(async () => {}),
      replaceRuntime: vi.fn(async (overrides: any, options: any = {}) => {
        await options.beforeSwap?.();
        ctx.r = {
          ...ctx.r,
          config: {
            ...ctx.r.config,
            ...overrides,
            providers: overrides.providers ?? ctx.r.config.providers,
            limits: { ...ctx.r.config.limits, ...(overrides.limits ?? {}) },
            subagents: { ...ctx.r.config.subagents, ...(overrides.subagents ?? {}) },
          },
        };
      }),
    };
    control = {
      scheduler: () => ({ phase: 'idle', queue: [] }),
      clearQueue: vi.fn(async () => 0),
      retryQueue: vi.fn(async () => {}),
      reset: vi.fn(async () => {
        currentSession = undefined;
      }),
      cancelActive: vi.fn(async () => {}),
      enqueue: vi.fn(async () => {}),
      promptSecret: vi.fn(async () => undefined),
      showOverlay: vi.fn(),
      requestApproval: vi.fn(async () => true),
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.KYOKAO_HOME;
    delete process.env.CAPY_API_KEY;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  });

  const run = async (value: string) =>
    await handleTuiCommand(
      parsed(value),
      ((kind: string, output: unknown) => emitted.push({ kind, value: output })) as never,
      control,
      ctx,
    );

  it('reports and persists the new model and approval values after swapping runtimes', async () => {
    const model = await run('/model new-model');
    expect(model?.messages?.[0]?.text).toContain('new-model');
    expect(model?.messages?.[0]?.text).not.toContain('old-model');
    expect(ctx.r.config.providers.openai.model).toBe('new-model');
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      model: 'new-model',
      providers: { openai: { model: 'new-model' } },
    });

    const approval = await run('/permissions full-auto');
    expect(approval?.messages?.[0]?.text).toContain('full-auto');
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      approval: 'full-auto',
    });

    ctx.r.config.providers.custom = {
      baseURL: 'https://custom.test/v1',
      apiKey: 'custom-key',
    };
    const provider = await run('/provider custom custom-model');
    expect(provider?.messages?.[0]?.text).toContain('custom');
    expect(ctx.r.config).toMatchObject({
      provider: 'custom',
      model: 'custom-model',
      providers: { custom: { model: 'custom-model' } },
    });
  });

  it('opens settings choices and persists the live thinking visibility toggle', async () => {
    const rootSettings = buildCommandPalette('/settings', ctx);
    expect(rootSettings?.map((choice) => choice.label)).toEqual(
      expect.arrayContaining(['Thinking', 'Provider', 'Model', 'Permissions']),
    );
    expect(rootSettings?.find((choice) => choice.label === 'Thinking')).toMatchObject({
      completion: '/settings thinking off',
      submit: true,
    });

    const themeChoices = buildCommandPalette('/settings theme ', ctx);
    expect(themeChoices?.map((choice) => choice.completion)).toContain('/settings theme dracula');
    expect(
      themeChoices?.find((choice) => choice.completion === '/settings theme kyokao-dark'),
    ).toMatchObject({ label: 'Kyokao Dark' });
    expect(
      buildCommandPalette('/settings code-theme ', ctx)?.find(
        (choice) => choice.completion === '/settings code-theme github-light',
      ),
    ).toMatchObject({ label: 'GitHub Light' });
    expect(buildCommandPalette('/permissions ', ctx)?.map((choice) => choice.label)).toEqual([
      'Auto Edit',
      'Suggest',
      'Full Auto',
    ]);
    expect(
      buildCommandPalette('/settings permissions ', ctx)?.map((choice) => choice.label),
    ).toEqual(['Suggest', 'Auto Edit', 'Full Auto']);
    expect(buildCommandPalette('/model ', ctx)?.[0]?.label).toBe('old-model');
    expect(buildCommandPalette('/personality ', ctx)?.map((choice) => choice.label)).toEqual([
      'default',
      'concise',
      'friendly',
      'technical',
    ]);
    expect(buildCommandPalette('/queue ', ctx)?.map((choice) => choice.label)).toEqual([
      'list',
      'clear',
      'retry',
    ]);

    const hidden = await run('/settings thinking off');
    expect(hidden?.messages?.[0]?.text).toContain('hidden');
    expect(hidden?.prefill).toBe('/settings');
    expect(ctx.r.config.tui.showThinking).toBe(false);
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      tui: { showThinking: false },
    });
    expect(buildCommandPalette('/settings', ctx)?.[0]).toMatchObject({
      completion: '/settings thinking on',
    });

    const theme = await run('/settings theme dracula');
    expect(theme?.prefill).toBe('/settings');
    expect(ctx.themeContext.names.tui).toBe('dracula');
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      theme: 'dracula',
    });

    const permissions = await run('/settings permissions full-auto');
    expect(permissions?.prefill).toBe('/settings');
    expect(ctx.r.config.approval).toBe('full-auto');
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      approval: 'full-auto',
    });

    const visible = await run('/settings reasoning on');
    expect(visible?.messages?.[0]?.text).toContain('visible');
    expect(visible?.prefill).toBe('/settings');
    expect(ctx.r.config.tui.showThinking).toBe(true);
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      tui: { showThinking: true },
    });
  });

  it('applies NVIDIA GPT-OSS reasoning settings to the live provider and persistence', async () => {
    ctx.r.config.provider = 'nvidia';
    ctx.r.config.model = 'openai/gpt-oss-120b';
    ctx.r.providerOptions = {
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: 'openai/gpt-oss-120b',
      reasoningEffort: 'medium',
    };
    ctx.r.provider = {
      baseURL: 'https://integrate.api.nvidia.com/v1',
      options: {
        baseURL: 'https://integrate.api.nvidia.com/v1',
        model: 'openai/gpt-oss-120b',
        reasoningEffort: 'medium',
      },
    };

    expect(buildCommandPalette('/settings', ctx)?.map((choice) => choice.label)).toContain(
      'Reasoning effort',
    );
    expect(
      buildCommandPalette('/settings reasoning-effort ', ctx)?.map((choice) => choice.completion),
    ).toEqual([
      '/settings reasoning-effort low',
      '/settings reasoning-effort medium',
      '/settings reasoning-effort high',
    ]);

    const hidden = await run('/settings thinking off');
    expect(hidden?.messages?.[0]?.text).toContain('low reasoning effort');
    expect(ctx.r.providerOptions.reasoningEffort).toBe('low');
    expect(ctx.r.provider.options.reasoningEffort).toBe('low');
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      providers: { nvidia: { reasoningEffort: 'low' } },
      tui: { showThinking: false },
    });

    const high = await run('/settings reasoning-effort high');
    expect(high?.messages?.[0]?.text).toContain('high');
    expect(ctx.r.providerOptions.reasoningEffort).toBe('high');
    expect(ctx.r.provider.options.reasoningEffort).toBe('high');
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      providers: { nvidia: { reasoningEffort: 'high' } },
    });

    await run('/settings thinking on');
    expect(ctx.r.providerOptions.reasoningEffort).toBe('medium');
  });

  it('stages a Capy key safely across multi-project selection without activating invalid config', async () => {
    control.promptSecret.mockResolvedValueOnce('capy-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string) => {
        if (String(url).includes('/models'))
          return new Response(
            JSON.stringify({
              models: [
                {
                  id: 'captain-model',
                  name: 'Captain Model',
                  provider: 'openai',
                  captainEligible: true,
                },
                {
                  id: 'build-model',
                  name: 'Build Model',
                  provider: 'anthropic',
                  captainEligible: false,
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        expect(String(url)).toContain('/projects');
        return new Response(
          JSON.stringify({
            items: [
              { id: 'project-1', name: 'One', repos: [] },
              { id: 'project-2', name: 'Two', repos: [] },
            ],
            hasMore: false,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const staged = await run('/provider capy');
    expect(staged?.prefill).toBe('/provider capy ');
    expect(ctx.projectChoices.map((project: any) => project.id)).toEqual([
      'project-1',
      'project-2',
    ]);
    const stagedConfig = await readConfig(join(home, 'config.json'));
    expect(stagedConfig.provider).toBeUndefined();
    expect(stagedConfig.providers?.capy?.apiKey).toBe('capy-token');

    const modelStage = await run('/provider capy project-2');
    expect(modelStage?.prefill).toBe('/provider capy project-2 ');
    expect(ctx.capyModelChoices).toEqual([
      {
        id: 'captain-model',
        name: 'Captain Model',
        description: 'openai · Captain',
      },
    ]);
    expect(buildCommandPalette('/provider capy project-2 ', ctx)?.[0]?.completion).toBe(
      '/provider capy project-2 captain-model',
    );

    const buildStage = await run('/provider capy project-2 captain-model');
    expect(buildStage?.prefill).toBe('/provider capy project-2 captain-model ');
    expect(ctx.capyModelChoices.map((model: any) => model.id)).toEqual([
      'captain-model',
      'build-model',
    ]);
    expect(
      buildCommandPalette('/provider capy project-2 captain-model ', ctx)?.map(
        (choice) => choice.completion,
      ),
    ).toContain('/provider capy project-2 captain-model build-model');

    const selected = await run('/provider capy project-2 captain-model build-model');
    expect(selected?.messages?.[0]?.text).toContain('project-2');
    expect(ctx.r.config.provider).toBe('capy');
    expect(ctx.r.config.providers.capy).toMatchObject({
      apiKey: 'capy-token',
      projectId: 'project-2',
      buildModel: 'build-model',
    });
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      provider: 'capy',
      model: 'captain-model',
      providers: {
        capy: {
          apiKey: 'capy-token',
          projectId: 'project-2',
          model: 'captain-model',
          buildModel: 'build-model',
        },
      },
    });
  });

  it('uses CAPY_API_KEY without copying the environment secret into saved config', async () => {
    process.env.CAPY_API_KEY = 'environment-capy-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string) => {
        if (String(url).includes('/models'))
          return new Response(
            JSON.stringify({
              models: [
                {
                  id: 'shared-model',
                  name: 'Shared Model',
                  provider: 'openai',
                  captainEligible: true,
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        return new Response(
          JSON.stringify({
            items: [{ id: 'project-1', name: 'One', repos: [] }],
            hasMore: false,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await run('/provider capy');
    await run('/provider capy project-1');
    await run('/provider capy project-1 shared-model');
    await run('/provider capy project-1 shared-model shared-model');

    const saved = await readConfig(join(home, 'config.json'));
    expect(saved.providers?.capy).toMatchObject({
      projectId: 'project-1',
      model: 'shared-model',
      buildModel: 'shared-model',
    });
    expect(saved.providers?.capy?.apiKey).toBeUndefined();
  });

  it('pulls Capy role models from the API and changes Captain and Build independently', async () => {
    const models = [
      {
        id: 'captain-old',
        name: 'Captain Old',
        provider: 'openai',
        captainEligible: true,
      },
      {
        id: 'captain-new',
        name: 'Captain New',
        provider: 'openai',
        captainEligible: true,
      },
      {
        id: 'builder-new',
        name: 'Builder New',
        provider: 'anthropic',
        captainEligible: false,
      },
    ];
    ctx.r.config.provider = 'capy';
    ctx.r.config.model = 'captain-old';
    ctx.r.config.providers.capy = {
      apiKey: 'capy-token',
      projectId: 'project-1',
      model: 'captain-old',
      buildModel: 'captain-old',
    };
    ctx.r.capy = { models: vi.fn(async () => models) };
    ctx.r.providerOptions = { apiKey: 'capy-token', model: 'captain-old' };
    ctx.refreshProviderModels.mockImplementation(async () => {
      ctx.capyAvailableModels = await ctx.r.capy.models();
      ctx.providerModels = ctx.capyAvailableModels
        .filter((model: any) => model.captainEligible)
        .map((model: any) => model.id);
    });
    await ctx.refreshProviderModels();

    expect(buildCommandPalette('/settings ', ctx)?.map((choice) => choice.label)).toEqual(
      expect.arrayContaining(['Captain model', 'Build model']),
    );
    expect(
      buildCommandPalette('/settings captain-model ', ctx)?.map((choice) => choice.completion),
    ).toEqual(
      expect.arrayContaining([
        '/settings captain-model captain-old',
        '/settings captain-model captain-new',
      ]),
    );
    expect(
      buildCommandPalette('/settings captain-model ', ctx)?.map((choice) => choice.completion),
    ).not.toContain('/settings captain-model builder-new');
    expect(
      buildCommandPalette('/settings build-model ', ctx)?.map((choice) => choice.completion),
    ).toContain('/settings build-model builder-new');

    const captain = await run('/settings captain-model captain-new');
    expect(captain?.messages?.[0]?.text).toContain('Captain captain-new');
    expect(ctx.r.config.model).toBe('captain-new');
    expect(ctx.r.config.providers.capy.buildModel).toBe('captain-old');

    const builder = await run('/settings build-model builder-new');
    expect(builder?.messages?.[0]?.text).toContain('Build builder-new');
    expect(ctx.r.config.model).toBe('captain-new');
    expect(ctx.r.config.providers.capy.buildModel).toBe('builder-new');
    expect(ctx.replaceRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'captain-new',
        providers: expect.objectContaining({
          capy: expect.objectContaining({
            model: 'captain-new',
            buildModel: 'builder-new',
          }),
        }),
      }),
      { preserveCompatibleSession: true },
    );
    expect(await readConfig(join(home, 'config.json'))).toMatchObject({
      provider: 'capy',
      model: 'captain-new',
      providers: {
        capy: {
          model: 'captain-new',
          buildModel: 'builder-new',
        },
      },
    });
  });

  it('shows live Capy project spending and explains missing billing permission', async () => {
    ctx.r.config.provider = 'capy';
    ctx.r.config.providers.capy = { projectId: 'project-1' };
    ctx.r.capy = {};
    ctx.capySpending = {
      totalDollars: 4.5,
      llmDollars: 4,
      vmDollars: 0.5,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-24T12:00:00.000Z',
    };

    const usage = await run('/usage');
    expect(ctx.refreshCapySpending).toHaveBeenCalledWith(true);
    expect(usage?.messages?.[0]?.text).toContain('total: $4.50');
    expect(usage?.messages?.[0]?.text).toContain('llm:   $4.00');
    expect(usage?.messages?.[0]?.text).toContain('vm:    $0.50');

    ctx.capySpending = undefined;
    ctx.capySpendingError = 'You do not have permission to perform this action';
    const denied = await run('/usage');
    expect(denied?.messages?.[0]).toMatchObject({ kind: 'error' });
    expect(denied?.messages?.[0]?.text).toContain('Billing or usage permission may be required');
  });

  it('reports model capacity separately from the local compression budget', async () => {
    currentSession = await store.create('context check', root);
    currentSession.messages = [{ role: 'user', content: 'small transcript' }];
    ctx.modelContextWindow = 1_000_000;

    const result = await run('/context');
    expect(result?.messages?.[0]?.text).toContain('model context:');
    expect(result?.messages?.[0]?.text).toContain('/ 1,000,000 tokens');
    expect(result?.messages?.[0]?.text).toContain('agent compress at: 12,800 tokens');
  });

  it('persists goal/personality, renders raw mode, and creates instructions without overwrite', async () => {
    currentSession = await store.create('task', root);
    expect((await run('/goal finish the audit'))?.messages?.[0]?.text).toContain(
      'finish the audit',
    );
    expect((await run('/personality technical'))?.messages?.[0]?.text).toContain('technical');
    expect(await store.loadSession(currentSession.id)).toMatchObject({
      goal: 'finish the audit',
      personality: 'technical',
    });
    expect(await run('/raw')).toMatchObject({ overlay: 'raw' });

    expect((await run('/init'))?.messages?.[0]?.text).toContain('AGENTS.md');
    await writeFile(join(root, 'AGENTS.md'), 'keep me', 'utf8');
    expect((await run('/init'))?.messages?.[0]).toMatchObject({ kind: 'error' });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('keep me');
  });

  it('discovers and invokes installed skills through their SKILL.md instructions', async () => {
    const skillDirectory = join(home, 'skills', '.system', 'demo-skill');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), '# Demo\nFollow the demo workflow.', 'utf8');
    expect((await run('/skills'))?.messages?.[0]?.text).toContain('demo-skill');
    expect((await run('/skills demo-skill'))?.messages?.[0]?.text).toContain('Loaded skill');
    expect(control.enqueue).toHaveBeenCalledWith(
      expect.stringContaining('Follow the demo workflow'),
    );
  });

  it('archives, lists, restores, forks, and confirms deletion through the store', async () => {
    currentSession = await store.create('lifecycle', root);
    ctx.sessionChoices = [currentSession];
    const sessionId = currentSession.id;
    await run('/archive');
    expect(await store.listSessions()).toEqual([]);
    expect((await run('/archive list'))?.messages?.[0]?.text).toContain(sessionId);

    await run('/archive restore 1');
    expect((await store.listSessions()).map((session) => session.id)).toContain(sessionId);
    currentSession = await store.loadSession(sessionId);
    ctx.sessionChoices = [currentSession];
    await run('/fork');
    expect((await store.listSessions()).length).toBe(2);

    currentSession = await store.loadSession(sessionId);
    ctx.sessionChoices = await store.listSessions();
    control.requestApproval.mockResolvedValueOnce(false);
    expect((await run(`/delete ${sessionId}`))?.messages?.[0]?.text).toContain('cancelled');
    expect(await store.loadSession(sessionId)).toMatchObject({ id: sessionId });
  });

  it('restores saved transcript content when resuming a session', async () => {
    const saved = await store.create('saved conversation', root);
    saved.messages = [
      { role: 'user', content: 'original request' },
      { role: 'assistant', content: 'original answer' },
    ];
    await store.saveSession(saved);
    ctx.sessionChoices = [saved];
    const result = await run(`/resume ${saved.id}`);
    expect(result?.clear).toBe(true);
    expect(result?.messages).toEqual(
      expect.arrayContaining([
        { kind: 'user', text: 'original request' },
        { kind: 'assistant', text: 'original answer' },
      ]),
    );
  });

  it('loads remote thread history from the selected Capy project', async () => {
    const thread = {
      id: 'thread-remote-1',
      projectId: 'project-1',
      title: 'Remote Capy conversation',
      status: 'completed',
      runState: 'ready',
      waitingOn: [],
      blockedOn: [],
      pendingWakeups: 0,
      tasks: [],
      participants: [],
      pullRequests: [],
      slackThreads: [],
      tags: [],
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:05:00.000Z',
    };
    ctx.r.config.provider = 'capy';
    ctx.r.config.model = 'capy-model';
    ctx.r.config.providers.capy = { projectId: 'project-1', model: 'capy-model' };
    ctx.r.providerOptions.model = 'capy-model';
    ctx.r.capy = {
      getThread: vi.fn(async () => thread),
      messages: vi.fn(async () => [
        {
          id: 'message-user',
          source: 'user',
          content: 'remote request',
          createdAt: '2026-07-20T10:00:00.000Z',
        },
        {
          id: 'message-assistant',
          source: 'assistant',
          content: 'remote answer',
          createdAt: '2026-07-20T10:01:00.000Z',
        },
      ]),
    };
    ctx.capyThreadChoices = [thread];

    expect(buildCommandPalette('/resume', ctx)?.[0]).toMatchObject({
      label: 'Remote Capy conversation',
      completion: '/resume capy:thread-remote-1',
    });
    const result = await run('/resume capy:thread-remote-1');

    expect(result?.clear).toBe(true);
    expect(result?.messages).toEqual(
      expect.arrayContaining([
        { kind: 'user', text: 'remote request' },
        { kind: 'assistant', text: 'remote answer' },
      ]),
    );
    expect(ctx.backend.status()).toMatchObject({
      provider: 'capy',
      projectId: 'project-1',
      threadId: 'thread-remote-1',
    });
    const imported = (await store.listSessions()).find(
      (session) => session.remote?.threadId === 'thread-remote-1',
    );
    expect(imported?.messages).toEqual([
      { role: 'user', content: 'remote request' },
      { role: 'assistant', content: 'remote answer' },
    ]);
  });

  it('rebuilds the visible transcript after rewinding the latest turn', async () => {
    currentSession = await store.create('rewind', root);
    currentSession.messages = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'remove this request' },
      { role: 'assistant', content: 'remove this answer' },
    ];
    await store.saveSession(currentSession);
    const result = await run('/rewind');
    expect(result?.clear).toBe(true);
    expect(result?.messages?.map((message) => message.text).join('\n')).toContain('first answer');
    expect(result?.messages?.map((message) => message.text).join('\n')).not.toContain(
      'remove this request',
    );
  });

  it('routes every registered command to a handler or an explicit capability response', async () => {
    expect(workspaceCommands.map((command) => command.name)).not.toContain('pets');
    for (const definition of workspaceCommands) {
      const result = await run(`/${definition.name}`);
      const messages = result?.messages ?? [];
      expect(
        messages.some((message) => message.text.includes('registered but has no implementation')),
        `/${definition.name} reached the missing-handler fallback`,
      ).toBe(false);
    }
  });

  it('keeps no-argument lifecycle commands aimed at the current session', () => {
    ctx.sessionChoices = [{ id: '00000000-0000-4000-8000-000000000001', task: 'saved session' }];
    for (const command of ['fork', 'archive', 'delete', 'rollout']) {
      expect(buildCommandPalette(`/${command}`, ctx)).toBeUndefined();
      expect(buildCommandPalette(`/${command} `, ctx)?.length).toBeGreaterThan(0);
    }

    ctx.r.config.approval = 'full-auto';
    ctx.r.config.subagents.enabled = false;
    currentSession = { personality: 'technical' };
    expect(buildCommandPalette('/permissions', ctx)?.[0]?.completion).toBe(
      '/permissions full-auto',
    );
    expect(buildCommandPalette('/personality', ctx)?.[0]?.completion).toBe(
      '/personality technical',
    );
    expect(buildCommandPalette('/subagents', ctx)?.[0]?.completion).toBe('/subagents off');
  });
});
