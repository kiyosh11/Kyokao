// @ts-nocheck

import { providerPresets } from '@kyokao/config';
import { CODE_THEME_NAMES, TUI_THEME_NAMES } from '@kyokao/themes';
import type { CommandDefinition } from '@kyokao/ui';
import { workspaceCommands } from '@kyokao/ui';
import { choicePalette, type TuiContext } from './tui-context.js';

function themeDisplayName(value: string): string {
  return value
    .split('-')
    .map((part) => {
      if (part === 'github') return 'GitHub';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function approvalDisplayName(value: string): string {
  if (value === 'auto-edit') return 'Auto Edit';
  if (value === 'full-auto') return 'Full Auto';
  return 'Suggest';
}

export function buildCommandPalette(
  value: string,
  ctx: TuiContext,
): CommandDefinition[] | undefined {
  const { r, sessionChoices, memoryChoices, providerModels, projectChoices, capyModelChoices } =
    ctx;
  const personality = ctx.backend.session()?.personality ?? 'default';
  // These commands act on the current session with no arguments. Only open
  // their saved-session chooser after the user adds a space (usually via Tab).
  if (/^\/(?:fork|archive|delete|rollout)$/i.test(value)) return undefined;

  const capyBuildModelMatch = value.match(/^\/provider\s+capy\s+(\S+)\s+(\S+)\s+(.*)$/i);
  if (capyBuildModelMatch && ctx.capyModelRole === 'build' && capyModelChoices.length) {
    const projectId = capyBuildModelMatch[1]!;
    const captainModel = capyBuildModelMatch[2]!;
    const query = capyBuildModelMatch[3]!.trimStart().toLowerCase();
    return capyModelChoices
      .filter(
        (model) =>
          model.name.toLowerCase().includes(query) || model.id.toLowerCase().startsWith(query),
      )
      .map((model) => ({
        name: 'provider' as const,
        group: 'model' as const,
        syntax: `/provider capy ${projectId} ${captainModel} ${model.id}`,
        label: model.name,
        description: model.description ?? 'Build model',
        completion: `/provider capy ${projectId} ${captainModel} ${model.id}`,
        submit: true,
      }));
  }
  const capyCaptainModelMatch = value.match(/^\/provider\s+capy\s+(\S+)\s+(.*)$/i);
  if (capyCaptainModelMatch && ctx.capyModelRole === 'captain' && capyModelChoices.length) {
    const projectId = capyCaptainModelMatch[1]!;
    const query = capyCaptainModelMatch[2]!.trimStart().toLowerCase();
    return capyModelChoices
      .filter(
        (model) =>
          model.name.toLowerCase().includes(query) || model.id.toLowerCase().startsWith(query),
      )
      .map((model) => ({
        name: 'provider' as const,
        group: 'model' as const,
        syntax: `/provider capy ${projectId} ${model.id}`,
        label: model.name,
        description: model.description ?? 'Captain eligible',
        completion: `/provider capy ${projectId} ${model.id}`,
        submit: true,
      }));
  }
  const projectMatch = value.match(/^\/provider\s+capy\s+(.*)$/i);
  if (projectMatch && projectChoices.length) {
    const query = projectMatch[1]!.trimStart().toLowerCase();
    return projectChoices
      .filter((p) => p.name.toLowerCase().includes(query) || p.id.toLowerCase().startsWith(query))
      .map((p) => ({
        name: 'provider' as const,
        group: 'model' as const,
        syntax: `/provider capy ${p.id}`,
        label: p.name,
        description: p.description ?? p.id,
        completion: `/provider capy ${p.id}`,
        submit: true,
      }));
  }
  const providers = [
    ...new Set([...Object.keys(providerPresets), ...Object.keys(r.config.providers)]),
  ]
    .sort((left, right) => {
      if (left === r.config.provider) return -1;
      if (right === r.config.provider) return 1;
      return left.localeCompare(right);
    })
    .map((name) => {
      const preset = providerPresets[name];
      const configured = r.config.providers[name];
      const local = ['ollama', 'lmstudio', 'vllm'].includes(name);
      const kind = preset?.remote ? 'remote agent' : local ? 'local' : 'OpenAI-compatible';
      const readiness =
        configured || local || (preset && process.env[preset.env])
          ? 'configured'
          : 'needs credentials';
      return {
        value: name,
        label: name,
        description: `${name === r.config.provider ? 'active · ' : ''}${kind} · ${readiness}`,
      };
    });
  const models: Array<{ value: string; label?: string; description: string }> = [
    { value: r.config.model, description: 'active model' },
  ];
  const modelNames = new Set([r.config.model]);
  for (const [name, model] of Object.entries(r.config.aliases)) {
    if (modelNames.has(name)) continue;
    modelNames.add(name);
    models.push({ value: name, label: name, description: `alias → ${model}` });
  }
  for (const model of providerModels) {
    if (modelNames.has(model)) continue;
    modelNames.add(model);
    models.push({ value: model, label: model, description: r.config.provider });
  }
  const memoryDelete = value.match(/^\/(memory|memories)\s+delete(?:\s+(.*))?$/i);
  if (memoryDelete) {
    const command = memoryDelete[1]!.toLowerCase() as 'memory' | 'memories';
    const query = (memoryDelete[2] ?? '').trimStart().toLowerCase();
    return Object.keys(memoryChoices)
      .filter((key) => key.toLowerCase().startsWith(query))
      .sort()
      .map((key) => ({
        name: command,
        group: 'workspace' as const,
        syntax: `/${command} delete ${key}`,
        label: key,
        description: 'delete saved memory',
        completion: `/${command} delete ${key}`,
        submit: true,
      }));
  }
  const settingsTheme = value.match(/^\/settings\s+theme(?:\s+(.*))?$/i);
  if (settingsTheme) {
    const query = (settingsTheme[1] ?? '').trimStart().toLowerCase();
    return TUI_THEME_NAMES.filter((name) => name.startsWith(query)).map((name) => ({
      name: 'settings' as const,
      group: 'setup' as const,
      syntax: `/settings theme ${name}`,
      label: themeDisplayName(name),
      description: `${r.config.theme === name ? 'active · ' : ''}TUI colors and background`,
      completion: `/settings theme ${name}`,
      submit: true,
    }));
  }
  const settingsCodeTheme = value.match(/^\/settings\s+code-theme(?:\s+(.*))?$/i);
  if (settingsCodeTheme) {
    const query = (settingsCodeTheme[1] ?? '').trimStart().toLowerCase();
    return CODE_THEME_NAMES.filter((name) => name.startsWith(query)).map((name) => ({
      name: 'settings' as const,
      group: 'setup' as const,
      syntax: `/settings code-theme ${name}`,
      label: themeDisplayName(name),
      description: `${r.config.codeTheme === name ? 'active · ' : ''}Markdown code highlighting`,
      completion: `/settings code-theme ${name}`,
      submit: true,
    }));
  }
  const settingsPermissions = value.match(/^\/settings\s+permissions(?:\s+(.*))?$/i);
  if (settingsPermissions) {
    const query = (settingsPermissions[1] ?? '').trimStart().toLowerCase();
    return [
      { value: 'suggest', description: 'ask before edits and commands' },
      { value: 'auto-edit', description: 'allow edits; ask before commands' },
      { value: 'full-auto', description: 'allow edits and commands' },
    ]
      .filter((choice) => choice.value.startsWith(query))
      .map((choice) => ({
        name: 'settings' as const,
        group: 'setup' as const,
        syntax: `/settings permissions ${choice.value}`,
        label: approvalDisplayName(choice.value),
        description: `${r.config.approval === choice.value ? 'active · ' : ''}${choice.description}`,
        completion: `/settings permissions ${choice.value}`,
        submit: true,
      }));
  }
  const settings = value.match(/^\/settings(?:\s+(.*))?$/i);
  if (settings) {
    const query = (settings[1] ?? '').trimStart().toLowerCase();
    const thinkingTarget = r.config.tui.showThinking ? 'off' : 'on';
    const subagentTarget = r.config.subagents.enabled ? 'off' : 'on';
    return [
      {
        value: 'thinking',
        label: 'Thinking',
        description: `${r.config.tui.showThinking ? 'on' : 'off'} · Enter to turn ${thinkingTarget}`,
        completion: `/settings thinking ${thinkingTarget}`,
        submit: true,
      },
      {
        value: 'provider',
        label: 'Provider',
        description: r.config.provider,
        completion: '/provider ',
      },
      {
        value: 'model',
        label: 'Model',
        description: r.config.model,
        completion: '/model ',
      },
      {
        value: 'permissions',
        label: 'Permissions',
        description: r.config.approval,
        completion: '/settings permissions ',
      },
      {
        value: 'theme',
        label: 'TUI theme',
        description: themeDisplayName(r.config.theme),
        completion: '/settings theme ',
      },
      {
        value: 'code-theme',
        label: 'Code theme',
        description: themeDisplayName(r.config.codeTheme),
        completion: '/settings code-theme ',
      },
      {
        value: 'subagents',
        label: 'Subagents',
        description: `${r.config.subagents.enabled ? 'on' : 'off'} · Enter to turn ${subagentTarget}`,
        completion: `/settings subagents ${subagentTarget}`,
        submit: true,
      },
    ]
      .filter(
        (choice) => choice.value.startsWith(query) || choice.label.toLowerCase().startsWith(query),
      )
      .map((choice) => ({
        name: 'settings' as const,
        group: 'setup' as const,
        syntax: `/settings ${choice.value}`,
        label: choice.label,
        description: choice.description,
        completion: choice.completion,
        submit: choice.submit ?? false,
      }));
  }
  const result =
    choicePalette(value, 'provider', [
      ...providers,
      {
        value: 'key',
        label: 'Change API key…',
        description: `replace the saved key for ${r.config.provider}`,
      },
    ]) ??
    choicePalette(value, 'model', models) ??
    choicePalette(value, 'approval', [
      {
        value: 'suggest',
        label: 'Suggest',
        description: `${r.config.approval === 'suggest' ? 'active · ' : ''}ask before edits and commands`,
      },
      {
        value: 'auto-edit',
        label: 'Auto Edit',
        description: `${r.config.approval === 'auto-edit' ? 'active · ' : ''}allow file edits; ask before commands`,
      },
      {
        value: 'full-auto',
        label: 'Full Auto',
        description: `${r.config.approval === 'full-auto' ? 'active · ' : ''}allow edits and commands`,
      },
    ]) ??
    choicePalette(value, 'permissions', [
      {
        value: 'suggest',
        label: 'Suggest',
        description: `${r.config.approval === 'suggest' ? 'active · ' : ''}ask before edits and commands`,
      },
      {
        value: 'auto-edit',
        label: 'Auto Edit',
        description: `${r.config.approval === 'auto-edit' ? 'active · ' : ''}allow file edits; ask before commands`,
      },
      {
        value: 'full-auto',
        label: 'Full Auto',
        description: `${r.config.approval === 'full-auto' ? 'active · ' : ''}allow edits and commands`,
      },
    ]) ??
    choicePalette(value, 'personality', [
      { value: 'default', description: 'balanced Kyokao response style' },
      { value: 'concise', description: 'short, direct responses' },
      { value: 'friendly', description: 'warm, conversational responses' },
      { value: 'technical', description: 'implementation-focused technical detail' },
    ]) ??
    choicePalette(value, 'subagents', [
      {
        value: 'on',
        description: `${r.config.subagents.enabled ? 'active Â· ' : ''}enable local subagent tools`,
      },
      {
        value: 'off',
        description: `${!r.config.subagents.enabled ? 'active Â· ' : ''}disable local subagent tools`,
      },
    ]) ??
    choicePalette(value, 'memory', [
      { value: 'list', description: 'show saved memory' },
      {
        value: 'set',
        description: 'save a key and value',
        completion: '/memory set ',
        submit: false,
      },
      {
        value: 'delete',
        description: 'delete a saved key',
        completion: '/memory delete ',
        submit: false,
      },
    ]) ??
    choicePalette(value, 'memories', [
      { value: 'list', description: 'show saved memory' },
      {
        value: 'set',
        description: 'save a key and value',
        completion: '/memories set ',
        submit: false,
      },
      {
        value: 'delete',
        description: 'delete a saved key',
        completion: '/memories delete ',
        submit: false,
      },
    ]) ??
    choicePalette(value, 'queue', [
      { value: 'list', description: 'show queued prompts' },
      { value: 'clear', description: 'remove all queued prompts' },
      { value: 'retry', description: 'retry after a queue error' },
    ]) ??
    choicePalette(
      value,
      'sessions',
      sessionChoices.map((session, i) => ({
        value: String(i + 1),
        label: session.task?.trim().slice(0, 36) || session.id.slice(0, 12),
        description: `${session.checkpoint ?? 'saved'} · ${(session.updatedAt ?? '').slice(0, 16).replace('T', ' ')}`,
      })),
    ) ??
    choicePalette(
      value,
      'resume',
      sessionChoices.map((session, i) => ({
        value: String(i + 1),
        label: session.task?.trim().slice(0, 36) || session.id.slice(0, 12),
        description: `${session.checkpoint ?? 'saved'} · ${(session.updatedAt ?? '').slice(0, 16).replace('T', ' ')}`,
      })),
    ) ??
    choicePalette(value, 'archive', [
      { value: 'list', description: 'list archived sessions' },
      {
        value: 'restore',
        description: 'restore an archived session by number or ID',
        completion: '/archive restore ',
        submit: false,
      },
      ...sessionChoices.map((session, i) => ({
        value: String(i + 1),
        label: session.task?.trim().slice(0, 36) || session.id.slice(0, 12),
        description: `archive - ${session.checkpoint ?? 'saved'}`,
      })),
    ]) ??
    (['fork', 'delete', 'rollout'] as const)
      .map((command) =>
        choicePalette(
          value,
          command,
          sessionChoices.map((session, i) => ({
            value: String(i + 1),
            label: session.task?.trim().slice(0, 36) || session.id.slice(0, 12),
            description: `${session.checkpoint ?? 'saved'} Â· ${(session.updatedAt ?? '').slice(0, 16).replace('T', ' ')}`,
          })),
        ),
      )
      .find(Boolean) ??
    choicePalette(
      value,
      'help',
      workspaceCommands.map((entry) => ({
        value: entry.name,
        label: `/${entry.name}`,
        description: entry.description,
      })),
    );
  const activeValue =
    result?.[0]?.name === 'approval' || result?.[0]?.name === 'permissions'
      ? r.config.approval
      : result?.[0]?.name === 'personality'
        ? personality
        : result?.[0]?.name === 'subagents'
          ? r.config.subagents.enabled
            ? 'on'
            : 'off'
          : undefined;
  if (result && activeValue) {
    const index = result.findIndex((entry) => entry.completion === `/${entry.name} ${activeValue}`);
    if (index > 0) result.unshift(...result.splice(index, 1));
  }
  return result;
}
