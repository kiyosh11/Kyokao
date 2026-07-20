#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  loadConfig,
  readConfig,
  redact,
  resolveProvider,
  providerPresets,
  atomicWrite,
  globalConfigPath,
  mergeProviderSetup,
  effectiveSetupApiKey,
  type KyokaoConfig,
} from '@kyokao/config';
import {
  CapyClient,
  OpenAICompatibleProvider,
  modelCatalog as builtInModelCatalog,
} from '@kyokao/providers';
import {
  WorkspaceSandbox,
  CoreTools,
  CompositeTools,
  connectMcp,
  loadPlugins,
} from '@kyokao/tools';
import { LocalStore } from '@kyokao/memory';
import {
  Agent,
  CapyRemoteBackend,
  LocalAgentBackend,
  loadInstructionFiles,
  type BackendEmit,
  type PromptBackend,
} from '@kyokao/agent';
import {
  setupWizard,
  terminalWorkspace,
  withInteractiveScreen,
  ui,
  workspaceCommands,
  type InteractiveScreen,
  type WorkspaceEmit,
} from '@kyokao/ui';
const program = new Command();
program
  .name('kyokao')
  .description('Kyokao: local and Capy remote coding agents')
  .version('0.4.0')
  .option('-m, --model <id>', 'model ID or configured alias')
  .option('-p, --provider <name>', 'provider preset or configured provider')
  .option('--base-url <url>', 'override provider base URL')
  .option('--api-key <key>', 'override API key (never persisted)')
  .option('--approval <mode>', 'suggest, auto-edit, or full-auto')
  .option('--profile <name>', 'configuration profile')
  .option('--max-iterations <n>', 'agent iteration limit')
  .option('--context-window <n>', 'context token budget')
  .option('--temperature <n>', 'sampling temperature (0–2)')
  .option('--max-tokens <n>', 'maximum completion tokens')
  .option('--top-p <n>', 'nucleus sampling probability (0–1)')
  .option('--fallback-model <ids>', 'comma-separated fallback model IDs')
  .option('--max-tool-calls <n>', 'maximum tool calls per run')
  .option('--max-shell-timeout <ms>', 'maximum shell timeout in milliseconds')
  .option('--max-output-chars <n>', 'maximum tool output characters')
  .option('--max-file-bytes <n>', 'maximum file read/write size')
  .option('--max-cost <usd>', 'maximum estimated run cost in USD')
  .option('--allow-host <hosts>', 'comma-separated HTTP host allowlist')
  .option('--skip-model-check', 'skip provider model availability validation')
  .option('--editor <command>', 'editor command for the edit command');
function cliConfig(): Partial<KyokaoConfig> {
  const o = program.opts();
  return {
    provider: o.provider,
    model: o.model,
    approval: o.approval,
    maxIterations: o.maxIterations ? Number(o.maxIterations) : undefined,
    contextWindow: o.contextWindow ? Number(o.contextWindow) : undefined,
    temperature: o.temperature ? Number(o.temperature) : undefined,
    maxTokens: o.maxTokens ? Number(o.maxTokens) : undefined,
    topP: o.topP ? Number(o.topP) : undefined,
    fallbackModels: o.fallbackModel
      ? String(o.fallbackModel)
          .split(',')
          .map((model) => model.trim())
          .filter(Boolean)
      : undefined,
    limits: {
      ...(o.maxToolCalls ? { maxToolCalls: Number(o.maxToolCalls) } : {}),
      ...(o.maxShellTimeout ? { maxShellTimeoutMs: Number(o.maxShellTimeout) } : {}),
      ...(o.maxOutputChars ? { maxOutputChars: Number(o.maxOutputChars) } : {}),
      ...(o.maxFileBytes ? { maxFileBytes: Number(o.maxFileBytes) } : {}),
      ...(o.maxCost ? { maxCostUsd: Number(o.maxCost) } : {}),
      ...(o.allowHost
        ? {
            allowedHosts: String(o.allowHost)
              .split(',')
              .map((host) => host.trim())
              .filter(Boolean),
          }
        : {}),
    },
    editor: o.editor,
    providers:
      o.baseUrl || o.apiKey
        ? { [o.provider ?? 'openai']: { baseURL: o.baseUrl, apiKey: o.apiKey } }
        : {},
  } as Partial<KyokaoConfig>;
}
async function needsProviderSetup(): Promise<boolean> {
  const options = program.opts();
  if (options.provider || options.baseUrl || options.apiKey || options.model || options.profile)
    return false;
  const [global, local] = await Promise.all([
    readConfig(globalConfigPath()),
    readConfig(join(process.cwd(), '.kyokao.json')),
  ]);
  return !global.provider && !local.provider && !process.env.KYOKAO_PROVIDER;
}

async function setupProvider(confirmReplace = false, screen?: InteractiveScreen): Promise<boolean> {
  const saved = await readConfig(globalConfigPath());
  const localNames = new Set(['ollama', 'lmstudio', 'vllm']);
  const providers = [
    ...Object.entries(providerPresets).map(([name, preset]) => ({
      name,
      baseURL: preset.baseURL,
      env: preset.env,
      local: localNames.has(name),
      description: localNames.has(name)
        ? `Local server at ${preset.baseURL}`
        : name === 'capy'
          ? 'Capy remote agent (connected repositories and isolated VMs)'
          : `Hosted API (${preset.env})`,
      remote: preset.remote,
    })),
    ...Object.entries(saved.providers ?? {})
      .filter(([name]) => !providerPresets[name])
      .map(([name, provider]) => ({
        name,
        baseURL: provider.baseURL,
        description: provider.baseURL
          ? `Saved endpoint at ${provider.baseURL}`
          : 'Saved custom provider',
      })),
    { name: '__custom__', description: 'New OpenAI-compatible endpoint' },
  ];
  const result = await setupWizard({
    providers,
    configPath: globalConfigPath(),
    confirmReplace,
    screen,
    keySource: (provider) =>
      provider.local
        ? 'local'
        : saved.providers?.[provider.name]?.apiKey
          ? 'saved'
          : provider.env && process.env[provider.env]
            ? 'environment'
            : 'not configured',
    fetchModels: async ({ provider, baseURL, apiKey, local, signal }) => {
      const effectiveKey = effectiveSetupApiKey(
        apiKey,
        saved.providers?.[provider]?.apiKey,
        providerPresets[provider]?.env ? process.env[providerPresets[provider]!.env] : undefined,
      );
      if (!baseURL || (!local && !effectiveKey)) return [];
      if (provider === 'capy')
        return (await new CapyClient({ baseURL, apiKey: effectiveKey }).models(signal))
          .filter((model) => model.captainEligible)
          .map((model) => model.id);
      return await new OpenAICompatibleProvider({
        baseURL,
        apiKey: effectiveKey,
        model: 'setup',
      }).models(signal);
    },
    fetchProjects: async ({ provider, baseURL, apiKey, signal }) => {
      if (provider !== 'capy') return [];
      const effectiveKey = effectiveSetupApiKey(
        apiKey,
        saved.providers?.capy?.apiKey,
        process.env.CAPY_API_KEY,
      );
      if (!effectiveKey) return [];
      return (await new CapyClient({ baseURL, apiKey: effectiveKey }).projects(signal)).map(
        (project) => ({
          id: project.id,
          name: project.name,
          description: project.repos.map((repo) => repo.repoFullName).join(', ') || 'No repository',
        }),
      );
    },
  });
  if (!result) return false;
  await atomicWrite(
    globalConfigPath(),
    mergeProviderSetup(saved, {
      ...result,
      presetBaseURL: providerPresets[result.provider]?.baseURL,
      projectId: result.projectId,
    }),
  );
  return true;
}

async function runtime(
  overrides: Partial<KyokaoConfig> = {},
  approve: (action: string, detail: string) => Promise<boolean> = ui.approve,
) {
  const loaded = await loadConfig({ cli: cliConfig(), profile: program.opts().profile });
  const config: KyokaoConfig = {
    ...loaded,
    ...overrides,
    limits: { ...loaded.limits, ...(overrides.limits ?? {}) },
    providers: { ...loaded.providers, ...(overrides.providers ?? {}) },
  };
  const p = resolveProvider(config);
  const root = process.cwd();
  const store = new LocalStore(join(root, '.kyokao'));
  const core = new CoreTools(new WorkspaceSandbox(root), config.approval, approve, {
    maxShellTimeoutMs: config.limits.maxShellTimeoutMs,
    maxOutputChars: config.limits.maxOutputChars,
    maxFileBytes: config.limits.maxFileBytes,
    allowedHosts: config.limits.allowedHosts,
  });
  const plugins = await loadPlugins(config.plugins, root);
  const mcp = await connectMcp(config.mcp, root);
  const tools = new CompositeTools([core, ...plugins, ...(mcp ? [mcp] : [])]);
  return {
    config,
    store,
    provider: config.provider === 'capy' ? undefined : new OpenAICompatibleProvider(p),
    capy:
      config.provider === 'capy'
        ? new CapyClient({ baseURL: p.baseURL, apiKey: p.apiKey })
        : undefined,
    providerOptions: p,
    tools,
    root,
    core,
    instructions: await loadInstructionFiles(root),
  };
}
async function runPrompt(
  r: Awaited<ReturnType<typeof runtime>>,
  prompt: string,
  existing?: Awaited<ReturnType<LocalStore['loadSession']>>,
  render = true,
  events?: WorkspaceEmit,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const backend = await createBackend(r, existing);
  let streamed = '';
  const emit: BackendEmit = (kind, value) => {
    if (kind === 'assistant') {
      streamed += String(value);
      events?.('assistant', String(value));
      if (render) process.stdout.write(String(value));
    } else if (kind === 'tool') {
      events?.('tool', String(value));
      if (render) ui.tool(String(value));
    } else if (kind === 'usage') {
      events?.('usage', value as any);
      const usage = value as { totalTokens?: number; estimatedCostUsd?: number } | undefined;
      if (render && usage)
        ui.info(
          `${(usage.totalTokens ?? 0).toLocaleString()} tokens · $${(
            usage.estimatedCostUsd ?? 0
          ).toFixed(4)} estimated`,
        );
    } else {
      events?.(kind === 'error' ? 'error' : 'status', String(value));
      if (render) (kind === 'error' ? ui.error : ui.info)(String(value));
    }
  };
  const onInterrupt = () => {
    void backend.cancel().finally(() => controller.abort());
  };
  process.once('SIGINT', onInterrupt);
  try {
    const activeSignal = signal ?? controller.signal;
    await backend.run(prompt, emit, activeSignal);
    const session = backend.session();
    if (!session) throw new Error('Backend completed without a session');
    const status = `Session ${session.id} (${session.checkpoint})`;
    if (render) ui.info(status);
    return render ? session : Object.assign(session, { __answer: streamed });
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted) {
      const status = 'Interrupted; session state was saved at the last completed tool checkpoint.';
      if (render) ui.error(status);
      else events?.('status', status);
      return backend.session() ?? existing;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    await backend.close();
  }
}

async function createBackend(
  r: Awaited<ReturnType<typeof runtime>>,
  existing?: Awaited<ReturnType<LocalStore['loadSession']>>,
): Promise<PromptBackend> {
  let backend: PromptBackend;
  if (r.config.provider === 'capy') {
    const projectId = r.config.providers.capy?.projectId;
    if (!projectId || !r.capy) throw new Error('Capy project and credentials are not configured');
    if (!program.opts().skipModelCheck) {
      const model = (await r.capy.models()).find(
        (item) => item.id === r.providerOptions.model && item.captainEligible,
      );
      if (!model)
        throw new Error(
          `Capy model "${r.providerOptions.model}" is unavailable or not Captain eligible.`,
        );
    }
    backend = new CapyRemoteBackend({
      client: r.capy,
      store: r.store,
      projectId,
      model: r.providerOptions.model,
    });
  } else {
    if (!r.provider) throw new Error('Local provider is not configured');
    const modelInfo = program.opts().skipModelCheck ? undefined : await r.provider.validateModel();
    backend = new LocalAgentBackend({
      store: r.store,
      createAgent: (agentSignal, emit) => {
        let streamed = false;
        return new Agent({
          provider: r.provider!,
          tools: r.tools,
          store: r.store,
          maxIterations: r.config.maxIterations,
          workspace: r.root,
          contextWindow: r.config.contextWindow,
          compressionThreshold: r.config.compressionThreshold,
          instructions: r.instructions,
          maxToolCalls: r.config.limits.maxToolCalls,
          maxCostUsd: r.config.limits.maxCostUsd,
          maxOutputChars: r.config.limits.maxOutputChars,
          modelInfo,
          onEvent: (kind, text, usage) => {
            if (kind === 'text') {
              streamed = true;
              emit('assistant', text);
            } else if (kind === 'assistant') {
              if (!streamed) emit('assistant', text);
            } else if (kind === 'tool' || kind === 'tool-result') emit('tool', text);
            else if (kind === 'usage') emit('usage', usage);
            else emit('status', text);
          },
          signal: agentSignal,
        });
      },
    });
  }
  if (existing) await backend.resume(existing);
  return backend;
}
async function ask(prompt: string, sessionId?: string) {
  const r = await runtime();
  try {
    return await runPrompt(r, prompt, sessionId ? await r.store.loadSession(sessionId) : undefined);
  } finally {
    await r.tools.close?.();
  }
}
async function runTui(screen: InteractiveScreen, needsSetup: boolean) {
  if (needsSetup && !(await setupProvider(false, screen))) return;
  let requestApproval: (action: string, detail: string) => Promise<boolean> = ui.approve;
  const approve = (action: string, detail: string) => requestApproval(action, detail);
  let r = await runtime({}, approve);
  let backend = await createBackend(r);
  const backendProxy: PromptBackend = {
    get provider() {
      return backend.provider;
    },
    run: (...args) => backend.run(...args),
    cancel: () => backend.cancel(),
    reset: () => backend.reset(),
    resume: (session) => backend.resume(session),
    status: () => backend.status(),
    session: () => backend.session(),
    close: () => backend.close(),
  };
  const replaceRuntime = async (
    overrides: Partial<KyokaoConfig>,
    options: {
      preserveCompatibleSession?: boolean;
      beforeSwap?: () => Promise<void>;
    } = {},
  ) => {
    const previous = r;
    const previousBackend = backend;
    const candidateProvider = overrides.provider ?? r.config.provider;
    if (!providerPresets[candidateProvider] && !r.config.providers[candidateProvider])
      throw new Error(`Unknown provider: ${candidateProvider}`);
    const session = options.preserveCompatibleSession ? backend.session() : undefined;
    const candidate = await runtime(
      { ...r.config, ...overrides, limits: { ...r.config.limits, ...overrides.limits } },
      approve,
    );
    let candidateBackend!: PromptBackend;
    try {
      candidateBackend = await createBackend(candidate, session);
      await options.beforeSwap?.();
    } catch (error) {
      await candidateBackend?.close().catch(() => {});
      await candidate.tools.close?.().catch(() => {});
      throw error;
    }
    try {
      await previousBackend.close();
      await previous.tools.close?.();
    } catch (error) {
      await candidateBackend.close().catch(() => {});
      await candidate.tools.close?.().catch(() => {});
      throw error;
    }
    r = candidate;
    backend = candidateBackend;
  };
  try {
    await terminalWorkspace({
      screen,
      backend: backendProxy,
      onApprovalHandler: (handler) => {
        requestApproval = handler;
      },
      onQueueChange: async (queue) => {
        const session = backend.session();
        if (!session) return;
        session.pendingPrompts = [...queue];
        await r.store.saveSession(session);
      },
      header: () => ({
        workspace:
          r.config.provider === 'capy'
            ? `remote:${r.config.providers.capy?.projectId ?? 'project-unset'}`
            : r.root.replace(process.env.HOME ?? process.env.USERPROFILE ?? '', '~'),
        provider: r.config.provider,
        model: r.config.model,
        approval: r.config.approval,
      }),
      onCommand: async (command, emit, control) => {
        const arg = command.args.join(' ');
        if (!command.name) return { messages: [{ kind: 'error', text: 'Unknown command.' }] };
        if (command.name === 'exit') {
          const state = control.scheduler();
          if (state.active || state.queue.length)
            return {
              messages: [
                {
                  kind: 'error',
                  text: `Work remains (${state.active ? 'active request' : ''}${state.active && state.queue.length ? ', ' : ''}${state.queue.length ? `${state.queue.length} queued` : ''}). Ctrl-C cancels active work; /queue clear removes pending prompts.`,
                },
              ],
            };
          return { close: true };
        }
        if (command.name === 'clear') return { clear: true };
        if (command.name === 'help') {
          const selected = command.args[0]?.replace(/^\//, '');
          const entries = selected
            ? workspaceCommands.filter((entry) => entry.name === selected)
            : workspaceCommands;
          return {
            messages: [
              {
                text: entries.length
                  ? entries.map((entry) => `${entry.syntax} — ${entry.description}`).join('\n')
                  : `Unknown command "${selected}".`,
              },
            ],
          };
        }
        if (command.name === 'new') {
          await control.reset();
          emit('usage', undefined);
          return {
            messages: [{ text: 'Cancelled work, cleared queue, and started a new session.' }],
          };
        }
        if (command.name === 'sessions') {
          const sessions = await r.store.listSessions();
          return {
            messages: [
              {
                text: sessions.length
                  ? sessions.map((s) => `${s.id}  ${s.updatedAt}  ${s.task ?? ''}`).join('\n')
                  : 'No saved sessions.',
              },
            ],
          };
        }
        if (command.name === 'resume') {
          if (command.args.length !== 1)
            return { messages: [{ kind: 'error', text: 'Usage: /resume <session-id>' }] };
          const session = await r.store.loadSession(command.args[0]!);
          const pendingPrompts = [...(session.pendingPrompts ?? [])];
          const candidateBackend = await createBackend(r, session);
          const previousBackend = backend;
          try {
            await control.reset();
          } catch (error) {
            await candidateBackend.close().catch(() => {});
            throw error;
          }
          try {
            await previousBackend.close();
          } catch (error) {
            await candidateBackend.close().catch(() => {});
            throw error;
          }
          backend = candidateBackend;
          for (const prompt of pendingPrompts) await control.enqueue(prompt);
          emit('usage', session.usage);
          return { messages: [{ text: `Resumed session ${session.id}.` }] };
        }
        if (command.name === 'model') {
          if (!arg) return { messages: [{ text: `Active model: ${r.config.model}` }] };
          await replaceRuntime(
            { model: arg },
            {
              beforeSwap: () => control.reset(),
            },
          );
          return {
            messages: [{ text: `Active model changed to ${r.config.model}; context was reset.` }],
          };
        }
        if (command.name === 'provider') {
          if (!arg) return { messages: [{ text: `Active provider: ${r.config.provider}` }] };
          try {
            await replaceRuntime(
              { provider: arg },
              {
                beforeSwap: () => control.reset(),
              },
            );
          } catch (error) {
            return {
              messages: [
                { kind: 'error', text: error instanceof Error ? error.message : String(error) },
              ],
            };
          }
          return {
            messages: [
              {
                text: `Active provider changed to ${r.config.provider}; incompatible context was reset.`,
              },
            ],
          };
        }
        if (command.name === 'approval') {
          if (!arg) return { messages: [{ text: `Approval mode: ${r.config.approval}` }] };
          if (!['suggest', 'auto-edit', 'full-auto'].includes(arg))
            return {
              messages: [{ kind: 'error', text: 'Usage: /approval <suggest|auto-edit|full-auto>' }],
            };
          const scheduler = control.scheduler();
          if (
            scheduler.active ||
            scheduler.phase === 'stopping' ||
            scheduler.phase === 'starting-replacement'
          )
            return {
              messages: [
                {
                  kind: 'error',
                  text: 'Wait for or cancel the active request before changing approval mode.',
                },
              ],
            };
          await replaceRuntime(
            { approval: arg as KyokaoConfig['approval'] },
            { preserveCompatibleSession: true },
          );
          return { messages: [{ text: `Approval mode changed to ${r.config.approval}.` }] };
        }
        if (command.name === 'memory') {
          const [operation, key, ...value] = command.args;
          if (!operation || operation === 'list')
            return { messages: [{ text: JSON.stringify(await r.store.getMemory(), null, 2) }] };
          if (operation === 'set' && key && value.length) {
            await r.store.setMemory(key, value.join(' '));
            return { messages: [{ text: `Saved memory "${key}".` }] };
          }
          if (operation === 'delete' && key) {
            await r.store.deleteMemory(key);
            return { messages: [{ text: `Deleted memory "${key}".` }] };
          }
          return {
            messages: [
              { kind: 'error', text: 'Usage: /memory [list|set <key> <value>|delete <key>]' },
            ],
          };
        }
        if (command.name === 'doctor') {
          if (r.config.provider === 'capy') {
            const models = await r.capy!.models();
            const projects = await r.capy!.projects();
            const projectId = r.config.providers.capy?.projectId;
            const model = models.find((item) => item.id === r.config.model && item.captainEligible);
            const project = projects.find((item) => item.id === projectId);
            return {
              messages: [
                {
                  text: `provider: capy (${r.capy!.baseURL})\ncredentials: ${r.providerOptions.apiKey ? 'configured' : 'missing'}\nmodel: ${model ? `${model.id} (Captain eligible)` : 'unavailable'}\nproject: ${project ? `${project.name} (${project.id})` : 'unavailable'}\nexecution: remote connected repositories/VMs; local uncommitted files are not used`,
                },
              ],
            };
          }
          const model = program.opts().skipModelCheck
            ? undefined
            : await r.provider!.validateModel();
          return {
            messages: [
              {
                text: `node: ${process.version}\nworkspace: ${r.root}\nprovider: ${r.config.provider} (${r.provider!.options.baseURL})\ncredentials: ${r.provider!.options.apiKey ? 'configured' : 'missing'}\nmodel: ${model?.id ?? 'not checked'}\nsandbox: enabled`,
              },
            ],
          };
        }
        if (command.name === 'diff') {
          if (r.config.provider === 'capy')
            return {
              messages: [
                {
                  kind: 'error',
                  text: 'Capy edits remote connected repositories/VMs; inspect remote task or PR links with /capy.',
                },
              ],
            };
          const result = await r.tools.execute('git', { args: ['diff', '--no-ext-diff'] });
          emit(result.isError ? 'error' : 'tool', result.content || 'Working tree is clean.');
          return;
        }
        if (command.name === 'queue') {
          if (command.args[0] === 'clear') {
            const cleared = await control.clearQueue();
            return { messages: [{ text: `Cleared ${cleared} queued prompt(s).` }] };
          }
          if (command.args[0] === 'retry') {
            await control.retryQueue();
            return { messages: [{ text: 'Retrying queued prompt.' }] };
          }
          const queue = control.scheduler().queue;
          return {
            messages: [
              {
                text: queue.length
                  ? queue.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')
                  : 'Queue is empty.',
              },
            ],
          };
        }
        if (command.name === 'capy') {
          if (r.config.provider !== 'capy')
            return { messages: [{ kind: 'error', text: 'Capy provider is not active.' }] };
          const status = backend.status();
          return {
            messages: [
              {
                text: [
                  `project: ${status.projectId}`,
                  `thread: ${status.threadId ?? 'not created'}`,
                  `run state: ${status.state}`,
                  ...(status.waitingOn?.length
                    ? [`waiting on: ${status.waitingOn.join(', ')}`]
                    : []),
                  ...(status.blockedOn?.length
                    ? [`blocked on: ${status.blockedOn.join(', ')}`]
                    : []),
                  ...(status.tasks ?? []).map(
                    (task) => `task: ${task.identifier} ${task.status} ${task.title}`,
                  ),
                  ...(status.pullRequests ?? []).map(
                    (pull) => `PR: ${pull.repoFullName}#${pull.number} ${pull.url}`,
                  ),
                ].join('\n'),
              },
            ],
          };
        }
      },
    });
  } finally {
    await r.tools.close?.();
  }
  const session = backend.session();
  return session
    ? {
        id: session.id,
        usage: session.usage,
      }
    : undefined;
}
async function tui() {
  const needsSetup = await needsProviderSetup();
  const session = await withInteractiveScreen({}, async (screen) => {
    return await runTui(screen, needsSetup);
  });
  if (session)
    console.log(`Session ${session.id} · resume: kyokao resume ${session.id} "continue"`);
}
program.argument('[prompt...]', 'task for the agent').action(async (parts: string[]) => {
  if (parts.length) await ask(parts.join(' '));
  else if (process.stdin.isTTY) await tui();
  else {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c);
    await ask(Buffer.concat(chunks).toString().trim());
  }
});
program.command('chat').description('Start the interactive terminal workspace').action(tui);
program
  .command('edit <path>')
  .description('Open a workspace file in the configured editor')
  .action(async (path: string) => {
    const config = await loadConfig({ cli: cliConfig() });
    const file = await new WorkspaceSandbox(process.cwd()).path(path);
    const configured = config.editor || process.env.VISUAL || process.env.EDITOR;
    const command = configured || (process.platform === 'win32' ? 'notepad' : 'vi');
    const parts =
      command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(['"])|(['"])$/g, '')) ??
      [];
    const executable = parts.shift();
    if (!executable) throw new Error('Editor command is empty');
    const args = [...parts, ...config.editorArgs];
    if (args.includes('{file}')) {
      for (let i = 0; i < args.length; i++) if (args[i] === '{file}') args[i] = file;
    } else args.push(file);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: 'inherit', cwd: process.cwd() });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code ?? 'unknown'}`)),
      );
    });
  });
program.command('tui').description('Start the interactive terminal workspace').action(tui);
program
  .command('models')
  .description('List models from the selected provider')
  .action(async () => {
    const r = await runtime();
    if (r.capy) {
      for (const model of (await r.capy.models()).filter((model) => model.captainEligible))
        console.log(`${model.id}\t${model.name}\t${model.provider}`);
    } else for (const m of await r.provider!.models()) console.log(m);
  });
program
  .command('catalog')
  .description('Show known model capabilities and pricing')
  .action(() => {
    for (const model of builtInModelCatalog)
      console.log(
        `${model.id}\t${model.contextWindow ?? '?'} ctx\t` +
          `${model.inputCostPerMillion === undefined ? 'provider pricing' : `$${model.inputCostPerMillion}/$${model.outputCostPerMillion} per 1M tokens`}\t` +
          `${model.supportsTools === false ? 'no tools' : 'tools'}`,
      );
  });
program
  .command('usage [id]')
  .description('Show token and estimated cost usage for a session')
  .action(async (id?: string) => {
    const r = await runtime();
    try {
      const sessions = id ? [await r.store.loadSession(id)] : await r.store.listSessions();
      for (const session of sessions) {
        const usage = session.usage;
        if (!usage) continue;
        console.log(
          `${session.id}\t${usage.totalTokens.toLocaleString()} tokens\t` +
            `$${usage.estimatedCostUsd.toFixed(4)}\t${usage.compressedMessages} compressed`,
        );
      }
    } finally {
      await r.tools.close?.();
    }
  });
program
  .command('plugins')
  .description('List configured plugins')
  .action(async () => {
    const r = await runtime();
    try {
      for (const plugin of r.config.plugins) console.log(plugin);
    } finally {
      await r.tools.close?.();
    }
  });
program
  .command('mcp')
  .description('List configured MCP servers')
  .action(async () => {
    const r = await runtime();
    try {
      for (const [name, server] of Object.entries(r.config.mcp))
        console.log(`${name}\t${server.command} ${(server.args ?? []).join(' ')}`.trim());
    } finally {
      await r.tools.close?.();
    }
  });
program
  .command('providers')
  .description('List built-in provider presets')
  .action(() => {
    for (const [name, p] of Object.entries(providerPresets)) console.log(`${name}\t${p.baseURL}`);
  });
const config = program.command('config').description('Inspect or manage non-secret configuration');
config
  .command('show')
  .action(async () =>
    console.log(JSON.stringify(redact(await loadConfig({ cli: cliConfig() })), null, 2)),
  );
config.command('path').action(() => console.log(globalConfigPath()));
config
  .command('setup')
  .description('Run the interactive provider setup')
  .action(async () => {
    if (!(await setupProvider(Boolean((await readConfig(globalConfigPath())).provider))))
      process.exitCode = 1;
  });
config
  .command('export <file>')
  .description('Export redacted resolved configuration')
  .action(async (file) => atomicWrite(file, redact(await loadConfig({ cli: cliConfig() }))));
const sessions = program.command('sessions').description('List local sessions');
sessions.action(async () => {
  const r = await runtime();
  for (const s of await r.store.listSessions())
    console.log(`${s.id}\t${s.updatedAt}\t${s.checkpoint ?? ''}\t${s.task ?? ''}`);
});
program
  .command('resume <id> <prompt...>')
  .description('Resume a session with a follow-up')
  .action(async (id, p) => {
    await ask(p.join(' '), id);
  });
const memory = program.command('memory').description('Manage persistent local memory');
memory
  .command('list')
  .action(async () =>
    console.log(JSON.stringify(await (await runtime()).store.getMemory(), null, 2)),
  );
memory.command('set <key> <value>').action(async (k, v) => {
  await (await runtime()).store.setMemory(k, v);
});
memory.command('delete <key>').action(async (k) => {
  await (await runtime()).store.deleteMemory(k);
});
program
  .command('doctor')
  .description('Check local setup without revealing secrets')
  .action(async () => {
    const r = await runtime();
    console.log(`node: ${process.version}`);
    console.log(`workspace: ${r.root}`);
    console.log(
      `provider: ${r.config.provider} (${r.capy?.baseURL ?? r.provider!.options.baseURL})`,
    );
    console.log(
      `credentials: ${r.providerOptions.apiKey ? 'configured' : 'missing (set provider environment key or --api-key)'}`,
    );
    if (r.capy) {
      const [models, projects] = await Promise.all([r.capy.models(), r.capy.projects()]);
      const model = models.find(
        (item) => item.id === r.providerOptions.model && item.captainEligible,
      );
      const projectId = r.config.providers.capy?.projectId;
      const project = projects.find((item) => item.id === projectId);
      if (!model)
        throw new Error(`Capy model "${r.providerOptions.model}" is not Captain eligible`);
      if (!project) throw new Error(`Capy project "${projectId}" is not accessible`);
      console.log(`model: ${model.id} (Captain eligible)`);
      console.log(`project: ${project.name} (${project.id})`);
      console.log(
        'execution: remote connected repositories/VMs; local uncommitted files are not used',
      );
    } else {
      console.log('sandbox: enabled');
      if (!program.opts().skipModelCheck) {
        const model = await r.provider!.validateModel();
        console.log(`model: ${model.id} (available)`);
      }
    }
    await r.tools.close?.();
  });
program
  .command('diff')
  .description('Show working-tree diff')
  .action(async () => {
    const r = await runtime();
    const v = await r.tools.execute('git', { args: ['diff', '--no-ext-diff'] });
    ui.diff(v.content);
  });
for (const [name, instruction] of Object.entries({
  commit:
    'Review the working tree, run appropriate checks, then create a clear git commit if changes are ready.',
  explain: 'Explain the repository structure and the relevant implementation details.',
  test: 'Run the most relevant tests, diagnose and fix failures if safe.',
  review: 'Review the current changes for bugs, security risks, and missing tests.',
}))
  program
    .command(`${name} [prompt...]`)
    .description(`Agent-assisted ${name}`)
    .action(async (p: string[]) => {
      await ask(`${instruction}${p.length ? `\nUser context: ${p.join(' ')}` : ''}`);
    });
program.parseAsync().catch((e) => {
  ui.error(e.message);
  process.exitCode = 1;
});
