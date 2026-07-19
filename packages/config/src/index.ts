import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  fallbackModels?: string[];
}
export interface SafetyLimits {
  maxToolCalls: number;
  maxShellTimeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
  maxCostUsd: number;
  allowedHosts: string[];
}
export interface KyokaoConfig {
  provider: string;
  model: string;
  approval: ApprovalMode;
  maxIterations: number;
  profiles: Record<string, Partial<KyokaoConfig>>;
  providers: Record<string, ProviderConfig>;
  aliases: Record<string, string>;
  mcp: Record<string, McpServerConfig>;
  plugins: string[];
  contextWindow: number;
  compressionThreshold: number;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  fallbackModels: string[];
  editor: string;
  editorArgs: string[];
  limits: SafetyLimits;
}
export const defaults: KyokaoConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  approval: 'auto-edit',
  maxIterations: 12,
  profiles: {},
  providers: {},
  aliases: {},
  mcp: {},
  plugins: [],
  contextWindow: 16_000,
  compressionThreshold: 0.8,
  fallbackModels: [],
  editor: '',
  editorArgs: [],
  limits: {
    maxToolCalls: 100,
    maxShellTimeoutMs: 120_000,
    maxOutputChars: 30_000,
    maxFileBytes: 2_000_000,
    maxCostUsd: 0,
    allowedHosts: [],
  },
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
      if (['apiKey', 'baseURL', 'model'].includes(key) && typeof v !== 'string')
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
      if (
        ![
          'apiKey',
          'baseURL',
          'model',
          'temperature',
          'topP',
          'maxTokens',
          'fallbackModels',
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
    limits: { ...a.limits, ...(b.limits ?? {}) } as SafetyLimits,
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
    editor: env.KYOKAO_EDITOR,
    temperature: env.KYOKAO_TEMPERATURE ? Number(env.KYOKAO_TEMPERATURE) : undefined,
    maxTokens: env.KYOKAO_MAX_TOKENS ? Number(env.KYOKAO_MAX_TOKENS) : undefined,
    topP: env.KYOKAO_TOP_P ? Number(env.KYOKAO_TOP_P) : undefined,
    fallbackModels: env.KYOKAO_FALLBACK_MODELS
      ? env.KYOKAO_FALLBACK_MODELS.split(',').map((model) => model.trim())
      : undefined,
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
  if (result.contextWindow < 1000 || !Number.isInteger(result.contextWindow))
    throw new Error('contextWindow must be an integer of at least 1000');
  if (result.compressionThreshold <= 0 || result.compressionThreshold > 1)
    throw new Error('compressionThreshold must be greater than 0 and at most 1');
  if (result.limits.maxToolCalls < 1 || result.limits.maxToolCalls > 10_000)
    throw new Error('limits.maxToolCalls must be 1–10000');
  if (result.limits.maxShellTimeoutMs < 1000 || result.limits.maxShellTimeoutMs > 120_000)
    throw new Error('limits.maxShellTimeoutMs must be 1000–120000');
  if (result.limits.maxOutputChars < 1000 || result.limits.maxOutputChars > 1_000_000)
    throw new Error('limits.maxOutputChars must be 1000–1000000');
  if (result.limits.maxFileBytes < 1024 || result.limits.maxFileBytes > 50_000_000)
    throw new Error('limits.maxFileBytes must be 1024–50000000');
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
    temperature: custom.temperature ?? config.temperature,
    maxTokens: custom.maxTokens ?? config.maxTokens,
    topP: custom.topP ?? config.topP,
    fallbackModels: custom.fallbackModels ?? config.fallbackModels,
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
