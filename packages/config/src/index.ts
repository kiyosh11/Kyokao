import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}
export interface KyokaoConfig {
  provider: string;
  model: string;
  approval: ApprovalMode;
  maxIterations: number;
  profiles: Record<string, Partial<KyokaoConfig>>;
  providers: Record<string, ProviderConfig>;
  aliases: Record<string, string>;
}
export const defaults: KyokaoConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  approval: 'auto-edit',
  maxIterations: 12,
  profiles: {},
  providers: {},
  aliases: {},
};
export const providerPresets: Record<string, { baseURL: string; env: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY' },
  nvidia: { baseURL: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY' },
  together: { baseURL: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY' },
  deepinfra: { baseURL: 'https://api.deepinfra.com/v1/openai', env: 'DEEPINFRA_API_KEY' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY' },
  sambanova: { baseURL: 'https://api.sambanova.ai/v1', env: 'SAMBANOVA_API_KEY' },
  xai: { baseURL: 'https://api.x.ai/v1', env: 'XAI_API_KEY' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY' },
  ollama: { baseURL: 'http://localhost:11434/v1', env: 'OLLAMA_API_KEY' },
  lmstudio: { baseURL: 'http://localhost:1234/v1', env: 'LMSTUDIO_API_KEY' },
  vllm: { baseURL: 'http://localhost:8000/v1', env: 'VLLM_API_KEY' },
};
export function globalConfigPath(
  home = process.env.HOME ?? process.env.USERPROFILE ?? '.',
): string {
  return process.platform === 'win32'
    ? join(process.env.APPDATA ?? home, 'kyokao', 'config.json')
    : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'kyokao', 'config.json');
}
function validateConfig(value: unknown): asserts value is Partial<KyokaoConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('must be an object');
  const c = value as Record<string, unknown>;
  for (const key of ['provider', 'model'])
    if (key in c && typeof c[key] !== 'string') throw new Error(`${key} must be a string`);
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
  for (const [name, provider] of Object.entries((c.providers ?? {}) as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider))
      throw new Error(`provider ${name} must be an object`);
    for (const [key, v] of Object.entries(provider as Record<string, unknown>))
      if (!['apiKey', 'baseURL', 'model'].includes(key) || typeof v !== 'string')
        throw new Error(`provider ${name}.${key} must be a string`);
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
      });
    } catch (e: any) {
      throw new Error(`profile ${name}: ${e.message}`);
    }
  }
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
function merge(a: Partial<KyokaoConfig>, b: Partial<KyokaoConfig>): Partial<KyokaoConfig> {
  const defined = Object.fromEntries(Object.entries(b).filter(([, value]) => value !== undefined));
  return {
    ...a,
    ...defined,
    providers: { ...a.providers, ...(b.providers ?? {}) },
    profiles: { ...a.profiles, ...(b.profiles ?? {}) },
    aliases: { ...a.aliases, ...(b.aliases ?? {}) },
  };
}
export async function loadConfig(
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    cli?: Partial<KyokaoConfig>;
    profile?: string;
  } = {},
): Promise<KyokaoConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  let result = merge(defaults, await readConfig(globalConfigPath())) as KyokaoConfig;
  result = merge(result, await readConfig(join(cwd, '.kyokao.json'))) as KyokaoConfig;
  const envConfig: Partial<KyokaoConfig> = {
    provider: env.KYOKAO_PROVIDER,
    model: env.KYOKAO_MODEL,
    approval: env.KYOKAO_APPROVAL as ApprovalMode | undefined,
    maxIterations: env.KYOKAO_MAX_ITERATIONS ? Number(env.KYOKAO_MAX_ITERATIONS) : undefined,
  };
  if (opts.profile && result.profiles?.[opts.profile])
    result = merge(result, result.profiles[opts.profile]!) as KyokaoConfig;
  result = merge(result, envConfig) as KyokaoConfig;
  result = merge(result, opts.cli ?? {}) as KyokaoConfig;
  if (!providerPresets[result.provider] && !result.providers[result.provider])
    throw new Error(`Unknown provider: ${result.provider}`);
  if (!['suggest', 'auto-edit', 'full-auto'].includes(result.approval))
    throw new Error('approval must be suggest, auto-edit, or full-auto');
  if (
    !Number.isInteger(result.maxIterations) ||
    result.maxIterations < 1 ||
    result.maxIterations > 100
  )
    throw new Error('maxIterations must be 1–100');
  return result as KyokaoConfig;
}
export function resolveProvider(
  config: KyokaoConfig,
  env = process.env,
): ProviderConfig & { model: string } {
  const preset = providerPresets[config.provider];
  const custom = config.providers[config.provider] ?? {};
  const apiKey = custom.apiKey ?? (preset ? env[preset.env] : undefined);
  return {
    baseURL: custom.baseURL ?? preset?.baseURL,
    apiKey,
    model: config.aliases[config.model] ?? custom.model ?? config.model,
  };
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      /key|token|secret|password/i.test(k) ? [k, v ? '***REDACTED***' : v] : [k, redact(v)],
    ),
  );
}
export async function atomicWrite(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
