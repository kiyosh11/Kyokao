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
import { OpenAICompatibleProvider } from '@kyokao/providers';
import { WorkspaceSandbox, CoreTools } from '@kyokao/tools';
import { LocalStore } from '@kyokao/memory';
import { Agent } from '@kyokao/agent';
import { ui } from '@kyokao/ui';
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
  .option('--max-iterations <n>', 'agent iteration limit');
function cliConfig() {
  const o = program.opts();
  return {
    provider: o.provider,
    model: o.model,
    approval: o.approval,
    maxIterations: o.maxIterations ? Number(o.maxIterations) : undefined,
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
  const tools = new CoreTools(new WorkspaceSandbox(root), config.approval, ui.approve);
  return { config, store, provider: new OpenAICompatibleProvider(p), tools, root };
}
async function runPrompt(
  r: Awaited<ReturnType<typeof runtime>>,
  prompt: string,
  existing?: Awaited<ReturnType<LocalStore['loadSession']>>,
) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    const agent = new Agent({
      provider: r.provider,
      tools: r.tools,
      store: r.store,
      maxIterations: r.config.maxIterations,
      workspace: r.root,
      onEvent: (k, t) =>
        k === 'text' ? process.stdout.write(t) : k === 'assistant' ? ui.assistant(t) : ui.tool(t),
      signal: controller.signal,
    });
    const session = await agent.run(prompt, existing);
    ui.info(`Session ${session.id} (${session.checkpoint})`);
    return session;
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
  return runPrompt(r, prompt, sessionId ? await r.store.loadSession(sessionId) : undefined);
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
  .command('models')
  .description('List models from the selected provider')
  .action(async () => {
    const r = await runtime();
    for (const m of await r.provider.models()) console.log(m);
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
