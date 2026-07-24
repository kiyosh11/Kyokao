// @ts-nocheck
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicWrite,
  globalConfigPath,
  loadConfig,
  providerPresets,
  readConfig,
  redact,
  redactEndpoint,
  saveGlobalThemes,
  saveProviderSelection,
  type KyokaoConfig,
} from '@kyokao/config';
import { modelCatalog as builtInModelCatalog } from '@kyokao/providers';
import { WorkspaceSandbox } from '@kyokao/tools';
import { type PromptBackend, runAgentClient } from '@kyokao/agent';
import { CODE_THEME_NAMES, TUI_THEME_NAMES, isCodeThemeName, isTuiThemeName } from '@kyokao/themes';
import { createThemeContext } from '@kyokao/ui';
import { withGroup, type HelpGroup } from './help.js';
import type { OutputFormat } from './headless.js';
import type { Runtime } from './runtime.js';
import type { Session } from '@kyokao/memory';
import { registerTemplates } from './templates.js';

export interface CommandDeps {
  program: Command;
  runtime: (
    overrides?: Partial<KyokaoConfig>,
    approve?: (a: string, d: string) => Promise<boolean>,
  ) => Promise<Runtime>;
  ask: (prompt: string, sessionId?: string) => Promise<unknown>;
  tui: () => Promise<void>;
  setupProvider: (confirmReplace?: boolean) => Promise<boolean>;
  cliConfig: () => Partial<KyokaoConfig>;
  opts: () => Record<string, unknown>;
  createBackendFor: (
    r: Runtime,
    existing: Session | undefined,
    skipModelCheck: boolean,
  ) => Promise<PromptBackend>;
  runHeadless: (
    r: Runtime,
    prompt: string,
    existing: Session | undefined,
    format: OutputFormat,
    skipModelCheck: boolean,
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
  resolveOutputFormat: (explicit: OutputFormat | undefined, stdinIsTTY: boolean) => OutputFormat;
  readStdin: () => Promise<string>;
}

const INTERACTIVE: HelpGroup = 'Interactive';
const AGENT: HelpGroup = 'Agent-assisted';
const CONFIG_GROUP: HelpGroup = 'Configuration';
const SESSION: HelpGroup = 'Sessions & memory';
const PROVIDER_GROUP: HelpGroup = 'Providers & themes';
const LISTINGS: HelpGroup = 'Listings';
const DIAGNOSTICS: HelpGroup = 'Diagnostics';
const INTEGRATION: HelpGroup = 'Integration';
const COMMANDS: HelpGroup = 'Commands';

function printSessionHistory(session: Session): void {
  const title = session.task?.trim();
  console.log(title ? `Session ${session.id} · ${title}` : `Session ${session.id}`);
  console.log(`Updated: ${session.updatedAt}`);
  console.log('');
  if (!session.messages.length) {
    console.log('(no messages)');
    return;
  }
  for (const message of session.messages) {
    const role =
      message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : message.role;
    const content = (message.content ?? '').trim();
    if (content) console.log(`${role}: ${content}\n`);
  }
}

export function registerCommands(deps: CommandDeps): void {
  const {
    program,
    runtime,
    ask,
    tui,
    setupProvider,
    cliConfig,
    opts,
    createBackendFor,
    runHeadless,
    resolveOutputFormat,
    readStdin,
  } = deps;
  const skipModelCheck = () => Boolean(opts().skipModelCheck);

  program.argument('[prompt...]', 'task for the agent').action(async (parts: string[]) => {
    const format = resolveOutputFormat(
      opts().outputFormat as OutputFormat | undefined,
      Boolean(process.stdin.isTTY),
    );
    if (format === 'json' || format === 'streaming-json') {
      const prompt = parts.length ? parts.join(' ') : await readStdin();
      const r = await runtime();
      await runHeadless(r, prompt, undefined, format, skipModelCheck(), undefined);
      return;
    }
    if (parts.length) await ask(parts.join(' '));
    else if (process.stdin.isTTY) await tui();
    else await ask(await readStdin());
  });
  withGroup(
    program
      .command('run [prompt...]')
      .description('Run a prompt headlessly (explicit alias of the bare invocation)'),
    INTERACTIVE,
  ).action(async (parts: string[]) => {
    const prompt = parts.length ? parts.join(' ') : await readStdin();
    const format = (opts().outputFormat as OutputFormat | undefined) ?? 'plain';
    const r = await runtime();
    await runHeadless(r, prompt, undefined, format, skipModelCheck(), undefined);
  });
  withGroup(
    program.command('tui').description('Start the interactive terminal workspace').action(tui),
    INTERACTIVE,
  );

  program.command('chat', { hidden: true }).description('(alias of tui)').action(tui);

  registerTemplates(program, { ask: (prompt: string) => ask(prompt), helpGroup: AGENT });

  withGroup(
    program
      .command('setup')
      .description('Run the first-run provider, model, and project setup wizard')
      .action(async () => {
        if (!(await setupProvider(Boolean((await readConfig(globalConfigPath())).provider))))
          process.exitCode = 1;
      }),
    CONFIG_GROUP,
  );
  const config = withGroup(
    program.command('config').description('Inspect or manage non-secret configuration'),
    CONFIG_GROUP,
  );
  withGroup(
    config
      .command('show')
      .description('Print the resolved non-profile config with secrets redacted')
      .action(async () =>
        console.log(JSON.stringify(redact(await loadConfig({ cli: cliConfig() })), null, 2)),
      ),
    CONFIG_GROUP,
  );
  withGroup(
    config
      .command('path')
      .description('Print the global config file path')
      .action(() => console.log(globalConfigPath())),
    CONFIG_GROUP,
  );

  withGroup(
    config
      .command('setup', { hidden: true })
      .description('(alias of kyokao setup)')
      .action(async () => {
        if (!(await setupProvider(Boolean((await readConfig(globalConfigPath())).provider))))
          process.exitCode = 1;
      }),
    CONFIG_GROUP,
  );
  withGroup(
    config
      .command('export <file>')
      .description('Write a redacted resolved config to a file')
      .action(async (file: string) =>
        atomicWrite(file, redact(await loadConfig({ cli: cliConfig() }))),
      ),
    CONFIG_GROUP,
  );

  const session = withGroup(
    program.command('session').description('List and resume local sessions'),
    SESSION,
  );
  withGroup(
    session
      .command('list')
      .description('List local sessions for the current workspace')
      .action(async () => {
        const r = await runtime();
        try {
          for (const s of await r.store.listSessions())
            console.log(`${s.id}\t${s.updatedAt}\t${s.checkpoint ?? ''}\t${s.task ?? ''}`);
        } finally {
          await r.tools.close?.();
        }
      }),
    SESSION,
  );
  withGroup(
    session
      .command('resume <id> [prompt...]')
      .description('Show a session history; with a prompt, send it as a follow-up')
      .action(async (id: string, parts: string[]) => {
        const prompt = parts.length ? parts.join(' ') : '';
        if (!prompt) {
          const r = await runtime();
          try {
            const session = await r.store.loadSession(id);
            printSessionHistory(session);
            console.log(
              `\nTo continue: ${process.argv[1]} session resume ${id} "<your follow-up>"`,
            );
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
          } finally {
            await r.tools.close?.();
          }
          return;
        }
        await ask(prompt, id);
      }),
    SESSION,
  );

  program
    .command('sessions', { hidden: true })
    .description('(alias of session list)')
    .action(async () => {
      const r = await runtime();
      try {
        for (const s of await r.store.listSessions())
          console.log(`${s.id}\t${s.updatedAt}\t${s.checkpoint ?? ''}\t${s.task ?? ''}`);
      } finally {
        await r.tools.close?.();
      }
    });
  program
    .command('resume <id> <prompt...>', { hidden: true })
    .description('(alias of session resume)')
    .action(async (id: string, parts: string[]) => {
      await ask(parts.join(' '), id);
    });

  const memory = withGroup(
    program
      .command('memory')
      .description('With no subcommand, list all saved memory (alias of `memory list`)')
      .action(async () => {
        const r = await runtime();
        try {
          console.log(JSON.stringify(await r.store.getMemory(), null, 2));
        } finally {
          await r.tools.close?.();
        }
      }),
    SESSION,
  );
  withGroup(
    memory
      .command('list')
      .description('List all saved memory keys and values')
      .action(async () => {
        const r = await runtime();
        try {
          console.log(JSON.stringify(await r.store.getMemory(), null, 2));
        } finally {
          await r.tools.close?.();
        }
      }),
    SESSION,
  );
  withGroup(
    memory
      .command('set <key> <value>')
      .description('Save a string value under a key')
      .action(async (k: string, v: string) => {
        const r = await runtime();
        try {
          await r.store.setMemory(k, v);
        } finally {
          await r.tools.close?.();
        }
      }),
    SESSION,
  );
  withGroup(
    memory
      .command('delete <key>')
      .description('Delete a saved memory key')
      .action(async (k: string) => {
        const r = await runtime();
        try {
          await r.store.deleteMemory(k);
        } finally {
          await r.tools.close?.();
        }
      }),
    SESSION,
  );

  const provider = withGroup(
    program.command('provider').description('Switch or inspect the active provider'),
    PROVIDER_GROUP,
  );
  withGroup(
    provider
      .command('use <name> [model]')
      .description('Switch provider using an explicit or previously saved provider model')
      .action(async (name: string, requestedModel?: string) => {
        const saved = await readConfig(globalConfigPath());
        const configured = saved.providers?.[name];
        if (!providerPresets[name] && !configured) throw new Error(`Unknown provider: ${name}`);
        const model =
          requestedModel ??
          configured?.model ??
          (saved.provider === name ? saved.model : undefined);
        if (!model)
          throw new Error(
            `No model is saved for ${name}. Use "kyokao provider use ${name} <model>".`,
          );
        if (name === 'capy' && !configured?.projectId)
          throw new Error(
            'Capy requires a saved project. Run "kyokao setup" or select Capy from the TUI first.',
          );
        await saveProviderSelection(name, {
          model,
          ...(configured?.projectId ? { projectId: configured.projectId } : {}),
        });
        console.log(
          `Active provider set to ${name} with model ${model}. Restart any running session to use it.`,
        );
      }),
    PROVIDER_GROUP,
  );
  withGroup(
    provider
      .command('list')
      .description('List built-in and configured providers')
      .action(async () => {
        const saved = await readConfig(globalConfigPath());
        const names = new Set([
          ...Object.keys(providerPresets),
          ...Object.keys(saved.providers ?? {}),
        ]);
        for (const name of [...names].sort()) {
          const baseURL = saved.providers?.[name]?.baseURL ?? providerPresets[name]?.baseURL ?? '';
          const model = saved.providers?.[name]?.model;
          console.log(`${name}\t${redactEndpoint(baseURL)}${model ? `\t${model}` : ''}`);
        }
      }),
    PROVIDER_GROUP,
  );

  const theme = withGroup(
    program.command('theme').description('Persist or inspect themes'),
    PROVIDER_GROUP,
  );
  withGroup(
    theme
      .command('save [tui] [code]')
      .description('Persist TUI and code themes globally (scriptable settings equivalent)')
      .action(async (tuiName?: string, codeName?: string) => {
        const config = await loadConfig({ cli: cliConfig() });
        const tui = tuiName ?? config.theme;
        const code = codeName ?? config.codeTheme;
        if (!isTuiThemeName(tui))
          throw new Error(`Unknown TUI theme "${tui}". Choose: ${TUI_THEME_NAMES.join(', ')}`);
        if (!isCodeThemeName(code))
          throw new Error(`Unknown code theme "${code}". Choose: ${CODE_THEME_NAMES.join(', ')}`);
        await saveGlobalThemes(tui, code);
        console.log(`Saved themes: ${tui} / ${code}.`);
      }),
    PROVIDER_GROUP,
  );
  withGroup(
    theme
      .command('list')
      .description('Preview all built-in TUI and code themes')
      .action(themesAction(cliConfig)),
    PROVIDER_GROUP,
  );

  withGroup(
    program
      .command('models')
      .description('List models from the selected provider (use --known for the built-in catalog)')
      .option(
        '--known',
        'Show the built-in model capability/pricing catalog instead of live models',
      )
      .action(async (opt: { known?: boolean }) => {
        if (opt.known) return printCatalog();
        const r = await runtime();
        try {
          if (r.capy) {
            for (const model of (await r.capy.models()).filter((m) => m.captainEligible))
              console.log(`${model.id}\t${model.name}\t${model.provider}`);
          } else for (const m of await r.provider.models()) console.log(m);
        } finally {
          await r.tools.close?.();
        }
      }),
    LISTINGS,
  );

  program
    .command('catalog', { hidden: true })
    .description('(alias of models --known)')
    .action(printCatalog);

  withGroup(
    program
      .command('providers')
      .description('List built-in provider presets')
      .action(() => {
        for (const [name, p] of Object.entries(providerPresets))
          console.log(`${name}\t${p.baseURL}`);
      }),
    LISTINGS,
  );
  withGroup(
    program
      .command('themes')
      .description('Preview all built-in TUI and code themes')
      .action(themesAction(cliConfig)),
    LISTINGS,
  );
  withGroup(
    program
      .command('plugins')
      .description('List configured plugin modules')
      .action(async () => {
        const r = await runtime();
        try {
          for (const plugin of r.config.plugins) console.log(plugin);
        } finally {
          await r.tools.close?.();
        }
      }),
    LISTINGS,
  );
  withGroup(
    program
      .command('mcp')
      .description('List configured MCP stdio servers')
      .action(async () => {
        const r = await runtime();
        try {
          for (const [name, server] of Object.entries(r.config.mcp))
            console.log(`${name}\t${server.command}\t${server.args?.length ?? 0} argument(s)`);
        } finally {
          await r.tools.close?.();
        }
      }),
    LISTINGS,
  );
  withGroup(
    program
      .command('usage [id]')
      .description('Show token and estimated cost usage for one or all sessions')
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
      }),
    LISTINGS,
  );

  withGroup(
    program
      .command('doctor')
      .description('Check local setup without revealing secrets')
      .action(async () => {
        const r = await runtime();
        try {
          console.log(`node: ${process.version}`);
          console.log(`workspace: ${r.root}`);
          console.log(`provider: ${r.config.provider} (${redactEndpoint(r.provider.baseURL)})`);
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
            if (!skipModelCheck()) {
              const model = await r.provider.validateModel();
              console.log(`model: ${model.id} (available)`);
            }
          }

          const legacyPaths = [join(r.root, '.kyokao'), join(r.root, '.kyokao.json')];
          const found: string[] = [];
          for (const p of legacyPaths) {
            try {
              await stat(p);
              found.push(p);
            } catch {}
          }
          if (found.length)
            console.log(
              `\nlegacy: found pre-0.7.0 state at ${found.join(', ')}. Kyokao no longer reads workspace .kyokao/ or .kyokao.json — sessions, memory, and instructions now live at ~/.kyokao/. See MIGRATION.md.`,
            );
        } finally {
          await r.tools.close?.();
        }
      }),
    DIAGNOSTICS,
  );
  withGroup(
    program
      .command('diff')
      .description('Show the working-tree diff')
      .action(async () => {
        const r = await runtime();
        try {
          const v = await r.tools.execute('git', { args: ['diff', '--no-ext-diff'] });
          r.renderer.diff(v.content);
        } finally {
          await r.tools.close?.();
        }
      }),
    DIAGNOSTICS,
  );

  withGroup(
    program
      .command('agent-client')
      .description('Drive the agent over a JSON-RPC 2.0 stdio protocol for IDE/bot integration')
      .action(async () => {
        const r = await runtime();
        let backend: PromptBackend | undefined;
        try {
          backend = await createBackendFor(r, undefined, skipModelCheck());
          await runAgentClient(process.stdin, process.stdout, backend);
        } finally {
          await backend?.close().catch(() => {});
          await r.tools.close?.();
        }
      }),
    INTEGRATION,
  );

  withGroup(
    program
      .command('edit <path>')
      .description('Open a workspace file in the configured editor')
      .action(async (path: string) => {
        const config = await loadConfig({ cli: cliConfig() });
        const file = await new WorkspaceSandbox(process.cwd()).path(path);
        const configured = config.editor || process.env.VISUAL || process.env.EDITOR;
        const command = configured || (process.platform === 'win32' ? 'notepad' : 'vi');
        const parts =
          command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((p) => p.replace(/^(['"])|(['"])$/g, '')) ??
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
            code === 0
              ? resolve()
              : reject(new Error(`Editor exited with code ${code ?? 'unknown'}`)),
          );
        });
      }),
    COMMANDS,
  );
}

function printCatalog(): void {
  for (const model of builtInModelCatalog)
    console.log(
      `${model.id}\t${model.contextWindow ?? '?'} ctx\t` +
        `${model.inputCostPerMillion === undefined ? 'provider pricing' : `$${model.inputCostPerMillion}/$${model.outputCostPerMillion} per 1M tokens`}\t` +
        `${model.supportsTools === false ? 'no tools' : 'tools'}`,
    );
}

function themesAction(cliConfig: () => Partial<KyokaoConfig>): () => Promise<void> {
  return async () => {
    const config = await loadConfig({ cli: cliConfig() });
    const active = createThemeContext({
      tuiTheme: config.theme,
      codeTheme: config.codeTheme,
      isTTY: process.stdout.isTTY,
      env: process.env,
    });
    console.log('TUI themes');
    for (const name of TUI_THEME_NAMES) {
      const preview = createThemeContext({
        tuiTheme: name,
        codeTheme: config.codeTheme,
        colorLevel: active.colorLevel,
      });
      const mark = name === config.theme ? '*' : ' ';
      console.log(
        `${mark} ${preview.tui('brand', '◆')} ${preview.tui('user', 'user')} ${preview.tui('assistant', 'assistant')} ${preview.tui('tool', 'tool')} ${preview.tui('error', 'error')} ${preview.tui('selected', name)}`,
      );
    }
    console.log('\nCode themes');
    for (const name of CODE_THEME_NAMES) {
      const preview = createThemeContext({
        tuiTheme: config.theme,
        codeTheme: name,
        colorLevel: active.colorLevel,
      });
      const mark = name === config.codeTheme ? '*' : ' ';
      console.log(
        `${mark} ${name}  ${preview.code('keyword', 'const')} ${preview.code('property', 'answer')} ${preview.code('punctuation', ' = ')}${preview.code('number', '42')}${preview.code('punctuation', ';')} ${preview.code('comment', '// sample')}`,
      );
    }
  };
}
