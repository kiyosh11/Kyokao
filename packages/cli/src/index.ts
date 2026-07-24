#!/usr/bin/env node
// @ts-nocheck
import { Command } from 'commander';
import { loadConfig } from '@kyokao/config';
import { modelCatalog } from '@kyokao/providers';
import { terminalWorkspace, withInteractiveScreen, createThemeContext, createUi } from '@kyokao/ui';
import { buildRuntime, createBackend as createBackendFor, runPrompt } from './runtime.js';
import { runHeadless, resolveOutputFormat } from './headless.js';
import { needsProviderSetup, setupProvider } from './setup.js';
import { createGroupedHelp } from './help.js';
import { registerCommands } from './commands.js';
import { handleTuiCommand } from './tui-commands.js';
import { buildCommandPalette } from './tui-palette.js';
import { editDraftInExternalEditor } from './tui-context.js';
const program = new Command();
program
  .name('kyokao')
  .description('Kyokao: local and Capy remote coding agents')
  .version('0.8.0')
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
  .option('--editor <command>', 'editor command for the edit command')
  .option(
    '--output-format <format>',
    'headless output format: plain (human text), json (single aggregated object), or streaming-json (one NDJSON line per event)',
  )
  .option(
    '--subagents',
    'enable the spawn_subagent tool so the agent can delegate scoped sub-tasks to isolated sub-agents (off by default)',
  );
program
  .option('--theme <name>', 'TUI theme')
  .option('--code-theme <name>', 'code and Markdown theme');
function cliConfig() {
  const o = program.opts();
  return {
    theme: o.theme,
    codeTheme: o.codeTheme,
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
    ...(o.subagents ? { subagents: { enabled: true } } : {}),
  };
}
async function runtime(overrides = {}, approve) {
  const loaded = await loadConfig({ cli: cliConfig(), profile: program.opts().profile });
  const config = {
    ...loaded,
    ...overrides,
    limits: { ...loaded.limits, ...(overrides.limits ?? {}) },
    providers: { ...loaded.providers, ...(overrides.providers ?? {}) },
  };
  return buildRuntime(config, approve);
}
async function ask(prompt, sessionId) {
  const r = await runtime();
  try {
    return await runPrompt(
      r,
      prompt,
      sessionId ? await r.store.loadSession(sessionId) : undefined,
      true,
      undefined,
      undefined,
      !!program.opts().skipModelCheck,
    );
  } finally {
    await r.tools.close?.();
  }
}
async function runTui(screen, needsSetup) {
  const options = program.opts();
  const themeContext = createThemeContext({
    tuiTheme: options.theme ?? process.env.KYOKAO_THEME,
    codeTheme: options.codeTheme ?? process.env.KYOKAO_CODE_THEME,
    isTTY: screen.output.isTTY,
    env: process.env,
  });
  if (needsSetup && !(await setupProvider(false, screen, themeContext))) return;
  let requestApproval = createUi(themeContext).approve;
  const approve = (action, detail) => requestApproval(action, detail);
  let r = await runtime({}, approve);
  themeContext.setTuiTheme(r.config.theme);
  themeContext.setCodeTheme(r.config.codeTheme);
  const skipModelCheck = !!program.opts().skipModelCheck;
  // Keep the TUI reachable when a provider retires the saved model. The model
  // palette itself uses the validated live list, and newly selected models are
  // checked during the runtime swap.
  let backend = await createBackendFor(r, undefined, true);
  const backendProxy = {
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
  const replaceRuntime = async (overrides, opts = {}) => {
    const previous = r;
    const previousBackend = backend;
    const candidateProvider = overrides.provider ?? r.config.provider;
    if (!previous.config.providers[candidateProvider]) {
      // providerPresets is checked inside runtime() via loadConfig
    }
    const session = opts.preserveCompatibleSession ? backend.session() : undefined;
    const candidate = await runtime(
      { ...r.config, ...overrides, limits: { ...r.config.limits, ...overrides.limits } },
      approve,
    );
    let candidateBackend;
    try {
      candidateBackend = await createBackendFor(candidate, session, skipModelCheck);
      await opts.beforeSwap?.();
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
  let sessionChoices = await r.store.listSessions();
  let memoryChoices = await r.store.getMemory();
  let providerModels = [];
  let modelContextWindow = modelCatalog.find(
    (model) => model.id === r.providerOptions.model,
  )?.contextWindow;
  let capyAvailableModels = [];
  let capyThreadChoices = [];
  let capySpending;
  let capySpendingError;
  let capySpendingRuntime;
  let capySpendingExpiresAt = 0;
  const refreshProviderModels = async () => {
    const current = r;
    try {
      const signal = AbortSignal.timeout(3_000);
      if (current.capy) {
        const models = await current.capy.models(signal);
        if (r === current) {
          capyAvailableModels = models;
          providerModels = models.filter((model) => model.captainEligible).map((model) => model.id);
          modelContextWindow = modelCatalog.find(
            (model) => model.id === current.providerOptions.model,
          )?.contextWindow;
        }
      } else {
        const models = await current.provider.models(signal);
        const modelInfo = await current.provider.validateModel();
        if (r === current) {
          capyAvailableModels = [];
          providerModels = models;
          modelContextWindow =
            modelInfo.contextWindow ??
            modelCatalog.find((model) => model.id === current.providerOptions.model)?.contextWindow;
        }
      }
    } catch {
      if (r === current) {
        capyAvailableModels = [];
        providerModels = [];
        modelContextWindow = modelCatalog.find(
          (model) => model.id === current.providerOptions.model,
        )?.contextWindow;
      }
    }
  };
  const refreshCapyThreads = async () => {
    const current = r;
    const projectId = current.config.providers.capy?.projectId;
    if (current.config.provider !== 'capy' || !current.capy || !projectId) {
      if (r === current) capyThreadChoices = [];
      return;
    }
    try {
      const threads = await current.capy.listThreads(
        { projectId, limit: 50 },
        AbortSignal.timeout(10_000),
      );
      if (r === current) capyThreadChoices = threads;
    } catch {
      if (r === current) capyThreadChoices = [];
    }
  };
  const refreshCapySpending = async (force = false) => {
    const current = r;
    const projectId = current.config.providers.capy?.projectId;
    if (current.config.provider !== 'capy' || !current.capy || !projectId) {
      if (r === current) {
        capySpending = undefined;
        capySpendingError = undefined;
      }
      return;
    }
    if (!force && capySpendingRuntime === current && capySpendingExpiresAt > Date.now()) return;
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    try {
      const usage = await current.capy.getUsage(
        {
          orgId: 'me',
          from,
          to: now.toISOString(),
          routed: 'paid',
          projectIds: projectId,
          pageSize: 1,
        },
        AbortSignal.timeout(10_000),
      );
      if (r === current) {
        capySpending = {
          ...usage.totals,
          from: usage.from,
          to: usage.to,
        };
        capySpendingError = undefined;
        capySpendingRuntime = current;
        capySpendingExpiresAt = Date.now() + 15_000;
      }
    } catch (error) {
      if (r === current) {
        capySpending = undefined;
        capySpendingError = error instanceof Error ? error.message : String(error);
        capySpendingRuntime = current;
        capySpendingExpiresAt =
          error && typeof error === 'object' && [401, 403].includes(Number(error.status))
            ? Number.POSITIVE_INFINITY
            : Date.now() + 30_000;
      }
    }
  };
  if (r.config.provider === 'capy')
    await Promise.all([refreshProviderModels(), refreshCapyThreads(), refreshCapySpending()]);
  else {
    void refreshProviderModels();
    await refreshCapyThreads();
  }
  // The shared context object: its fields are reassigned by replaceRuntime
  // and the extracted handlers, so they read/write through this object.
  const ctx = {
    get r() {
      return r;
    },
    get backend() {
      return backend;
    },
    set backend(value) {
      backend = value;
    },
    themeContext,
    get sessionChoices() {
      return sessionChoices;
    },
    set sessionChoices(value) {
      sessionChoices = value;
    },
    get memoryChoices() {
      return memoryChoices;
    },
    set memoryChoices(value) {
      memoryChoices = value;
    },
    get providerModels() {
      return providerModels;
    },
    get modelContextWindow() {
      return modelContextWindow;
    },
    get capyThreadChoices() {
      return capyThreadChoices;
    },
    get capyAvailableModels() {
      return capyAvailableModels;
    },
    set capyAvailableModels(value) {
      capyAvailableModels = value;
    },
    get capySpending() {
      return capySpending;
    },
    get capySpendingError() {
      return capySpendingError;
    },
    replaceRuntime,
    refreshProviderModels,
    refreshCapyThreads,
    refreshCapySpending,
    skipModelCheck,
    projectChoices: [],
    capyModelChoices: [],
    capyModelRole: undefined,
  };
  try {
    await terminalWorkspace({
      screen,
      themeContext,
      initialDraft: capyThreadChoices.length ? '/resume ' : undefined,
      backend: backendProxy,
      onApprovalHandler: (handler) => {
        requestApproval = handler;
      },
      onQueueChange: async (queue) => {
        const session = backend.session();
        if (!session) return;
        session.pendingPrompts = [...queue];
        await r.store.saveSession(session);
        sessionChoices = [
          session,
          ...sessionChoices.filter((candidate) => candidate.id !== session.id),
        ];
      },
      onSessionChange: async () => {
        sessionChoices = await r.store.listSessions();
        await refreshCapySpending();
      },
      commandPalette: (value) => buildCommandPalette(value, ctx),
      header: () => ({
        workspace:
          r.config.provider === 'capy'
            ? `remote:${r.config.providers.capy?.projectId ?? 'project-unset'}`
            : r.root.replace(process.env.HOME ?? process.env.USERPROFILE ?? '', '~'),
        provider: r.config.provider,
        model: r.config.model,
        buildModel: r.config.provider === 'capy' ? r.config.providers.capy?.buildModel : undefined,
        spendingUsd: r.config.provider === 'capy' ? capySpending?.totalDollars : undefined,
        spendingLabel: r.config.provider === 'capy' ? 'project MTD' : undefined,
        approval: r.config.approval,
      }),
      sessionTitle: () => backend.session()?.task ?? '',
      sessionPlan: () => backend.session()?.plan ?? [],
      contextWindow: () => modelContextWindow,
      contextTokens: () => {
        const messages = backend.session()?.messages;
        if (!messages?.length) return 0;
        return Math.ceil(
          messages.reduce(
            (total, m) =>
              total +
              (m.content?.length ?? 0) +
              (m.role === 'assistant' ? (m.reasoning_content?.length ?? 0) : 0) +
              m.role.length +
              8,
            0,
          ) / 4,
        );
      },
      showThinking: () => r.config.tui.showThinking,
      deleteSession: async (id) => {
        // The palette passes a 1-based index; resolve it to the real session ID.
        const realId = /^\d+$/.test(id) ? sessionChoices[parseInt(id, 10) - 1]?.id : id;
        const selected = realId
          ? sessionChoices.find((candidate) => candidate.id === realId)
          : undefined;
        if (!realId || !selected) return;
        const approved = await approve(
          'Delete saved session',
          `${selected.task?.trim() || selected.id}\n${selected.id}\nThis cannot be undone.`,
        );
        if (!approved) return;
        const active = backend.session()?.id === realId;
        if (active) await backend.reset();
        await r.store.deleteSession(realId);
        sessionChoices = await r.store.listSessions();
        return active;
      },
      openExternalEditor: (draft) => editDraftInExternalEditor(r.config, draft),
      onCommand: async (command, emit, control) => handleTuiCommand(command, emit, control, ctx),
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
  const opts = program.opts();
  const needsSetup = await needsProviderSetup({
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    profile: opts.profile,
  });
  const session = await withInteractiveScreen({}, async (screen) => {
    return await runTui(screen, needsSetup);
  });
  if (session)
    console.log(`Session ${session.id} · resume: ${process.argv[1]} session resume ${session.id}`);
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString().trim();
}
// Grouped help: the restructured command tree needs section headers, otherwise
// `--help` gets worse with noun-verb subcommands (Commander prints each group
// parent as a single row, hiding the leaves). Override createHelp so the
// GroupedHelp subclass is used for both `--help` and error output.
program.createHelp = createGroupedHelp;
registerCommands({
  program,
  runtime,
  ask,
  tui,
  setupProvider,
  cliConfig,
  opts: () => program.opts(),
  createBackendFor,
  runHeadless,
  resolveOutputFormat,
  readStdin,
});
program.parseAsync().catch((error) => {
  createUi(createThemeContext()).error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
