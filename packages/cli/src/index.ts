#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  loadConfig,
  redact,
  resolveProvider,
  providerPresets,
  atomicWrite,
  globalConfigPath,
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
import { Agent } from '@kyokao/agent';
import { fullscreenChat, ui } from '@kyokao/ui';
const program = new Command();
program
  .name('kyokao')
  .description('Kyokao: a safe, local-first coding agent')
  .version('0.1.0')
  .option('-m, --model <id>', 'model ID or configured alias')
  .option('-p, --provider <name>', 'provider preset or configured provider')
  .option('--base-url <url>', 'override provider base URL')
  .option('--api-key <key>', 'override API key (never persisted)')
  .option('--approval <mode>', 'suggest, auto-edit, or full-auto')
  .option('--profile <name>', 'configuration profile')
  .option('--max-iterations <n>', 'agent iteration limit')
  .option('--context-window <n>', 'context token budget')
  .option('--skip-model-check', 'skip provider model availability validation');
function cliConfig() {
  const o = program.opts();
  return {
    provider: o.provider,
    model: o.model,
    approval: o.approval,
    maxIterations: o.maxIterations ? Number(o.maxIterations) : undefined,
    contextWindow: o.contextWindow ? Number(o.contextWindow) : undefined,
    providers:
      o.baseUrl || o.apiKey
        ? { [o.provider ?? 'openai']: { baseURL: o.baseUrl, apiKey: o.apiKey } }
        : {},
  };
}
async function runtime() {
  const config = await loadConfig({ cli: cliConfig(), profile: program.opts().profile });
  const p = resolveProvider(config);
  const root = process.cwd();
  const store = new LocalStore(join(root, '.kyokao'));
  const core = new CoreTools(new WorkspaceSandbox(root), config.approval, ui.approve);
  const plugins = await loadPlugins(config.plugins, root);
  const mcp = await connectMcp(config.mcp, root);
  const tools = new CompositeTools([core, ...plugins, ...(mcp ? [mcp] : [])]);
  return { config, store, provider: new OpenAICompatibleProvider(p), tools, root, core };
}
async function runPrompt(
  r: Awaited<ReturnType<typeof runtime>>,
  prompt: string,
  existing?: Awaited<ReturnType<LocalStore['loadSession']>>,
  render = true,
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
      modelInfo,
      onEvent: (k, t) =>
        k === 'text'
          ? render
            ? process.stdout.write(t)
            : (streamed += t)
          : k === 'assistant'
            ? render
              ? ui.assistant(t)
              : (streamed = t)
            : k === 'usage'
              ? render && ui.info(t)
              : render && ui.tool(t),
      signal: controller.signal,
    });
    const session = await agent.run(prompt, existing);
    ui.info(`Session ${session.id} (${session.checkpoint})`);
    return render ? session : Object.assign(session, { __answer: streamed });
  } catch (error) {
    if (controller.signal.aborted) {
      ui.error('Interrupted; session state was saved at the last completed tool checkpoint.');
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
async function chat() {
  if (!process.stdin.isTTY) throw new Error('chat requires an interactive terminal');
  const r = await runtime();
  const line = createInterface({ input: process.stdin, output: process.stdout });
  let session: Awaited<ReturnType<LocalStore['create']>> | undefined;
  try {
    for (;;) {
      const prompt = (await line.question(session ? 'kyokao> ' : 'kyokao (type /exit)> ')).trim();
      if (!prompt || prompt === '/exit') break;
      session = await runPrompt(r, prompt, session);
    }
  } finally {
    line.close();
    await r.tools.close?.();
  }
}
program.argument('[prompt...]', 'task for the agent').action(async (parts: string[]) => {
  if (parts.length) await ask(parts.join(' '));
  else if (process.stdin.isTTY) await chat();
  else {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c);
    await ask(Buffer.concat(chunks).toString().trim());
  }
});
program.command('chat').description('Start an interactive chat session').action(chat);
program
  .command('tui')
  .description('Start the full-screen terminal chat interface')
  .action(async () => {
    const r = await runtime();
    try {
      await fullscreenChat(async (prompt) => {
        const session = await runPrompt(r, prompt, undefined, false);
        return (session as typeof session & { __answer?: string }).__answer;
      });
    } finally {
      await r.tools.close?.();
    }
  });
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
