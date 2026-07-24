import type { CodeThemeName, TuiThemeName } from '@kyokao/themes';

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  startTimeoutMs?: number;

  requestTimeoutMs?: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  fallbackModels?: string[];

  stream?: boolean;
  projectId?: string;

  speed?: 'fast' | 'standard';

  buildModel?: string;

  buildSpeed?: 'fast' | 'standard';

  tags?: string[];

  repos?: Array<{ repoFullName: string; branch?: string }>;
}

export interface SafetyLimits {
  maxToolCalls: number;
  maxShellTimeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
  maxCostUsd: number;
  allowedHosts: string[];
}

export interface TuiSettings {
  showThinking: boolean;
}

export interface KyokaoConfig {
  theme: TuiThemeName;
  codeTheme: CodeThemeName;
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
  subagents: { enabled: boolean };
  tui: TuiSettings;
}

export const defaults: KyokaoConfig = {
  theme: 'kyokao-dark',
  codeTheme: 'kyokao',
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
  subagents: { enabled: false },
  tui: { showThinking: true },
};

export const providerPresets: Record<string, { baseURL: string; env: string; remote?: boolean }> = {
  capy: {
    baseURL: 'https://capy.ai/api/v1',
    env: 'CAPY_API_KEY',
    remote: true,
  },
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

export interface ProviderSetupInput {
  provider: string;
  model: string;
  approval: ApprovalMode;
  baseURL?: string;
  presetBaseURL?: string;
  apiKey?: string;
  projectId?: string;
}
