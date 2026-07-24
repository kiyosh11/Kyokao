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
