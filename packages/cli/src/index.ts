#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  loadConfig,
  readConfig,
  redact,
  resolveProvider,
  providerPresets,
  atomicWrite,
  globalConfigPath,
  type KyokaoConfig,
} from '@kyokao/config';
import { OpenAICompatibleProvider, modelCatalog as builtInModelCatalog } from '@kyokao/providers';
import {
  WorkspaceSandbox,
  CoreTools,
  CompositeTools,
  connectMcp,
  loadPlugins,
} from '@kyokao/tools';
import { LocalStore } from '@kyokao/memory';
import { Agent, loadInstructionFiles } from '@kyokao/agent';
import { terminalWorkspace, ui, workspaceCommands, type WorkspaceEmit } from '@kyokao/ui';
const program = new Command();
program
  .name('kyokao')
  .description('Kyokao: a safe, local-first coding agent')
  .version('0.2.0')
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
async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('API key setup requires an interactive terminal');
  process.stdout.write(prompt);
  const previousRaw = process.stdin.isRaw;
  const previousEncoding = process.stdin.readableEncoding;
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(previousRaw ?? false);
      if (previousEncoding) process.stdin.setEncoding(previousEncoding);
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('API key setup cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}
async function setupProvider(current: KyokaoConfig): Promise<void> {
  const configuredProviders = Object.keys(current.providers);
  const names = [...new Set([...Object.keys(providerPresets), ...configuredProviders])];
  const line = createInterface({ input: process.stdin, output: process.stdout });
  console.clear();
  console.log('\n  KYOKAO SETUP\n');
  console.log('  Choose a provider for your default workspace:\n');
  names.forEach((name, index) => {
    const preset = providerPresets[name];
    const mode = preset && ['ollama', 'lmstudio', 'vllm'].includes(name) ? 'local' : 'API key';
    console.log(`  ${String(index + 1).padStart(2, ' ')}. ${name.padEnd(12)} ${mode}`);
  });
  const choice = await line.question(
    `\n  Provider [1-${names.length}] (default ${current.provider}): `,
  );
  const parsed = Number(choice);
  const provider =
    names[Number.isInteger(parsed) && parsed >= 1 && parsed <= names.length ? parsed - 1 : 0] ??
    current.provider;
  const model = (
    await line.question(
      `  Model ID (default ${current.model}; run "kyokao models" later to inspect): `,
    )
  ).trim();
  line.close();
  const preset = providerPresets[provider];
  const existingKey = current.providers[provider]?.apiKey;
  const environmentKey = preset?.env ? process.env[preset.env] : undefined;
  const local = ['ollama', 'lmstudio', 'vllm'].includes(provider);
  let apiKey = existingKey;
  if (!local && !existingKey && !environmentKey)
    apiKey = await promptSecret(`  ${preset?.env ?? 'API'} key (hidden): `);
  console.log(
    local
      ? `\n  ${provider} uses a local server; no API key will be saved.`
      : environmentKey
        ? `\n  Using the existing ${preset?.env} environment variable; the key will not be saved.`
        : '\n  Browser login is only offered for providers with an explicit supported OAuth flow; these presets use API keys.',
  );
  const saved = await readConfig(globalConfigPath());
  const providers = { ...saved.providers, [provider]: { ...saved.providers?.[provider] } };
  if (apiKey) providers[provider] = { ...providers[provider], apiKey };
  else delete providers[provider]?.apiKey;
  await atomicWrite(globalConfigPath(), {
    ...saved,
    provider,
    model: model || current.model,
    providers,
  });
  console.log(`  Saved provider setup to ${globalConfigPath()}\n`);
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
    provider: new OpenAICompatibleProvider(p),
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
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    const modelInfo = program.opts().skipModelCheck ? undefined : await r.provider.validateModel();
    let streamed = '';
    const agent = new Agent({
      provider: r.provider,
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
      onEvent: (k, t) => {
        if (k === 'text') {
          streamed += t;
          events?.('assistant', t);
          if (render) process.stdout.write(t);
        } else if (k === 'assistant') {
          if (!streamed) {
            streamed = t;
            events?.('assistant', t);
          }
          if (render) ui.assistant(t);
        } else if (k === 'tool' || k === 'tool-result') {
          events?.('tool', t);
          if (render) ui.tool(t);
        } else {
          events?.('status', t);
          if (render) ui.info(t);
        }
      },
      signal: signal ?? controller.signal,
    });
    const session = await agent.run(prompt, existing);
    const status = `Session ${session.id} (${session.checkpoint})`;
    if (render) ui.info(status);
    else events?.('status', status);
    return render ? session : Object.assign(session, { __answer: streamed });
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted) {
      const status = 'Interrupted; session state was saved at the last completed tool checkpoint.';
      if (render) ui.error(status);
      else events?.('status', status);
      return existing;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}
async function ask(prompt: string, sessionId?: string) {
  const r = await runtime();
  try {
    return await runPrompt(r, prompt, sessionId ? await r.store.loadSession(sessionId) : undefined);
  } finally {
    await r.tools.close?.();
  }
}
async function tui() {
  if (await needsProviderSetup()) await setupProvider(await loadConfig());
  let requestApproval: (action: string, detail: string) => Promise<boolean> = ui.approve;
  const approve = (action: string, detail: string) => requestApproval(action, detail);
  let r = await runtime({}, approve);
  let session: Awaited<ReturnType<LocalStore['create']>> | undefined;
  const replaceRuntime = async (overrides: Partial<KyokaoConfig>) => {
    const previous = r;
    r = await runtime(
      { ...r.config, ...overrides, limits: { ...r.config.limits, ...overrides.limits } },
      approve,
    );
    await previous.tools.close?.();
  };
  try {
    await terminalWorkspace({
      header: () => ({
        workspace: r.root.replace(process.env.HOME ?? process.env.USERPROFILE ?? '', '~'),
        provider: r.config.provider,
        model: r.config.model,
        approval: r.config.approval,
      }),
      onPrompt: async (prompt, emit, signal, approve) => {
        if (signal.aborted) return;
        requestApproval = approve;
        const current = await runPrompt(r, prompt, session, false, emit, signal);
        session = current;
      },
      onCommand: async (command, emit) => {
        const arg = command.args.join(' ');
        if (!command.name) return { messages: [{ kind: 'error', text: 'Unknown command.' }] };
        if (command.name === 'exit') return { close: true };
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
          session = undefined;
          return { messages: [{ text: 'Started a new session.' }] };
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
          session = await r.store.loadSession(command.args[0]!);
          return { messages: [{ text: `Resumed session ${session.id}.` }] };
        }
        if (command.name === 'model') {
          if (!arg) return { messages: [{ text: `Active model: ${r.config.model}` }] };
          await replaceRuntime({ model: arg });
          return { messages: [{ text: `Active model changed to ${r.config.model}.` }] };
        }
        if (command.name === 'provider') {
          if (!arg) return { messages: [{ text: `Active provider: ${r.config.provider}` }] };
          try {
            await replaceRuntime({ provider: arg });
          } catch (error) {
            return {
              messages: [
                { kind: 'error', text: error instanceof Error ? error.message : String(error) },
              ],
            };
          }
          return { messages: [{ text: `Active provider changed to ${r.config.provider}.` }] };
        }
        if (command.name === 'approval') {
          if (!arg) return { messages: [{ text: `Approval mode: ${r.config.approval}` }] };
          if (!['suggest', 'auto-edit', 'full-auto'].includes(arg))
            return {
              messages: [{ kind: 'error', text: 'Usage: /approval <suggest|auto-edit|full-auto>' }],
            };
          await replaceRuntime({ approval: arg as KyokaoConfig['approval'] });
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
          const model = program.opts().skipModelCheck
            ? undefined
            : await r.provider.validateModel();
          return {
            messages: [
              {
                text: `node: ${process.version}\nworkspace: ${r.root}\nprovider: ${r.config.provider} (${r.provider.options.baseURL})\ncredentials: ${r.provider.options.apiKey ? 'configured' : 'missing'}\nmodel: ${model?.id ?? 'not checked'}\nsandbox: enabled`,
              },
            ],
          };
        }
        if (command.name === 'diff') {
          const result = await r.tools.execute('git', { args: ['diff', '--no-ext-diff'] });
          emit(result.isError ? 'error' : 'tool', result.content || 'Working tree is clean.');
          return;
        }
      },
    });
  } finally {
    await r.tools.close?.();
  }
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
    for (const m of await r.provider.models()) console.log(m);
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
    console.log(`provider: ${r.config.provider} (${r.provider.options.baseURL})`);
    console.log(
      `credentials: ${r.provider.options.apiKey ? 'configured' : 'missing (set provider environment key or --api-key)'}`,
    );
    console.log('sandbox: enabled');
    if (!program.opts().skipModelCheck) {
      const model = await r.provider.validateModel();
      console.log(`model: ${model.id} (available)`);
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
