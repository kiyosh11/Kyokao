// @ts-nocheck

import { compressMessages, estimateTokens } from '@kyokao/agent';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  atomicWrite,
  globalConfigPath,
  kyokaoHome,
  readConfig,
  redact,
  redactEndpoint,
  saveGlobalConfigPatch,
  type KyokaoConfig,
  providerPresets,
  saveGlobalThemes,
  saveProviderSelection,
} from '@kyokao/config';
import { CapyClient, type CapyTagColor } from '@kyokao/providers';
import { isCodeThemeName, isTuiThemeName } from '@kyokao/themes';
import type {
  ParsedCommand,
  WorkspaceControl,
  WorkspaceCommandResult,
  WorkspaceEmit,
} from '@kyokao/ui';
import { workspaceCommands } from '@kyokao/ui';
import { createBackend as createBackendFor } from './runtime.js';
import { copyToClipboard, type TuiContext } from './tui-context.js';

export type { TuiContext } from './tui-context.js';

const CAPY_TAG_COLORS = new Set<CapyTagColor>([
  'default',
  'primary',
  'success',
  'warning',
  'destructive',
  'blue',
  'purple',
  'pink',
  'orange',
  'lime',
]);

function capyUsageBoundary(value: string | undefined, endOfDay: boolean): string {
  if (!value) {
    const now = new Date();
    if (!endOfDay) now.setUTCDate(1);
    if (!endOfDay) now.setUTCHours(0, 0, 0, 0);
    return now.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid usage date "${value}". Use YYYY-MM-DD or an ISO timestamp.`);
  }
  return parsed.toISOString();
}

function idleError(control: WorkspaceControl, action: string): WorkspaceCommandResult | undefined {
  const state = control.scheduler();
  if (!state.active && !['stopping', 'starting-replacement'].includes(state.phase)) return;
  return {
    messages: [
      { kind: 'error', text: `Cannot ${action} while a request is active. Stop it first.` },
    ],
  };
}

function pickSession(ctx: TuiContext, value?: string) {
  if (!value) return ctx.backend.session();
  if (/^\d+$/.test(value)) return ctx.sessionChoices[Number(value) - 1];
  return ctx.sessionChoices.find((session) => session.id === value || session.id.startsWith(value));
}

async function discoverSkills(): Promise<Array<{ name: string; path: string }>> {
  const roots = [join(kyokaoHome(), 'skills'), join(homedir(), '.codex', 'skills')];
  const found: Array<{ name: string; path: string }> = [];
  const visit = async (directory: string, depth: number) => {
    if (depth > 5 || found.length >= 200) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 200) break;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        found.push({ name: directory.split(/[\\/]/).at(-1) || directory, path });
      } else if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
        await visit(path, depth + 1);
      }
    }
  };
  for (const root of roots) await visit(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const unavailableCommands: Partial<Record<string, string>> = {
  ide: 'IDE integration is not installed in this standalone terminal build.',
  vim: 'Vim editing mode is not implemented. The current editor supports Codex/Emacs bindings.',
  'sandbox-add-read-dir':
    'Additional sandbox roots are not supported; Kyokao intentionally restricts tools to the active workspace.',
  hooks: 'Lifecycle hooks are not implemented in Kyokao yet.',
  app: 'The desktop-app bridge is not available in this standalone CLI.',
  side: 'Side conversations are not supported by the current single-session scheduler.',
  btw: 'Side conversations are not supported by the current single-session scheduler.',
  statusline:
    'A configurable status line is not implemented; runtime status is shown in the footer.',
};

function sessionTranscriptMessages(session: { messages: any[] }) {
  return session.messages.flatMap((message) => {
    const content = message.content?.trim();
    if (message.role === 'user') return content ? [{ kind: 'user' as const, text: content }] : [];
    if (message.role === 'assistant') {
      const reasoning = message.reasoning_content?.trim();
      const calls = (message.tool_calls ?? [])
        .map((call) => `${call.name} ${call.arguments}`)
        .join('\n');
      return [
        ...(reasoning ? [{ kind: 'reasoning' as const, text: reasoning }] : []),
        ...(content ? [{ kind: 'assistant' as const, text: content }] : []),
        ...(calls ? [{ kind: 'tool' as const, text: calls }] : []),
      ];
    }
    if (message.role === 'tool') return content ? [{ kind: 'tool' as const, text: content }] : [];
    return content ? [{ kind: 'status' as const, text: content }] : [];
  });
}

async function resumeSession(
  ctx: TuiContext,
  control: WorkspaceControl,
  emit: WorkspaceEmit,
  sessionId: string,
): Promise<WorkspaceCommandResult> {
  const { r, backend } = ctx;
  const session = await r.store.loadSession(sessionId);
  ctx.sessionChoices = [
    session,
    ...ctx.sessionChoices.filter((candidate) => candidate.id !== session.id),
  ];
  const pendingPrompts = [...(session.pendingPrompts ?? [])];
  const candidateBackend = await createBackendFor(r, session, ctx.skipModelCheck);
  try {
    await control.reset();
  } catch (error) {
    await candidateBackend.close().catch(() => {});
    throw error;
  }
  try {
    await backend.close();
  } catch (error) {
    await candidateBackend.close().catch(() => {});
    throw error;
  }
  ctx.backend = candidateBackend;
  for (const prompt of pendingPrompts) await control.enqueue(prompt);
  emit('usage', session.usage);
  const title = session.task?.trim().slice(0, 40) || session.id.slice(0, 8);
  const messages = sessionTranscriptMessages(session);
  return {
    clear: true,
    messages: [...messages, { kind: 'system', text: `Resumed: ${title}` }],
  };
}

export async function handleTuiCommand(
  command: ParsedCommand,
  emit: WorkspaceEmit,
  control: WorkspaceControl,
  ctx: TuiContext,
): Promise<WorkspaceCommandResult | void> {
  const { r, backend, themeContext } = ctx;
  const arg = command.args.join(' ');
  if (!command.name) return { messages: [{ kind: 'error', text: 'Unknown command.' }] };
  if (unavailableCommands[command.name]) {
    return { messages: [{ kind: 'error', text: unavailableCommands[command.name]! }] };
  }
  if (command.name === 'title') {
    const title = arg.trim();
    if (!title) return { messages: [{ kind: 'error', text: 'Usage: /title <text>' }] };
    const session = backend.session();
    if (!session) return { messages: [{ kind: 'error', text: 'No active session to rename.' }] };
    session.task = title;
    await r.store.saveSession(session);
    return { messages: [{ text: `Session renamed to "${title}".` }] };
  }
  if (command.name === 'raw') return { overlay: 'raw' };
  if (command.name === 'ps') {
    const state = control.scheduler();
    return {
      messages: [
        {
          text: [
            `state: ${state.phase}`,
            state.active ? `active: ${state.active}` : 'active: none',
            `queued: ${state.queue.length}`,
            ...state.queue.map((prompt, index) => `  ${index + 1}. ${prompt}`),
          ].join('\n'),
        },
      ],
    };
  }
  if (command.name === 'stop') {
    const before = control.scheduler();
    if (before.active) await control.cancelActive();
    const cleared = await control.clearQueue();
    return {
      messages: [
        {
          text:
            before.active || cleared
              ? `Stopped active work and cleared ${cleared} queued prompt(s).`
              : 'No active or queued work.',
        },
      ],
    };
  }
  if (command.name === 'test-approval') {
    const allowed = await control.requestApproval(
      'Test approval',
      'This is a safe UI test. It does not run a command or modify files.',
    );
    return { messages: [{ text: `Approval test: ${allowed ? 'approved' : 'denied'}.` }] };
  }
  if (command.name === 'approve') {
    return {
      messages: [
        {
          text: 'Approvals appear automatically when a tool needs permission. Use /test-approval to test the dialog.',
        },
      ],
    };
  }
  if (command.name === 'setup-default-sandbox') {
    return {
      messages: [
        {
          text: `Sandbox is enabled and restricted to the active workspace:\n${r.root}`,
        },
      ],
    };
  }
  if (command.name === 'debug-config') {
    return { messages: [{ text: JSON.stringify(redact(r.config), null, 2) }] };
  }
  if (command.name === 'feedback') {
    return {
      messages: [
        {
          text: 'Report bugs or feedback at https://github.com/kiyosh11/Kyokao/issues',
        },
      ],
    };
  }
  if (command.name === 'apps') {
    const integrations = [
      ...Object.keys(r.config.mcp).map((name) => `MCP: ${name}`),
      ...r.config.plugins.map((name) => `Plugin: ${name}`),
    ];
    return {
      messages: [
        { text: integrations.length ? integrations.join('\n') : 'No integrations configured.' },
      ],
    };
  }
  if (command.name === 'logout') {
    const configPath = globalConfigPath();
    const saved = await readConfig(configPath);
    const providers = { ...(saved.providers ?? {}) };
    const provider = { ...(providers[r.config.provider] ?? {}) };
    const hadSavedKey = Boolean(provider.apiKey);
    delete provider.apiKey;
    if (Object.keys(provider).length) providers[r.config.provider] = provider;
    else delete providers[r.config.provider];
    await atomicWrite(configPath, { ...saved, providers });
    if (r.config.providers[r.config.provider]) delete r.config.providers[r.config.provider]!.apiKey;
    return {
      messages: [
        {
          text: hadSavedKey
            ? `Removed the saved API key for ${r.config.provider}. Environment variables were not changed. Restart Kyokao to apply it.`
            : `No saved API key exists for ${r.config.provider}. Environment variables were not changed.`,
        },
      ],
    };
  }
  if (command.name === 'experimental' || command.name === 'agent') {
    return {
      messages: [
        {
          text: [
            `subagents: ${r.config.subagents.enabled ? 'enabled' : 'disabled'}`,
            `backend: ${r.config.provider === 'capy' ? 'Capy remote agent' : 'local tool agent'}`,
            `scheduler: ${control.scheduler().phase}`,
          ].join('\n'),
        },
      ],
    };
  }
  if (command.name === 'subagents') {
    const value = command.args[0]?.toLowerCase();
    if (!value)
      return {
        messages: [
          {
            text: `Subagents are ${r.config.subagents.enabled ? 'enabled' : 'disabled'}. Use /subagents on or /subagents off.`,
          },
        ],
      };
    if (!['on', 'off'].includes(value) || command.args.length !== 1)
      return { messages: [{ kind: 'error', text: 'Usage: /subagents [on|off]' }] };
    if (r.config.provider === 'capy' && value === 'on')
      return {
        messages: [
          {
            kind: 'error',
            text: 'Local subagent tools are unavailable with Capy; Capy manages its own remote workers.',
          },
        ],
      };
    const enabled = value === 'on';
    const busyResult = idleError(control, 'change subagent configuration');
    if (busyResult) return busyResult;
    await saveGlobalConfigPatch({ subagents: { enabled } });
    await ctx.replaceRuntime(
      { subagents: { enabled } },
      { preserveCompatibleSession: true, beforeSwap: () => control.reset() },
    );
    return { messages: [{ text: `Subagents ${enabled ? 'enabled' : 'disabled'}.` }] };
  }
  if (command.name === 'personality') {
    const value = command.args[0]?.toLowerCase();
    const allowed = ['default', 'concise', 'friendly', 'technical'];
    const session = backend.session();
    if (!value)
      return {
        messages: [
          {
            text: `Active personality: ${session?.personality ?? 'default'}\nAvailable: ${allowed.join(', ')}`,
          },
        ],
      };
    if (!allowed.includes(value) || command.args.length !== 1)
      return {
        messages: [{ kind: 'error', text: `Usage: /personality [${allowed.join('|')}]` }],
      };
    if (!session)
      return { messages: [{ kind: 'error', text: 'Send a prompt to start a session first.' }] };
    session.personality = value;
    await r.store.saveSession(session);
    return { messages: [{ text: `Personality changed to ${value}.` }] };
  }
  if (command.name === 'settings') {
    const section = command.args[0]?.toLowerCase();
    if (!section)
      return {
        messages: [
          {
            text: [
              `Thinking: ${r.config.tui.showThinking ? 'on' : 'off'}`,
              `Provider: ${r.config.provider}`,
              `Model: ${r.config.model}`,
              `Permissions: ${r.config.approval}`,
              `TUI theme: ${r.config.theme}`,
              `Code theme: ${r.config.codeTheme}`,
              `Subagents: ${r.config.subagents.enabled ? 'on' : 'off'}`,
              '',
              '',
              'Select a row above the composer and press Enter.',
            ].join('\n'),
          },
        ],
      };
    const value = command.args[1]?.toLowerCase();
    if (section === 'theme') {
      if (!value || command.args.length !== 2 || !isTuiThemeName(value))
        return {
          messages: [{ kind: 'error', text: 'Choose a TUI theme from the settings list.' }],
          prefill: '/settings theme ',
        };
      themeContext.setTuiTheme(value);
      r.config.theme = value;
      await saveGlobalThemes(value, themeContext.names.code);
      return {
        messages: [{ text: `TUI theme changed to ${value}.` }],
        prefill: '/settings',
      };
    }
    if (section === 'code-theme') {
      if (!value || command.args.length !== 2 || !isCodeThemeName(value))
        return {
          messages: [{ kind: 'error', text: 'Choose a code theme from the settings list.' }],
          prefill: '/settings code-theme ',
        };
      themeContext.setCodeTheme(value);
      r.config.codeTheme = value;
      await saveGlobalThemes(themeContext.names.tui, value);
      return {
        messages: [{ text: `Code theme changed to ${value}.` }],
        prefill: '/settings',
      };
    }
    if (section === 'permissions' || section === 'subagents') {
      const delegated = await handleTuiCommand(
        {
          name: section,
          args: command.args.slice(1),
          raw: `/${section} ${command.args.slice(1).join(' ')}`.trim(),
        },
        emit,
        control,
        ctx,
      );
      return { ...delegated, prefill: '/settings' };
    }
    if (!['thinking', 'reasoning'].includes(section))
      return {
        messages: [{ kind: 'error', text: 'Choose a setting from the list above the composer.' }],
        prefill: '/settings',
      };
    if (!['on', 'off'].includes(value ?? '') || command.args.length !== 2)
      return {
        messages: [{ kind: 'error', text: 'Usage: /settings thinking <on|off>' }],
        prefill: '/settings',
      };
    const showThinking = value === 'on';
    r.config.tui = { ...r.config.tui, showThinking };
    await saveGlobalConfigPatch({ tui: { showThinking } });
    return {
      messages: [
        {
          text: showThinking
            ? 'Thinking is visible. Streamed model reasoning will appear in the transcript.'
            : 'Thinking is hidden. Final answers and tool activity will still stream normally.',
        },
      ],
      prefill: '/settings',
    };
  }
  if (command.name === 'goal') {
    const session = backend.session();
    if (!session)
      return { messages: [{ kind: 'error', text: 'Send a prompt to start a session first.' }] };
    if (!arg)
      return {
        messages: [{ text: session.goal ? `Active goal: ${session.goal}` : 'No active goal.' }],
      };
    if (arg === 'clear') {
      delete session.goal;
      await r.store.saveSession(session);
      return { messages: [{ text: 'Goal cleared.' }] };
    }
    session.goal = arg.trim();
    await r.store.saveSession(session);
    return { messages: [{ text: `Goal set: ${session.goal}` }] };
  }
  if (command.name === 'init') {
    const path = join(r.root, 'AGENTS.md');
    try {
      await writeFile(
        path,
        '# Repository Guidelines\n\nDescribe the commands, architecture, conventions, and verification steps agents should follow in this repository.\n',
        { encoding: 'utf8', flag: 'wx' },
      );
      return { messages: [{ text: `Created ${path}` }] };
    } catch (error: any) {
      if (error?.code === 'EEXIST')
        return {
          messages: [{ kind: 'error', text: 'AGENTS.md already exists; it was not overwritten.' }],
        };
      throw error;
    }
  }
  if (command.name === 'import') {
    const source = join(r.root, 'CLAUDE.md');
    const target = join(r.root, 'AGENTS.md');
    try {
      await access(source);
    } catch {
      return {
        messages: [{ kind: 'error', text: 'CLAUDE.md was not found in the workspace root.' }],
      };
    }
    try {
      await access(target);
      return {
        messages: [{ kind: 'error', text: 'AGENTS.md already exists; it was not overwritten.' }],
      };
    } catch {}
    await writeFile(target, await readFile(source, 'utf8'), { encoding: 'utf8', flag: 'wx' });
    return { messages: [{ text: 'Imported CLAUDE.md into AGENTS.md.' }] };
  }
  if (command.name === 'mention') {
    if (!arg.trim())
      return { messages: [{ kind: 'error', text: 'Usage: /mention <workspace-path>' }] };
    const candidate = resolve(r.root, arg.trim());
    const root = resolve(r.root);
    if (candidate !== root && !candidate.startsWith(root + sep))
      return {
        messages: [{ kind: 'error', text: 'Mentioned paths must stay inside the workspace.' }],
      };
    try {
      await access(candidate);
    } catch {
      return { messages: [{ kind: 'error', text: `Path not found: ${arg.trim()}` }] };
    }
    const path = relative(root, candidate).replaceAll('\\', '/');
    return { prefill: `@${path} ` };
  }
  if (command.name === 'skills') {
    const skills = await discoverSkills();
    if (!arg)
      return {
        messages: [
          {
            text: skills.length
              ? skills.map((skill) => `${skill.name}  ${skill.path}`).join('\n')
              : 'No skills found under ~/.kyokao/skills or ~/.codex/skills.',
          },
        ],
      };
    const matches = skills.filter(
      (candidate) => candidate.name.toLowerCase() === arg.toLowerCase(),
    );
    if (!matches.length) return { messages: [{ kind: 'error', text: `Skill not found: ${arg}` }] };
    if (matches.length > 1)
      return {
        messages: [
          {
            kind: 'error',
            text: `Skill name "${arg}" is ambiguous:\n${matches.map((skill) => skill.path).join('\n')}`,
          },
        ],
      };
    const skill = matches[0]!;
    const instructions = (await readFile(skill.path, 'utf8')).slice(0, 20_000);
    await control.enqueue(
      `Use the "${skill.name}" skill for this request. Follow these skill instructions:\n\n${instructions}\n\nAsk me what task to perform with this skill if the task is not already clear.`,
    );
    return { messages: [{ text: `Loaded skill "${skill.name}".` }] };
  }
  if (command.name === 'exit' || command.name === 'quit') {
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
  if (command.name === 'keymap') {
    return {
      messages: [
        {
          text: [
            'Enter submit · Tab queue while running · Shift/Alt+Enter newline',
            'Esc interrupt · Ctrl+C cancel/quit · Ctrl+L clear · Ctrl+T transcript',
            'Ctrl+G external editor · Ctrl+O copy last response · ? shortcuts',
            'Ctrl+R/Ctrl+S history · PgUp/PgDn scroll',
            'Ctrl+A/E start/end · Ctrl+B/F left/right · Ctrl+P/N up/down',
            'Ctrl+U/K kill · Ctrl+W/Alt+D delete word · Ctrl+Y yank',
          ].join('\n'),
        },
      ],
    };
  }
  if (command.name === 'mcp') {
    const servers = Object.entries(r.config.mcp);
    return {
      messages: [
        {
          text: servers.length
            ? servers
                .map(
                  ([name, server]) =>
                    `${name} · ${server.command} · ${server.args?.length ?? 0} argument(s)`,
                )
                .join('\n')
            : 'No MCP servers configured.',
        },
      ],
    };
  }
  if (command.name === 'plugins') {
    return {
      messages: [
        {
          text: r.config.plugins.length
            ? r.config.plugins.map((plugin) => `• ${plugin}`).join('\n')
            : 'No plugin modules configured.',
        },
      ],
    };
  }
  if (command.name === 'new') {
    await control.reset();
    emit('usage', undefined);
    return {
      clear: true,
      messages: [{ text: 'Started a new session.' }],
    };
  }
  if (command.name === 'archive' && command.args[0] === 'list') {
    const archived = await r.store.listArchivedSessions();
    return {
      messages: [
        {
          text: archived.length
            ? archived
                .map(
                  (session, index) =>
                    `${index + 1}. ${session.id}  ${session.task?.trim() || '(untitled)'}`,
                )
                .join('\n')
            : 'No archived sessions.',
        },
      ],
    };
  }
  if (command.name === 'archive' && command.args[0] === 'restore') {
    if (command.args.length !== 2)
      return {
        messages: [{ kind: 'error', text: 'Usage: /archive restore <number|session-id>' }],
      };
    const archived = await r.store.listArchivedSessions();
    const selector = command.args[1]!;
    const selected = /^\d+$/.test(selector)
      ? archived[Number(selector) - 1]
      : archived.find((session) => session.id === selector || session.id.startsWith(selector));
    if (!selected)
      return { messages: [{ kind: 'error', text: `Archived session not found: ${selector}` }] };
    if (selected.remote?.threadId && r.capy)
      await r.capy.unarchiveThread(selected.remote.threadId, AbortSignal.timeout(10_000));
    await r.store.restoreSession(selected.id);
    ctx.sessionChoices = await r.store.listSessions();
    return { messages: [{ text: `Restored session ${selected.id.slice(0, 8)}.` }] };
  }
  if (['archive', 'delete', 'fork', 'rollout'].includes(command.name)) {
    const busyResult = idleError(control, command.name);
    if (busyResult) return busyResult;
    ctx.sessionChoices = await r.store.listSessions();
    const selected = pickSession(ctx, command.args[0]);
    if (!selected)
      return {
        messages: [
          {
            kind: 'error',
            text: command.args[0]
              ? `Session not found: ${command.args[0]}`
              : 'No active session. Use /resume first or provide a session number.',
          },
        ],
      };
    if (command.name === 'rollout') {
      return {
        messages: [
          {
            text: [
              `session: ${selected.id}`,
              `file: ${r.store.sessionPath(selected.id)}`,
              `created: ${selected.createdAt}`,
              `updated: ${selected.updatedAt}`,
              `messages: ${selected.messages.length}`,
              `checkpoint: ${selected.checkpoint ?? 'none'}`,
            ].join('\n'),
          },
        ],
      };
    }
    if (command.name === 'delete') {
      const label = selected.task?.trim() || selected.id;
      const approved = await control.requestApproval(
        'Delete saved session',
        `${label}\n${selected.id}\nThis cannot be undone.`,
      );
      if (!approved) return { messages: [{ text: 'Session deletion cancelled.' }] };
      const active = backend.session()?.id === selected.id;
      if (active) await control.reset();
      await r.store.deleteSession(selected.id);
      ctx.sessionChoices = ctx.sessionChoices.filter((session) => session.id !== selected.id);
      return {
        clear: active,
        messages: [{ text: `Deleted session ${selected.id.slice(0, 8)}.` }],
      };
    }
    if (command.name === 'archive') {
      if (selected.remote?.threadId && r.capy)
        await r.capy.archiveThread(selected.remote.threadId, AbortSignal.timeout(10_000));
      const active = backend.session()?.id === selected.id;
      await r.store.archiveSession(selected.id);
      if (active) await control.reset();
      ctx.sessionChoices = ctx.sessionChoices.filter((session) => session.id !== selected.id);
      return {
        clear: active,
        messages: [{ text: `Archived session ${selected.id.slice(0, 8)}.` }],
      };
    }
    if (selected.remote)
      return {
        messages: [
          {
            kind: 'error',
            text: 'Forking Capy remote threads is not supported by the current Capy API.',
          },
        ],
      };
    const fork = await r.store.forkSession(selected.id);
    return resumeSession(ctx, control, emit, fork.id);
  }
  if (command.name === 'sessions' || command.name === 'resume') {
    ctx.sessionChoices = await r.store.listSessions();

    if (command.args.length === 1) {
      const sessionArg = command.args[0]!;
      if (/^\d+$/.test(sessionArg)) {
        const idx = parseInt(sessionArg, 10) - 1;
        const picked = ctx.sessionChoices[idx];
        if (!picked) return { messages: [{ kind: 'error', text: `No session #${sessionArg}.` }] };
        return resumeSession(ctx, control, emit, picked.id);
      }
      const matches = ctx.sessionChoices.filter(
        (session) => session.id === sessionArg || session.id.startsWith(sessionArg),
      );
      if (matches.length === 1) return resumeSession(ctx, control, emit, matches[0]!.id);
      if (matches.length > 1)
        return {
          messages: [{ kind: 'error', text: `Session prefix is ambiguous: ${sessionArg}` }],
        };
      return { messages: [{ kind: 'error', text: `Session not found: ${sessionArg}` }] };
    }
    if (command.args.length > 1)
      return { messages: [{ kind: 'error', text: 'Usage: /resume [number|session-id]' }] };

    return {
      messages: [
        {
          text: ctx.sessionChoices.length
            ? `${ctx.sessionChoices.length} session${ctx.sessionChoices.length === 1 ? '' : 's'}. Use the list above — Enter to open, Ctrl+D to delete.`
            : 'No saved sessions yet.',
        },
      ],
    };
  }
  if (command.name === 'model') {
    if (!arg)
      return {
        messages: [
          {
            text: `Active model: ${r.config.model}\nConfigured aliases: ${
              Object.entries(r.config.aliases)
                .map(([name, model]) => `${name} → ${model}`)
                .join(', ') || 'none'
            }\nAvailable from ${r.config.provider}: ${ctx.providerModels.join(', ') || 'unavailable'}`,
          },
        ],
      };
    if (arg === r.config.model) return { messages: [{ text: `Model ${arg} is already active.` }] };
    const providerConfig = { ...(r.config.providers[r.config.provider] ?? {}), model: arg };
    await ctx.replaceRuntime(
      {
        model: arg,
        providers: { ...r.config.providers, [r.config.provider]: providerConfig },
      },
      {
        beforeSwap: () => control.reset(),
      },
    );
    await saveGlobalConfigPatch({
      provider: r.config.provider,
      model: arg,
      providers: { [r.config.provider]: providerConfig },
    });
    return {
      messages: [{ text: `Active model changed to ${ctx.r.config.model}; context was reset.` }],
    };
  }
  if (command.name === 'provider') {
    if (!arg)
      return {
        messages: [
          {
            text: `Active provider: ${r.config.provider}\nAvailable: ${[
              ...new Set([...Object.keys(providerPresets), ...Object.keys(r.config.providers)]),
            ].join(', ')}`,
          },
        ],
      };
    if (command.args.length > 4)
      return {
        messages: [
          {
            kind: 'error',
            text: 'Usage: /provider [name [model]|key|capy <projectId> [captainModel [buildModel]]]',
          },
        ],
      };

    if (command.args.length >= 2 && command.args.length <= 4 && command.args[0] === 'capy') {
      const projectId = command.args[1]!;
      const captainModel = command.args[2];
      const buildModel = command.args[3];
      const configured = r.config.providers.capy ?? {};
      const effectiveApiKey = configured.apiKey ?? process.env.CAPY_API_KEY;
      if (!effectiveApiKey)
        return {
          messages: [{ kind: 'error', text: 'Run /provider capy first to set your API key.' }],
        };
      try {
        const client = new CapyClient({
          baseURL: configured.baseURL ?? providerPresets.capy!.baseURL,
          apiKey: effectiveApiKey,
        });
        const selectedFromDiscovery = ctx.projectChoices.some(
          (project) => project.id === projectId,
        );
        if (!ctx.capyAvailableModels.length) {
          const [, models] = await Promise.all([
            selectedFromDiscovery
              ? Promise.resolve()
              : client.getProject(projectId, AbortSignal.timeout(10_000)),
            client.models(AbortSignal.timeout(10_000)),
          ]);
          ctx.capyAvailableModels = models;
        }
        ctx.projectChoices = [];
        const models = ctx.capyAvailableModels;
        if (!captainModel) {
          const captainModels = models.filter((candidate) => candidate.captainEligible);
          if (!captainModels.length)
            return {
              messages: [
                {
                  kind: 'error',
                  text: 'No Captain-eligible Capy models are available for this account.',
                },
              ],
            };
          ctx.capyModelRole = 'captain';
          ctx.capyModelChoices = captainModels.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            description: `${candidate.provider || 'Capy'} · Captain`,
          }));
          return {
            prefill: `/provider capy ${projectId} `,
            messages: [{ text: 'Choose the model Capy Captain will use.' }],
          };
        }
        const selectedCaptain = models.find(
          (candidate) => candidate.id === captainModel && candidate.captainEligible,
        );
        if (!selectedCaptain)
          return {
            messages: [
              {
                kind: 'error',
                text: `Capy model "${captainModel}" is unavailable or not Captain eligible.`,
              },
            ],
          };
        if (!buildModel) {
          if (!models.length)
            return {
              messages: [{ kind: 'error', text: 'No Capy Build models are available.' }],
            };
          ctx.capyModelRole = 'build';
          ctx.capyModelChoices = models.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            description: `${candidate.provider || 'Capy'} · Build${candidate.id === captainModel ? ' · same as Captain' : ''}`,
          }));
          return {
            prefill: `/provider capy ${projectId} ${captainModel} `,
            messages: [{ text: 'Choose the model Capy Build will use.' }],
          };
        }
        if (!models.some((candidate) => candidate.id === buildModel))
          return {
            messages: [{ kind: 'error', text: `Capy Build model "${buildModel}" is unavailable.` }],
          };
        const capyConfig = {
          ...configured,
          projectId,
          model: captainModel,
          buildModel,
        };
        await ctx.replaceRuntime(
          {
            provider: 'capy',
            model: captainModel,
            providers: { ...r.config.providers, capy: capyConfig },
          },
          { beforeSwap: () => control.reset() },
        );
        await saveProviderSelection('capy', {
          ...(configured.apiKey ? { apiKey: configured.apiKey } : {}),
          projectId,
          model: captainModel,
          buildModel,
        });
        ctx.capyModelChoices = [];
        ctx.capyAvailableModels = [];
        ctx.capyModelRole = undefined;
        void ctx.refreshProviderModels();
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
            text: `Active provider: capy · project ${projectId} · Captain ${captainModel} · Build ${buildModel}`,
          },
        ],
      };
    }
    if (command.args.length < 1 || command.args.length > 2)
      return {
        messages: [{ kind: 'error', text: 'Usage: /provider [name [model]|key]' }],
      };
    const updateCredentials = command.args[0] === 'key';
    if (updateCredentials && command.args.length !== 1)
      return { messages: [{ kind: 'error', text: 'Usage: /provider key' }] };
    const providerName = updateCredentials ? r.config.provider : command.args[0]!;
    const requestedModel = updateCredentials ? undefined : command.args[1];
    const preset = providerPresets[providerName];
    const configured = r.config.providers[providerName];
    if (!preset && !configured)
      return {
        messages: [{ kind: 'error', text: `Unknown provider: ${providerName}` }],
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
            text: 'Wait for or cancel the active request before changing provider credentials.',
          },
        ],
      };
    const local = ['ollama', 'lmstudio', 'vllm'].includes(providerName);
    const existingApiKey = configured?.apiKey ?? (preset ? process.env[preset.env] : undefined);
    const sameProvider = providerName === r.config.provider;
    if (
      sameProvider &&
      providerName !== 'capy' &&
      !updateCredentials &&
      !requestedModel &&
      (existingApiKey || local || !preset)
    )
      return {
        messages: [
          {
            text: existingApiKey
              ? `Provider ${providerName} is already active; saved credentials reused.`
              : `Provider ${providerName} is already active; configuration unchanged.`,
          },
        ],
      };
    let apiKey: string | undefined;
    if (updateCredentials || (!existingApiKey && preset && !local)) {
      apiKey = await control.promptSecret(`API token for ${providerName}`);
      if (apiKey === undefined)
        return {
          messages: [
            {
              kind: 'status',
              text: updateCredentials
                ? 'Credential update cancelled.'
                : 'Provider selection cancelled.',
            },
          ],
        };
    }
    if (updateCredentials && !apiKey)
      return {
        messages: [{ kind: 'error', text: 'Enter a non-empty API token to replace the key.' }],
      };
    if (!apiKey && !existingApiKey && preset && !local)
      return {
        messages: [
          {
            kind: 'error',
            text: `An API token is required for ${providerName}. Select it again or configure ${preset.env}.`,
          },
        ],
      };

    let projectId = providerName === 'capy' ? undefined : configured?.projectId;
    if (providerName === 'capy' && !projectId) {
      ctx.projectChoices = [];
      ctx.capyModelChoices = [];
      ctx.capyAvailableModels = [];
      ctx.capyModelRole = undefined;
      const effectiveKey = apiKey ?? existingApiKey;
      if (!effectiveKey) {
        return {
          messages: [{ kind: 'error', text: 'A Capy API key is required to select a project.' }],
        };
      }
      try {
        const client = new CapyClient({
          baseURL: configured?.baseURL ?? preset?.baseURL ?? 'https://capy.ai/api/v1',
          apiKey: effectiveKey,
        });
        const projects = await client.projects(AbortSignal.timeout(10_000));
        if (projects.length) {
          if (apiKey) {
            const capyConfig = { ...configured, apiKey };
            await saveGlobalConfigPatch({ providers: { capy: capyConfig } });
            r.config.providers.capy = capyConfig;
          }

          ctx.projectChoices = projects.map((p) => ({
            id: p.id,
            name: p.name,
            description:
              [p.description, p.repos.map((r) => r.repoFullName).join(', ')]
                .filter(Boolean)
                .join(' · ') || 'no repositories',
          }));
          return {
            prefill: '/provider capy ',
            messages: [{ text: 'Choose an accessible Capy project.' }],
          };
        } else {
          return {
            messages: [
              {
                kind: 'error',
                text: 'This Capy API key has no accessible projects. Add a project in Capy and try again.',
              },
            ],
          };
        }
      } catch (error) {
        return {
          messages: [
            {
              kind: 'error',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    }
    const providerModel = requestedModel ?? configured?.model;
    const providers =
      apiKey || projectId || providerModel
        ? {
            ...r.config.providers,
            [providerName]: {
              ...configured,
              ...(apiKey ? { apiKey } : {}),
              ...(projectId ? { projectId } : {}),
              ...(providerModel ? { model: providerModel } : {}),
            },
          }
        : r.config.providers;
    try {
      await ctx.replaceRuntime(
        {
          provider: providerName,
          providers,
          ...(providerModel ? { model: providerModel } : {}),
        },
        sameProvider ? { preserveCompatibleSession: true } : { beforeSwap: () => control.reset() },
      );
      await saveProviderSelection(providerName, {
        ...(apiKey ? { apiKey } : {}),
        ...(providerModel ? { model: providerModel } : {}),
        ...(projectId ? { projectId } : {}),
      });
      void ctx.refreshProviderModels();
    } catch (error) {
      return {
        messages: [{ kind: 'error', text: error instanceof Error ? error.message : String(error) }],
      };
    }
    return {
      messages: [
        {
          text: sameProvider
            ? apiKey
              ? `Credentials updated for ${providerName}; session context was preserved.`
              : `Provider ${providerName} is already active; saved credentials reused.`
            : `Active provider changed to ${ctx.r.config.provider}; incompatible context was reset.`,
        },
      ],
    };
  }
  if (command.name === 'approval' || command.name === 'permissions') {
    if (!arg) return { messages: [{ text: `Approval mode: ${r.config.approval}` }] };
    if (!['suggest', 'auto-edit', 'full-auto'].includes(arg))
      return {
        messages: [
          {
            kind: 'error',
            text: `Usage: /${command.name} <suggest|auto-edit|full-auto>`,
          },
        ],
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
    if (arg === r.config.approval)
      return { messages: [{ text: `Approval mode ${arg} is already active.` }] };
    await ctx.replaceRuntime(
      { approval: arg as KyokaoConfig['approval'] },
      { preserveCompatibleSession: true },
    );
    await saveGlobalConfigPatch({ approval: arg as KyokaoConfig['approval'] });
    return { messages: [{ text: `Approval mode changed to ${ctx.r.config.approval}.` }] };
  }
  if (command.name === 'memory' || command.name === 'memories') {
    const [operation, key, ...value] = command.args;
    if (!operation || operation === 'list') {
      ctx.memoryChoices = await r.store.getMemory();
      return { messages: [{ text: JSON.stringify(ctx.memoryChoices, null, 2) }] };
    }
    if (operation === 'set' && key && value.length) {
      await r.store.setMemory(key, value.join(' '));
      ctx.memoryChoices[key] = value.join(' ');
      return { messages: [{ text: `Saved memory "${key}".` }] };
    }
    if (operation === 'delete' && key) {
      if (!Object.hasOwn(ctx.memoryChoices, key))
        return { messages: [{ kind: 'error', text: `Memory key not found: ${key}` }] };
      await r.store.deleteMemory(key);
      delete ctx.memoryChoices[key];
      return { messages: [{ text: `Deleted memory "${key}".` }] };
    }
    return {
      messages: [{ kind: 'error', text: 'Usage: /memory [list|set <key> <value>|delete <key>]' }],
    };
  }
  if (command.name === 'review') {
    const instructions =
      arg ||
      'Review the current working-tree changes for bugs, security risks, regressions, and missing tests. Report findings by severity with file references.';
    await control.enqueue(instructions);
    return {
      messages: [{ text: 'Started a review of the current changes.' }],
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
            text: `provider: capy (${redactEndpoint(r.capy!.baseURL)})\ncredentials: ${r.providerOptions.apiKey ? 'configured' : 'missing'}\nmodel: ${model ? `${model.id} (Captain eligible)` : 'unavailable'}\nproject: ${project ? `${project.name} (${project.id})` : 'unavailable'}\nexecution: remote connected repositories/VMs; local uncommitted files are not used`,
          },
        ],
      };
    }
    const model = ctx.skipModelCheck ? undefined : await r.provider.validateModel();
    return {
      messages: [
        {
          text: `node: ${process.version}\nworkspace: ${r.root}\nprovider: ${r.config.provider} (${redactEndpoint(r.provider.baseURL)})\ncredentials: ${r.providerOptions.apiKey ? 'configured' : 'missing'}\nmodel: ${model?.id ?? 'not checked'}\nsandbox: enabled`,
        },
      ],
    };
  }
  if (command.name === 'diff') {
    if (command.args.length) {
      if (r.config.provider !== 'capy' || !r.capy)
        return {
          messages: [{ kind: 'error', text: 'Task diffs require the Capy provider.' }],
        };
      const taskId = command.args[0]!;
      try {
        const diff = await r.capy.getTaskDiff(taskId);
        const body =
          diff.files
            .map(
              (file) =>
                `${file.additions > 0 ? '+' : ''}${file.additions} -${file.deletions}  ${file.path}${file.patch ? `\n${file.patch}` : ''}`,
            )
            .join('\n') || 'No changes in this task.';
        emit(
          'tool',
          `${diff.stats.additions} additions, ${diff.stats.deletions} deletions across ${diff.stats.files} file(s)\n${body}`,
        );
      } catch (error) {
        return {
          messages: [
            { kind: 'error', text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
      return;
    }
    if (r.config.provider === 'capy')
      return {
        messages: [
          {
            kind: 'error',
            text: 'Capy edits remote connected repositories/VMs. Use /diff <taskId> to inspect a task diff, or /capy for PR links.',
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
    if (command.args.length && command.args[0] !== 'list')
      return {
        messages: [{ kind: 'error', text: 'Usage: /queue [list|clear|retry]' }],
      };
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
            ...(status.waitingOn?.length ? [`waiting on: ${status.waitingOn.join(', ')}`] : []),
            ...(status.blockedOn?.length ? [`blocked on: ${status.blockedOn.join(', ')}`] : []),
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

  if (command.name === 'threads') {
    if (r.config.provider !== 'capy' || !r.capy)
      return { messages: [{ kind: 'error', text: 'Threads require the Capy provider.' }] };
    const projectId = r.config.providers.capy?.projectId;
    if (!projectId)
      return {
        messages: [{ kind: 'error', text: 'No Capy project selected. Run /provider capy first.' }],
      };
    try {
      const query = command.args.join(' ').trim();
      const threads = await r.capy.listThreads(
        query ? { projectId, q: query, limit: 20 } : { projectId, limit: 20 },
        AbortSignal.timeout(10_000),
      );
      return {
        messages: [
          {
            text: threads.length
              ? threads
                  .map(
                    (thread) =>
                      `${thread.id}  ${thread.runState.padEnd(8)}  ${(thread.title ?? '(untitled)').slice(0, 50)}${thread.tasks.length ? `  · ${thread.tasks[0]!.identifier}` : ''}`,
                  )
                  .join('\n')
              : 'No threads found for this project.',
          },
        ],
      };
    } catch (error) {
      return {
        messages: [{ kind: 'error', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  if (command.name === 'task') {
    if (r.config.provider !== 'capy' || !r.capy)
      return { messages: [{ kind: 'error', text: 'Task lookup requires the Capy provider.' }] };
    if (command.args.length !== 1)
      return { messages: [{ kind: 'error', text: 'Usage: /task <task-id>' }] };
    try {
      const task = await r.capy.getTask(command.args[0]!, AbortSignal.timeout(10_000));
      return {
        messages: [
          {
            text: [
              `${task.identifier}  ${task.title}  [${task.status}]`,
              `id: ${task.id}`,
              `project: ${task.projectId}`,
              task.threadId ? `thread: ${task.threadId}` : '',
              `prompt: ${task.prompt}`,
              task.pullRequest
                ? `PR: ${task.pullRequest.repoFullName}#${task.pullRequest.number} (${task.pullRequest.state}) ${task.pullRequest.url}`
                : '',
              task.createdAt ? `created: ${task.createdAt}` : '',
              '',
              'Use /diff <task-id> to see the changes.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    } catch (error) {
      return {
        messages: [{ kind: 'error', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  if (command.name === 'tags') {
    if (r.config.provider !== 'capy' || !r.capy)
      return { messages: [{ kind: 'error', text: 'Tags require the Capy provider.' }] };
    const projectId = r.config.providers.capy?.projectId;
    if (!projectId) return { messages: [{ kind: 'error', text: 'No Capy project selected.' }] };
    const [subcommand, ...rest] = command.args;
    try {
      if (subcommand === 'create') {
        if (!rest.length)
          return { messages: [{ kind: 'error', text: 'Usage: /tags create <name> [color]' }] };
        const [name, requestedColor = 'default'] = rest;
        if (!CAPY_TAG_COLORS.has(requestedColor as CapyTagColor)) {
          return {
            messages: [
              {
                kind: 'error',
                text: `Unknown tag color "${requestedColor}". Choose: ${[...CAPY_TAG_COLORS].join(', ')}.`,
              },
            ],
          };
        }
        const tag = await r.capy.createThreadTag(projectId, {
          name: name!,
          color: requestedColor as CapyTagColor,
        });
        return {
          messages: [{ text: `Created tag "${tag.name}"${tag.color ? ` (${tag.color})` : ''}.` }],
        };
      }
      if (subcommand === 'set') {
        const threadId = backend.session()?.remote?.threadId;
        if (!threadId)
          return {
            messages: [{ kind: 'error', text: 'No active Capy thread. Send a prompt first.' }],
          };
        if (!rest.length)
          return { messages: [{ kind: 'error', text: 'Usage: /tags set <name> [name...]' }] };
        const set = await r.capy.setThreadTags(threadId, rest);
        return {
          messages: [
            {
              text: `Thread ${threadId} now tagged: ${set.map((t) => t.name).join(', ') || '(none)'}.`,
            },
          ],
        };
      }
      const tags = await r.capy.listThreadTags(projectId);
      return {
        messages: [
          {
            text: tags.length
              ? [
                  `Tags for project ${projectId}:`,
                  ...tags.map((tag) => `  ${tag.color ?? '·'}  ${tag.name}`),
                  '',
                  'Use /tags set <name> to tag the current thread, or /tags create <name> [color].',
                ].join('\n')
              : `No tags defined for project ${projectId}. Use /tags create <name> to add one.`,
          },
        ],
      };
    } catch (error) {
      return {
        messages: [{ kind: 'error', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  if (command.name === 'usage') {
    if (r.config.provider !== 'capy' || !r.capy) {
      const usage = backend.session()?.usage;
      return {
        messages: [
          {
            text: usage
              ? [
                  `requests: ${usage.requests}`,
                  `prompt tokens: ${usage.promptTokens.toLocaleString()}`,
                  `completion tokens: ${usage.completionTokens.toLocaleString()}`,
                  `total tokens: ${usage.totalTokens.toLocaleString()}`,
                  `estimated cost: $${usage.estimatedCostUsd.toFixed(4)}`,
                ].join('\n')
              : 'No local usage has been recorded in this session.',
          },
        ],
      };
    }
    try {
      const [orgId, from, to] = command.args;
      const usage = await r.capy.getUsage(
        {
          orgId: orgId ?? 'me',
          from: capyUsageBoundary(from, false),
          to: capyUsageBoundary(to, true),
        },
        AbortSignal.timeout(10_000),
      );
      const totals = usage.totals;
      return {
        messages: [
          {
            text: [
              `Capy usage ${usage.from} → ${usage.to} (${usage.currency})`,
              totals.totalDollars != null ? `total: $${totals.totalDollars.toFixed(2)}` : '',
              totals.llmDollars != null ? `llm:   $${totals.llmDollars.toFixed(2)}` : '',
              totals.vmDollars != null ? `vm:    $${totals.vmDollars.toFixed(2)}` : '',
              `page ${usage.page} of ${usage.totalPages} (${usage.total} entries)`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    } catch (error) {
      return {
        messages: [{ kind: 'error', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  if (command.name === 'rename') {
    const title = command.args.join(' ').trim();
    if (!title) return { messages: [{ kind: 'error', text: 'Usage: /rename <title>' }] };
    const session = backend.session();
    if (session) {
      session.task = title;
      await r.store.saveSession(session);
    }
    return { messages: [{ text: `Session renamed to "${title}".` }] };
  }

  if (command.name === 'context' || command.name === 'status') {
    const session = backend.session();
    const budget = r.config.contextWindow;
    const threshold = Math.floor(budget * (r.config.compressionThreshold ?? 0.8));
    if (!session) {
      return {
        messages: [
          {
            text:
              command.name === 'status'
                ? [
                    `provider: ${r.config.provider}`,
                    `model: ${r.config.model}`,
                    `approval: ${r.config.approval}`,
                    'session: none',
                    `context budget: ${budget.toLocaleString()} tokens`,
                  ].join('\n')
                : `Context budget: ${budget.toLocaleString()} tokens (compress at ${threshold.toLocaleString()}).`,
          },
        ],
      };
    }
    const current = estimateTokens(session.messages);
    const pct = budget > 0 ? Math.round((current / budget) * 100) : 0;
    const usage = session.usage;
    return {
      messages: [
        {
          text: [
            ...(command.name === 'status'
              ? [
                  `provider: ${r.config.provider}`,
                  `model: ${r.config.model}`,
                  `approval: ${r.config.approval}`,
                  `session: ${session.id}`,
                ]
              : []),
            `transcript: ${current.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%)`,
            `compress at: ${threshold.toLocaleString()} tokens`,
            usage
              ? `session total: ${usage.totalTokens.toLocaleString()} tokens · ${usage.requests} requests · $${usage.estimatedCostUsd.toFixed(4)}`
              : '',
            usage?.compressedMessages ? `compacted: ${usage.compressedMessages} messages` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    };
  }

  if (command.name === 'compact') {
    const state = control.scheduler();
    if (state.active || state.phase === 'stopping' || state.phase === 'starting-replacement')
      return {
        messages: [
          {
            kind: 'error',
            text: 'Cannot compact while a request is active. Wait for it to finish or cancel with Esc.',
          },
        ],
      };
    const session = backend.session();
    if (!session || session.remote)
      return {
        messages: [{ kind: 'error', text: 'No local session transcript to compact.' }],
      };
    const budget = Math.floor(r.config.contextWindow * (r.config.compressionThreshold ?? 0.8));
    const before = estimateTokens(session.messages);
    const result = compressMessages(session.messages, budget);
    if (!result.removed)
      return {
        messages: [
          {
            text: `Transcript is already within budget (${before.toLocaleString()} tokens). Nothing to compact.`,
          },
        ],
      };
    session.messages = result.messages;
    if (result.summary) session.contextSummary = result.summary;
    session.usage = session.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0,
      estimatedCostUsd: 0,
      compressedMessages: 0,
    };
    session.usage.compressedMessages += result.removed;
    await r.store.saveSession(session);
    const after = estimateTokens(session.messages);
    return {
      messages: [
        {
          text: `Compacted ${result.removed} message(s): ${before.toLocaleString()} → ${after.toLocaleString()} tokens.`,
        },
      ],
    };
  }

  if (command.name === 'rewind') {
    const state = control.scheduler();
    if (state.active || state.phase === 'stopping' || state.phase === 'starting-replacement')
      return {
        messages: [{ kind: 'error', text: 'Cannot rewind while a request is active.' }],
      };
    const session = backend.session();
    if (!session || session.remote)
      return {
        messages: [{ kind: 'error', text: 'No local session transcript to rewind.' }],
      };
    const messages = session.messages;
    if (messages.length <= 1) return { messages: [{ text: 'Nothing to rewind.' }] };
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser < 0) return { messages: [{ text: 'Could not identify a turn to rewind.' }] };
    const end = lastUser;
    const dropped = messages.length - end;
    session.messages = messages.slice(0, end);
    await r.store.saveSession(session);
    return {
      clear: true,
      messages: [
        ...sessionTranscriptMessages(session),
        { text: `Rewound ${dropped} message(s). The next prompt starts fresh from there.` },
      ],
    };
  }

  if (command.name === 'copy') {
    const session = backend.session();
    const messages = session?.messages ?? [];
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
    if (!lastAssistant?.content)
      return { messages: [{ kind: 'error', text: 'No assistant reply to copy.' }] };
    const ok = copyToClipboard(lastAssistant.content);
    return {
      messages: [
        ok
          ? { text: `Copied ${lastAssistant.content.length} characters to the clipboard.` }
          : {
              kind: 'error',
              text: 'No clipboard utility found. Install xclip (Linux) or run on macOS/Windows.',
            },
      ],
    };
  }

  if (command.name === 'plan') {
    const session = backend.session();
    const [subcommand] = command.args;
    if (subcommand === 'clear') {
      if (session) {
        session.plan = [];
        await r.store.saveSession(session);
      }
      return { messages: [{ text: 'Plan cleared.' }] };
    }
    if (subcommand === 'run') {
      const steps = session?.plan ?? [];
      if (!steps.length)
        return { messages: [{ text: 'Plan is empty. Use /plan <step> to add steps.' }] };
      for (const step of steps) await control.enqueue(step);
      return {
        messages: [{ text: `Enqueued ${steps.length} plan step(s). They will run in order.` }],
      };
    }
    const stepText = command.args.join(' ').trim();
    if (!stepText)
      return {
        messages: [
          {
            text: [
              'Usage: /plan <step> | /plan run | /plan clear',
              session?.plan?.length
                ? `Current plan (${session.plan.length} step${session.plan.length === 1 ? '' : 's'}):`
                : 'Plan is empty.',
              ...(session?.plan ?? []).map((item, i) => `  ${i + 1}. ${item}`),
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    if (session) {
      session.plan = [...(session.plan ?? []), stepText];
      await r.store.saveSession(session);
    }
    return { messages: [{ text: `Added step ${session?.plan?.length ?? 1}: ${stepText}` }] };
  }

  if (command.name === 'view-plan') {
    const plan = backend.session()?.plan ?? [];
    return {
      messages: [
        {
          text: plan.length
            ? [
                `Plan (${plan.length} step${plan.length === 1 ? '' : 's'}):`,
                ...plan.map((step, i) => `  ${i + 1}. ${step}`),
                '',
                'Use /plan run to enqueue all steps, or /plan clear to reset.',
              ].join('\n')
            : 'No plan set. Use /plan <step> to build one.',
        },
      ],
    };
  }
  return {
    messages: [
      {
        kind: 'error',
        text: `Command /${command.name} is registered but has no implementation.`,
      },
    ],
  };
}
