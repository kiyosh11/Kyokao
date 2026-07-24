export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export interface ChatResponse {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  finishReason?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelInfo {
  id: string;
  provider?: string;
  contextWindow?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  supportsTools?: boolean;
}

export const modelCatalog: ModelInfo[] = [
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    contextWindow: 128000,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
    supportsTools: true,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10,
    supportsTools: true,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    contextWindow: 1047576,
    inputCostPerMillion: 0.4,
    outputCostPerMillion: 1.6,
    supportsTools: true,
  },
  {
    id: 'claude-3-5-sonnet',
    contextWindow: 200000,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    supportsTools: true,
  },
  {
    id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    id: 'openai/gpt-oss-20b',
    provider: 'nvidia',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    id: 'openai/gpt-oss-120b',
    provider: 'nvidia',
    contextWindow: 131072,
    supportsTools: true,
  },
  {
    id: 'google/gemma-3n-e4b-it',
    provider: 'nvidia',
    contextWindow: 32768,
    supportsTools: true,
  },
  // Capy's /models payload intentionally stays minimal, while its official
  // model reference publishes these context capacities.
  { id: 'auto', provider: 'capy', contextWindow: 262000, supportsTools: true },
  {
    id: 'claude-opus-4-6',
    provider: 'capy',
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  {
    id: 'claude-opus-4-5',
    provider: 'capy',
    contextWindow: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'capy',
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'capy',
    contextWindow: 200_000,
    supportsTools: true,
  },
  { id: 'gpt-5.6-sol', provider: 'capy', contextWindow: 1_000_000, supportsTools: true },
  { id: 'gpt-5.6-terra', provider: 'capy', contextWindow: 1_000_000, supportsTools: true },
  { id: 'gpt-5.6-luna', provider: 'capy', contextWindow: 400_000, supportsTools: true },
  { id: 'gpt-5.5', provider: 'capy', contextWindow: 1_000_000, supportsTools: true },
  { id: 'gpt-5.5-pro', provider: 'capy', contextWindow: 1_000_000, supportsTools: true },
  { id: 'gpt-5.4', provider: 'capy', contextWindow: 1_000_000, supportsTools: true },
  { id: 'gpt-5.4-mini', provider: 'capy', contextWindow: 400_000, supportsTools: true },
  { id: 'gpt-5.3-codex', provider: 'capy', contextWindow: 400_000, supportsTools: true },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'capy',
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  {
    id: 'gemini-3-flash-preview',
    provider: 'capy',
    contextWindow: 1_000_000,
    supportsTools: true,
  },
  { id: 'grok-4-1-fast', provider: 'capy', contextWindow: 2_000_000, supportsTools: true },
  { id: 'glm-5', provider: 'capy', contextWindow: 200_000, supportsTools: true },
  { id: 'glm-5-turbo', provider: 'capy', contextWindow: 203_000, supportsTools: true },
  { id: 'glm-4.7', provider: 'capy', contextWindow: 131_000, supportsTools: true },
  { id: 'kimi-k2.5', provider: 'capy', contextWindow: 262_000, supportsTools: true },
  { id: 'qwen3-coder', provider: 'capy', contextWindow: 262_000, supportsTools: true },
];

export interface StreamEvents {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (call: ToolCall) => void;
}

export interface Provider {
  readonly baseURL: string;
  readonly options: {
    baseURL?: string;
    apiKey?: string;
    model: string;
    fallbackModels?: string[];
    reasoningEffort?: ReasoningEffort;
    timeoutMs?: number;
    stream?: boolean;
  };
  models(signal?: AbortSignal): Promise<string[]>;
  validateModel(): Promise<ModelInfo>;
  chat(
    messages: ChatMessage[],
    tools: unknown[],
    events?: StreamEvents,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}
