import {
  CODE_THEME_NAMES,
  TUI_THEME_NAMES,
  isCodeThemeName,
  isTuiThemeName,
  suggestName,
} from '@kyokao/themes';
import type { KyokaoConfig } from './types.js';

export function validateConfig(value: unknown): asserts value is Partial<KyokaoConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('must be an object');
  const c = value as Record<string, unknown>;
  for (const key of ['provider', 'model', 'theme', 'codeTheme'])
    if (key in c && typeof c[key] !== 'string') throw new Error(`${key} must be a string`);
  if ('theme' in c && !isTuiThemeName(c.theme as string))
    throw new Error(
      `Unknown TUI theme "${String(c.theme)}". Did you mean: ${suggestName(String(c.theme), TUI_THEME_NAMES).join(', ')}?`,
    );
  if ('codeTheme' in c && !isCodeThemeName(c.codeTheme as string))
    throw new Error(
      `Unknown code theme "${String(c.codeTheme)}". Did you mean: ${suggestName(String(c.codeTheme), CODE_THEME_NAMES).join(', ')}?`,
    );
  if ('approval' in c && !['suggest', 'auto-edit', 'full-auto'].includes(c.approval as string))
    throw new Error('approval must be suggest, auto-edit, or full-auto');
  if (
    'maxIterations' in c &&
    (!Number.isInteger(c.maxIterations) ||
      (c.maxIterations as number) < 1 ||
      (c.maxIterations as number) > 100)
  )
    throw new Error('maxIterations must be 1–100');
  for (const section of ['aliases', 'providers', 'profiles']) {
    if (!(section in c)) continue;
    if (!c[section] || typeof c[section] !== 'object' || Array.isArray(c[section]))
      throw new Error(`${section} must be an object`);
  }
  if ('mcp' in c) {
    if (!c.mcp || typeof c.mcp !== 'object' || Array.isArray(c.mcp))
      throw new Error('mcp must be an object');
    for (const [name, server] of Object.entries(c.mcp as Record<string, unknown>)) {
      if (!server || typeof server !== 'object' || Array.isArray(server))
        throw new Error(`mcp server ${name} must be an object`);
      const value = server as Record<string, unknown>;
      if (typeof value.command !== 'string' || !value.command)
        throw new Error(`mcp server ${name}.command must be a string`);
      if (
        'args' in value &&
        (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string'))
      )
        throw new Error(`mcp server ${name}.args must be an array of strings`);
      if (
        'env' in value &&
        (!value.env ||
          typeof value.env !== 'object' ||
          Array.isArray(value.env) ||
          !Object.values(value.env as object).every((env) => typeof env === 'string'))
      )
        throw new Error(`mcp server ${name}.env must be an object of strings`);
      if ('cwd' in value && typeof value.cwd !== 'string')
        throw new Error(`mcp server ${name}.cwd must be a string`);
    }
  }
  if ('plugins' in c) {
    if (!Array.isArray(c.plugins) || !c.plugins.every((plugin) => typeof plugin === 'string'))
      throw new Error('plugins must be an array of strings');
  }
  for (const key of ['contextWindow', 'compressionThreshold']) {
    if (!(key in c)) continue;
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key] as number))
      throw new Error(`${key} must be a number`);
  }
  if (
    'contextWindow' in c &&
    (!Number.isInteger(c.contextWindow) || (c.contextWindow as number) < 1000)
  )
    throw new Error('contextWindow must be an integer of at least 1000');
  if (
    'compressionThreshold' in c &&
    ((c.compressionThreshold as number) <= 0 || (c.compressionThreshold as number) > 1)
  )
    throw new Error('compressionThreshold must be greater than 0 and at most 1');
  if ('editor' in c && typeof c.editor !== 'string') throw new Error('editor must be a string');
  if ('editorArgs' in c) {
    if (!Array.isArray(c.editorArgs) || !c.editorArgs.every((arg) => typeof arg === 'string'))
      throw new Error('editorArgs must be an array of strings');
  }
  if ('fallbackModels' in c) {
    if (
      !Array.isArray(c.fallbackModels) ||
      !c.fallbackModels.every((model) => typeof model === 'string')
    )
      throw new Error('fallbackModels must be an array of strings');
  }
  if ('subagents' in c) {
    if (
      !c.subagents ||
      typeof c.subagents !== 'object' ||
      typeof (c.subagents as { enabled?: unknown }).enabled !== 'boolean'
    )
      throw new Error('subagents must be an object with a boolean "enabled" field');
  }
  if ('tui' in c) {
    if (!c.tui || typeof c.tui !== 'object' || Array.isArray(c.tui))
      throw new Error('tui must be an object');
    const tui = c.tui as Record<string, unknown>;
    if ('showThinking' in tui && typeof tui.showThinking !== 'boolean')
      throw new Error('tui.showThinking must be a boolean');
  }
  for (const key of ['temperature', 'topP']) {
    if (!(key in c)) continue;
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key] as number))
      throw new Error(`${key} must be a number`);
  }
  if ('temperature' in c && ((c.temperature as number) < 0 || (c.temperature as number) > 2))
    throw new Error('temperature must be between 0 and 2');
  if ('topP' in c && ((c.topP as number) <= 0 || (c.topP as number) > 1))
    throw new Error('topP must be greater than 0 and at most 1');
  if ('maxTokens' in c && (!Number.isInteger(c.maxTokens) || (c.maxTokens as number) < 1))
    throw new Error('maxTokens must be a positive integer');
  if ('limits' in c) {
    if (!c.limits || typeof c.limits !== 'object' || Array.isArray(c.limits))
      throw new Error('limits must be an object');
    const limits = c.limits as Record<string, unknown>;
    for (const key of ['maxToolCalls', 'maxShellTimeoutMs', 'maxOutputChars', 'maxFileBytes']) {
      if (key in limits && (!Number.isInteger(limits[key]) || (limits[key] as number) < 1))
        throw new Error(`limits.${key} must be a positive integer`);
    }
    if ('maxCostUsd' in limits && (typeof limits.maxCostUsd !== 'number' || limits.maxCostUsd < 0))
      throw new Error('limits.maxCostUsd must be a non-negative number');
    if (
      'allowedHosts' in limits &&
      (!Array.isArray(limits.allowedHosts) ||
        !limits.allowedHosts.every((host) => typeof host === 'string' && host.length > 0))
    )
      throw new Error('limits.allowedHosts must be an array of host strings');
  }
  for (const [name, provider] of Object.entries((c.providers ?? {}) as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider))
      throw new Error(`provider ${name} must be an object`);
    for (const [key, v] of Object.entries(provider as Record<string, unknown>)) {
      if (
        ['apiKey', 'baseURL', 'model', 'projectId', 'buildModel'].includes(key) &&
        typeof v !== 'string'
      )
        throw new Error(`provider ${name}.${key} must be a string`);
      if (['temperature', 'topP'].includes(key) && typeof v !== 'number')
        throw new Error(`provider ${name}.${key} must be a number`);
      if (key === 'maxTokens' && (!Number.isInteger(v) || (v as number) < 1))
        throw new Error(`provider ${name}.maxTokens must be a positive integer`);
      if (
        key === 'fallbackModels' &&
        (!Array.isArray(v) || !v.every((model) => typeof model === 'string'))
      )
        throw new Error(`provider ${name}.fallbackModels must be an array of strings`);
      if (key === 'stream' && typeof v !== 'boolean')
        throw new Error(`provider ${name}.stream must be a boolean`);
      if (key === 'reasoningEffort' && !['low', 'medium', 'high'].includes(v as string))
        throw new Error(`provider ${name}.reasoningEffort must be low, medium, or high`);
      if (
        key === 'timeoutMs' &&
        (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 600_000)
      )
        throw new Error(`provider ${name}.timeoutMs must be an integer between 1 and 600000`);
      if (['speed', 'buildSpeed'].includes(key) && !['fast', 'standard'].includes(v as string))
        throw new Error(`provider ${name}.${key} must be fast or standard`);
      if (key === 'tags' && (!Array.isArray(v) || !v.every((tag) => typeof tag === 'string')))
        throw new Error(`provider ${name}.tags must be an array of tag names`);
      if (key === 'repos') {
        if (
          !Array.isArray(v) ||
          !v.every(
            (repo) =>
              repo != null &&
              typeof repo === 'object' &&
              !Array.isArray(repo) &&
              typeof (repo as { repoFullName?: unknown }).repoFullName === 'string' &&
              (!('branch' in repo) || typeof (repo as { branch?: unknown }).branch === 'string'),
          )
        )
          throw new Error(
            `provider ${name}.repos must be an array of { repoFullName, branch? } objects`,
          );
      }
      if (
        ![
          'apiKey',
          'baseURL',
          'model',
          'temperature',
          'topP',
          'maxTokens',
          'fallbackModels',
          'stream',
          'reasoningEffort',
          'timeoutMs',
          'projectId',
          'speed',
          'buildModel',
          'buildSpeed',
          'tags',
          'repos',
        ].includes(key)
      )
        throw new Error(`provider ${name}.${key} is not supported`);
    }
  }
  for (const [name, alias] of Object.entries((c.aliases ?? {}) as Record<string, unknown>))
    if (typeof alias !== 'string') throw new Error(`alias ${name} must be a string`);
  for (const [name, profile] of Object.entries((c.profiles ?? {}) as Record<string, unknown>)) {
    try {
      validateConfig({
        ...(profile as object),
        profiles: {},
        providers: (profile as any)?.providers ?? {},
        aliases: (profile as any)?.aliases ?? {},
        mcp: (profile as any)?.mcp ?? {},
        plugins: (profile as any)?.plugins ?? [],
        limits: (profile as any)?.limits ?? {},
      });
    } catch (e: any) {
      throw new Error(`profile ${name}: ${e.message}`);
    }
  }
}
