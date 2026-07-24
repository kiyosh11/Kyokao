// @ts-nocheck
import {
  atomicWrite,
  effectiveSetupApiKey,
  globalConfigPath,
  mergeProviderSetup,
  providerPresets,
  readConfig,
} from '@kyokao/config';
import { CapyClient, OpenAICompatibleProvider } from '@kyokao/providers';
import { setupWizard, type InteractiveScreen, type ThemeContext } from '@kyokao/ui';

export async function needsProviderSetup(options: {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  profile?: string;
}): Promise<boolean> {
  if (options.provider || options.baseUrl || options.apiKey || options.model || options.profile)
    return false;

  const global = await readConfig(globalConfigPath());
  return !global.provider && !process.env.KYOKAO_PROVIDER;
}

export async function setupProvider(
  confirmReplace = false,
  screen?: InteractiveScreen,
  themeContext?: ThemeContext,
): Promise<boolean> {
  const saved = await readConfig(globalConfigPath());
  const localNames = new Set(['ollama', 'lmstudio', 'vllm']);
  const providers = [
    ...Object.entries(providerPresets).map(([name, preset]) => ({
      name,
      baseURL: preset.baseURL,
      env: preset.env,
      local: localNames.has(name),
      description: localNames.has(name)
        ? `Local server at ${preset.baseURL}`
        : name === 'capy'
          ? 'Capy remote agent (connected repositories and isolated VMs)'
          : `Hosted API (${preset.env})`,
      remote: preset.remote,
    })),
    ...Object.entries(saved.providers ?? {})
      .filter(([name]) => !providerPresets[name])
      .map(([name, provider]) => ({
        name,
        baseURL: provider.baseURL,
        description: provider.baseURL
          ? `Saved endpoint at ${provider.baseURL}`
          : 'Saved custom provider',
      })),
    { name: '__custom__', description: 'New OpenAI-compatible endpoint' },
  ];
  let capyModelRequest:
    | {
        baseURL: string;
        apiKey: string;
        value: Promise<Awaited<ReturnType<CapyClient['models']>>>;
      }
    | undefined;
  const fetchCapyModels = (baseURL: string, apiKey: string, signal: AbortSignal) => {
    if (capyModelRequest?.baseURL === baseURL && capyModelRequest.apiKey === apiKey)
      return capyModelRequest.value;
    const value = new CapyClient({ baseURL, apiKey }).models(signal);
    capyModelRequest = { baseURL, apiKey, value };
    void value.catch(() => {
      if (capyModelRequest?.value === value) capyModelRequest = undefined;
    });
    return value;
  };
  const result = await setupWizard({
    providers,
    configPath: globalConfigPath(),
    confirmReplace,
    screen,
    themeContext,
    keySource: (provider) =>
      provider.local
        ? 'local'
        : saved.providers?.[provider.name]?.apiKey
          ? 'saved'
          : provider.env && process.env[provider.env]
            ? 'environment'
            : 'not configured',
    fetchModels: async ({ provider, baseURL, apiKey, local, signal }) => {
      const effectiveKey = effectiveSetupApiKey(
        apiKey,
        saved.providers?.[provider]?.apiKey,
        providerPresets[provider]?.env ? process.env[providerPresets[provider]!.env] : undefined,
      );
      if (!baseURL || (!local && !effectiveKey)) return [];
      if (provider === 'capy')
        return (await fetchCapyModels(baseURL, effectiveKey, signal))
          .filter((model) => model.captainEligible)
          .map((model) => model.id);
      return await new OpenAICompatibleProvider({
        baseURL,
        apiKey: effectiveKey,
        model: 'setup',
      }).models(signal);
    },
    fetchBuildModels: async ({ provider, baseURL, apiKey, signal }) => {
      if (provider !== 'capy' || !baseURL) return [];
      const effectiveKey = effectiveSetupApiKey(
        apiKey,
        saved.providers?.capy?.apiKey,
        process.env.CAPY_API_KEY,
      );
      if (!effectiveKey) return [];
      return (await fetchCapyModels(baseURL, effectiveKey, signal)).map((model) => model.id);
    },
    fetchProjects: async ({ provider, baseURL, apiKey, signal }) => {
      if (provider !== 'capy') return [];
      const effectiveKey = effectiveSetupApiKey(
        apiKey,
        saved.providers?.capy?.apiKey,
        process.env.CAPY_API_KEY,
      );
      if (!effectiveKey) return [];
      return (await new CapyClient({ baseURL, apiKey: effectiveKey }).projects(signal)).map(
        (project) => ({
          id: project.id,
          name: project.name,
          description: project.repos.map((repo) => repo.repoFullName).join(', ') || 'No repository',
        }),
      );
    },
  });
  if (!result) return false;
  await atomicWrite(
    globalConfigPath(),
    mergeProviderSetup(saved, {
      ...result,
      presetBaseURL: providerPresets[result.provider]?.baseURL,
      projectId: result.projectId,
      buildModel: result.buildModel,
    }),
  );
  return true;
}
