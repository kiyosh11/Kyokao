// @ts-nocheck
import {
  CODE_THEME_NAMES,
  TUI_THEME_NAMES,
  isCodeThemeName,
  isTuiThemeName,
  suggestName,
} from '@kyokao/themes';
import { defaults, providerPresets } from './types.js';
import { globalConfigPath, readConfig } from './persistence.js';
// Public API re-exports — the package surface is unchanged for consumers.
export * from './types.js';
export { validateConfig } from './validation.js';
export { kyokaoHome } from './persistence.js';
export {
  globalConfigPath,
  readConfig,
  atomicWrite,
  saveGlobalConfigPatch,
  saveGlobalThemes,
  saveProviderSelection,
} from './persistence.js';
function merge(a, b) {
  const defined = Object.fromEntries(Object.entries(b).filter(([, value]) => value !== undefined));
  return {
    ...a,
    ...defined,
    providers: { ...a.providers, ...(b.providers ?? {}) },
    profiles: { ...a.profiles, ...(b.profiles ?? {}) },
    aliases: { ...a.aliases, ...(b.aliases ?? {}) },
    limits: { ...a.limits, ...(b.limits ?? {}) },
    subagents: { ...a.subagents, ...(b.subagents ?? {}) },
    tui: { ...a.tui, ...(b.tui ?? {}) },
  };
}
/**
 * Loads and fully resolves the effective {@link KyokaoConfig} by merging, in
 * precedence order: defaults → global config → selected profile → environment
 * overrides → CLI overrides. Workspace `.kyokao.json` overrides were removed
 * in 0.7.0 (state now lives under `~/.kyokao/`); use a profile for scoped
 * settings. Performs the final range/sanity checks that cross-section merge
 * can produce.
 */
export async function loadConfig(opts = {}) {
  const env = opts.env ?? process.env;
  let result = merge(defaults, await readConfig(opts.globalPath ?? globalConfigPath()));
  const envConfig = {
    theme: env.KYOKAO_THEME,
    codeTheme: env.KYOKAO_CODE_THEME,
    provider: env.KYOKAO_PROVIDER,
    model: env.KYOKAO_MODEL,
    approval: env.KYOKAO_APPROVAL,
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
    result = merge(result, result.profiles[opts.profile]);
  result = merge(result, envConfig);
  result = merge(result, opts.cli ?? {});
  if (!providerPresets[result.provider] && !result.providers[result.provider])
    throw new Error(`Unknown provider: ${result.provider}`);
  if (
    result.provider === 'capy' &&
    (!result.providers.capy?.projectId || typeof result.providers.capy.projectId !== 'string')
  )
    throw new Error(
      'Capy provider requires providers.capy.projectId. Run "kyokao config setup" to select an accessible project.',
    );
  if (!['suggest', 'auto-edit', 'full-auto'].includes(result.approval))
    throw new Error('approval must be suggest, auto-edit, or full-auto');
  if (!isTuiThemeName(result.theme))
    throw new Error(
      `Unknown TUI theme "${result.theme}". Did you mean: ${suggestName(result.theme, TUI_THEME_NAMES).join(', ')}?`,
    );
  if (!isCodeThemeName(result.codeTheme))
    throw new Error(
      `Unknown code theme "${result.codeTheme}". Did you mean: ${suggestName(result.codeTheme, CODE_THEME_NAMES).join(', ')}?`,
    );
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
  return result;
}
/** Resolves the effective provider config (preset + per-provider overrides + env). */
export function resolveProvider(config, env = process.env) {
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
    stream: custom.stream,
  };
}
export function redactEndpoint(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    if (url.search) url.search = '?REDACTED';
    if (url.hash) url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}
/** Recursively redacts common credential-bearing field names. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) =>
      /key|token|secret|password|credential|auth|cookie|private/i.test(k)
        ? [k, v ? '***REDACTED***' : v]
        : /url/i.test(k)
          ? [k, redactEndpoint(v)]
          : [k, redact(v)],
    ),
  );
}
/**
 * Merges a setup-wizard result into a saved config. Preserves the preset
 * baseURL when the user accepted it (dropping a redundant override), keeps an
 * existing saved API key when the wizard didn't supply one, and removes the
 * provider entry entirely if it would be empty.
 */
export function mergeProviderSetup(saved, setup) {
  const current = { ...(saved.providers?.[setup.provider] ?? {}) };
  if (setup.presetBaseURL && setup.baseURL === setup.presetBaseURL) delete current.baseURL;
  else if (setup.baseURL) current.baseURL = setup.baseURL;
  if (setup.apiKey) current.apiKey = setup.apiKey;
  current.model = setup.model;
  if (setup.projectId) current.projectId = setup.projectId;
  if (setup.buildModel) current.buildModel = setup.buildModel;
  const providers = { ...(saved.providers ?? {}) };
  if (Object.keys(current).length) providers[setup.provider] = current;
  else delete providers[setup.provider];
  return {
    ...saved,
    provider: setup.provider,
    model: setup.model,
    approval: setup.approval,
    providers,
  };
}
/** Setup credential precedence: entered > saved > environment. */
export function effectiveSetupApiKey(entered, saved, environment) {
  return entered || saved || environment;
}
