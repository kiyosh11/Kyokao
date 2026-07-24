import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodeThemeName, TuiThemeName } from '@kyokao/themes';
import type { KyokaoConfig } from './types.js';
import { validateConfig } from './validation.js';

export type GlobalConfigPatch = Omit<
  Partial<KyokaoConfig>,
  'providers' | 'profiles' | 'aliases' | 'mcp' | 'limits' | 'subagents' | 'tui'
> & {
  providers?: Partial<KyokaoConfig['providers']>;
  profiles?: Partial<KyokaoConfig['profiles']>;
  aliases?: Partial<KyokaoConfig['aliases']>;
  mcp?: Partial<KyokaoConfig['mcp']>;
  limits?: Partial<KyokaoConfig['limits']>;
  subagents?: Partial<KyokaoConfig['subagents']>;
  tui?: Partial<KyokaoConfig['tui']>;
};

export function kyokaoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KYOKAO_HOME ?? join(homedir(), '.kyokao');
}

export function globalConfigPath(): string {
  return join(kyokaoHome(), 'config.json');
}

export async function readConfig(path: string): Promise<Partial<KyokaoConfig>> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    validateConfig(data);
    return data;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`Invalid config ${path}: ${e.message}`);
  }
}

export async function atomicWrite(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}

export async function saveGlobalThemes(
  theme: TuiThemeName,
  codeTheme: CodeThemeName,
  path = globalConfigPath(),
): Promise<void> {
  const saved = await readConfig(path);
  await atomicWrite(path, { ...saved, theme, codeTheme });
}

/**
 * Persists a partial global configuration update while preserving unrelated
 * settings and merging the nested sections users commonly edit from the TUI.
 */
export async function saveGlobalConfigPatch(
  patch: GlobalConfigPatch,
  path = globalConfigPath(),
): Promise<void> {
  const saved = await readConfig(path);
  const providers = patch.providers
    ? Object.fromEntries(
        Object.entries({ ...(saved.providers ?? {}), ...patch.providers }).map(
          ([name, provider]) => [name, { ...(saved.providers?.[name] ?? {}), ...(provider ?? {}) }],
        ),
      )
    : undefined;
  const next = {
    ...saved,
    ...patch,
    ...(providers ? { providers } : {}),
    ...(patch.profiles ? { profiles: { ...(saved.profiles ?? {}), ...patch.profiles } } : {}),
    ...(patch.aliases ? { aliases: { ...(saved.aliases ?? {}), ...patch.aliases } } : {}),
    ...(patch.mcp ? { mcp: { ...(saved.mcp ?? {}), ...patch.mcp } } : {}),
    ...(patch.limits ? { limits: { ...(saved.limits ?? {}), ...patch.limits } } : {}),
    ...(patch.subagents ? { subagents: { ...(saved.subagents ?? {}), ...patch.subagents } } : {}),
    ...(patch.tui ? { tui: { ...(saved.tui ?? {}), ...patch.tui } } : {}),
  };
  validateConfig(next);
  await atomicWrite(path, next);
}

export async function saveProviderSelection(
  provider: string,
  options: {
    apiKey?: string;
    model?: string;
    projectId?: string;
    buildModel?: string;
    speed?: 'fast' | 'standard';
    buildSpeed?: 'fast' | 'standard';
  } = {},
  path = globalConfigPath(),
): Promise<void> {
  const saved = await readConfig(path);
  const current = saved.providers?.[provider] ?? {};
  const apiKey = options.apiKey?.trim();
  await atomicWrite(path, {
    ...saved,
    provider,
    ...(options.model ? { model: options.model } : {}),
    providers: {
      ...saved.providers,
      [provider]: {
        ...current,
        ...(apiKey ? { apiKey } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.buildModel ? { buildModel: options.buildModel } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
        ...(options.buildSpeed ? { buildSpeed: options.buildSpeed } : {}),
      },
    },
  });
}
