// @ts-nocheck
import { kyokaoHome, loadConfig, resolveProvider, type KyokaoConfig } from '@kyokao/config';
import {
  CapyClient,
  CapyProviderAdapter,
  OpenAICompatibleProvider,
  type Provider,
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
  SubAgentTools,
  loadInstructionFiles,
  type BackendEmit,
  type PromptBackend,
} from '@kyokao/agent';
import {
  createThemeContext,
  createUi,
  MarkdownStreamRenderer,
  type WorkspaceEmit,
} from '@kyokao/ui';
import type { LocalStore as LocalStoreType } from '@kyokao/memory';
import type { Session } from '@kyokao/memory';

export interface Runtime {
  config: KyokaoConfig;
  store: LocalStoreType;
  provider: Provider;
  capy: CapyClient | undefined;
  providerOptions: ReturnType<typeof resolveProvider>;
  tools: CompositeTools;
  root: string;
  core: CoreTools;
  instructions: string;
  renderer: ReturnType<typeof createUi>;
  themeContext: ReturnType<typeof createThemeContext>;
}

export type Approve = (action: string, detail: string) => Promise<boolean>;

export async function buildRuntime(config: KyokaoConfig, approve?: Approve): Promise<Runtime> {
  const p = resolveProvider(config);
  const themeContext = createThemeContext({
    tuiTheme: config.theme,
    codeTheme: config.codeTheme,
    isTTY: process.stdout.isTTY,
    env: process.env,
  });
  const renderer = createUi(themeContext);
  const root = process.cwd();
  const home = kyokaoHome();
  const store = new LocalStore(home);
  const core = new CoreTools(
    new WorkspaceSandbox(root),
    config.approval,
    approve ?? renderer.approve,
    {
      maxShellTimeoutMs: config.limits.maxShellTimeoutMs,
      maxOutputChars: config.limits.maxOutputChars,
      maxFileBytes: config.limits.maxFileBytes,
      allowedHosts: config.limits.allowedHosts,
    },
  );
  const plugins = await loadPlugins(config.plugins, root);
  let mcp;
  try {
    mcp = await connectMcp(config.mcp, root);
  } catch (error) {
    await Promise.allSettled(plugins.map((plugin) => plugin.close?.()));
    throw error;
  }
  const capy =
    config.provider === 'capy'
      ? new CapyClient({ baseURL: p.baseURL, apiKey: p.apiKey })
      : undefined;

  const provider: Provider =
    config.provider === 'capy'
      ? new CapyProviderAdapter(capy!, {
          baseURL: p.baseURL,
          apiKey: p.apiKey,
          model: p.model,
          fallbackModels: p.fallbackModels,
        })
      : new OpenAICompatibleProvider(p);
  const instructions = await loadInstructionFiles(root, home);

  const subagentExecutors =
    config.subagents.enabled && config.provider !== 'capy'
      ? [
          new SubAgentTools({
            workspace: root,
            store,
            provider: provider as OpenAICompatibleProvider,
            tools: core,
            instructions,
          }),
        ]
      : [];
  const tools = new CompositeTools([core, ...plugins, ...subagentExecutors, ...(mcp ? [mcp] : [])]);
  return {
    config,
    store,
    provider,
    capy,
    providerOptions: p,
    tools,
    root,
    core,
    instructions,
    renderer,
    themeContext,
  };
}

export async function createBackend(
  r: Runtime,
  existing: Session | undefined,
  skipModelCheck: boolean,
): Promise<PromptBackend> {
  let backend: PromptBackend;
  if (r.config.provider === 'capy') {
    const projectId = r.config.providers.capy?.projectId;
    if (!projectId || !r.capy) throw new Error('Capy project and credentials are not configured');
    if (!skipModelCheck) await r.provider.validateModel();
    const capyConfig = r.config.providers.capy ?? {};
    backend = new CapyRemoteBackend({
      client: r.capy,
      store: r.store,
      workspace: r.root,
      projectId,
      model: r.providerOptions.model,
      threadDefaults: {
        ...(capyConfig.speed ? { speed: capyConfig.speed } : {}),
        ...(capyConfig.buildModel ? { buildModel: capyConfig.buildModel } : {}),
        ...(capyConfig.buildSpeed ? { buildSpeed: capyConfig.buildSpeed } : {}),
        ...(capyConfig.repos?.length ? { repos: capyConfig.repos } : {}),
        ...(capyConfig.tags?.length ? { tags: capyConfig.tags } : {}),
      },
    });
  } else {
    const modelInfo = skipModelCheck ? undefined : await r.provider.validateModel();
    backend = new LocalAgentBackend({
      store: r.store,
      workspace: r.root,
      createAgent: (agentSignal, emit) => {
        let streamed = false;
        return new Agent({
          provider: r.provider as OpenAICompatibleProvider,
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
            } else if (kind === 'reasoning') {
              emit('reasoning', text);
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

export async function runPrompt(
  r: Runtime,
  prompt: string,
  existing: Session | undefined,
  render: boolean,
  events: WorkspaceEmit | undefined,
  signal: AbortSignal | undefined,
  skipModelCheck: boolean,
): Promise<Session | undefined> {
  const controller = new AbortController();
  const backend = await createBackend(r, existing, skipModelCheck);
  let streamed = '';
  const assistantStream = render ? new MarkdownStreamRenderer(r.themeContext) : undefined;
  let assistantStreamEnded = false;
  const finishAssistantStream = () => {
    if (!assistantStream || assistantStreamEnded) return;
    process.stdout.write(assistantStream.end());
    if (streamed && !streamed.endsWith('\n')) process.stdout.write('\n');
    assistantStreamEnded = true;
  };
  const emit: BackendEmit = (kind, value) => {
    if (kind === 'assistant') {
      streamed += String(value);
      events?.('assistant', String(value));
      if (assistantStream) process.stdout.write(assistantStream.write(String(value)));
    } else if (kind === 'reasoning') {
      events?.('reasoning', String(value));
    } else if (kind === 'tool') {
      events?.('tool', String(value));
      if (render) r.renderer.tool(String(value));
    } else if (kind === 'usage') {
      events?.('usage', value as any);
      const usage = value as { totalTokens?: number; estimatedCostUsd?: number } | undefined;
      if (render && usage)
        r.renderer.info(
          `${(usage.totalTokens ?? 0).toLocaleString()} tokens · $${(
            usage.estimatedCostUsd ?? 0
          ).toFixed(4)} estimated`,
        );
    } else {
      events?.(kind === 'error' ? 'error' : 'status', String(value));
      if (render) (kind === 'error' ? r.renderer.error : r.renderer.info)(String(value));
    }
  };
  const onInterrupt = () => {
    void backend.cancel().finally(() => controller.abort());
  };
  process.once('SIGINT', onInterrupt);
  try {
    const activeSignal = signal ?? controller.signal;
    await backend.run(prompt, emit, activeSignal);
    finishAssistantStream();
    const session = backend.session();
    if (!session) throw new Error('Backend completed without a session');
    const status = `Session ${session.id} (${session.checkpoint})`;
    if (render) r.renderer.info(status);
    return render ? session : Object.assign(session, { __answer: streamed });
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted) {
      const status = 'Interrupted; session state was saved at the last completed tool checkpoint.';
      if (render) r.renderer.error(status);
      else events?.('status', status);
      return backend.session() ?? existing;
    }
    throw error;
  } finally {
    finishAssistantStream();
    process.removeListener('SIGINT', onInterrupt);
    await backend.close();
  }
}

export type { LocalStore, Session, BackendEmit, PromptBackend };
export { loadConfig };
export type { KyokaoConfig };
