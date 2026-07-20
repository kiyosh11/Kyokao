import OpenAI from 'openai';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
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
  onToolCall?: (call: ToolCall) => void;
}

/** Maps Kyokao's stable transcript shape to the OpenAI wire protocol. */
export function toOpenAIMessage(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.tool_calls?.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  if (message.role === 'tool')
    return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id };
  return message;
}
export class OpenAICompatibleProvider {
  private client?: OpenAI;
  private fallbackIndex = -1;
  constructor(
    readonly options: {
      baseURL?: string;
      apiKey?: string;
      model: string;
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      fallbackModels?: string[];
      fetch?: typeof fetch;
      stream?: boolean;
    },
  ) {
    if (!options.baseURL) throw new Error('Provider baseURL is required');
    if (!options.fetch)
      this.client = new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey ?? 'not-required',
      });
  }
  private get request() {
    return this.options.fetch ?? fetch;
  }
  async models(signal?: AbortSignal): Promise<string[]> {
    if (this.client)
      return (await this.client.models.list({ signal })).data.map((model) => model.id);
    const response = await this.request(`${this.options.baseURL!.replace(/\/$/, '')}/models`, {
      headers: this.headers(),
      signal,
    });
    if (!response.ok) throw new Error(`Model listing failed: ${response.status}`);
    return (
      ((await response.json()) as { data?: Array<{ id: string }> }).data?.map(
        (model) => model.id,
      ) ?? []
    );
  }
  async modelCatalog(): Promise<ModelInfo[]> {
    const ids = await this.models();
    return ids.map((id) => ({
      id,
      ...modelCatalog.find((item) => item.id === id),
      provider: this.options.baseURL,
    }));
  }
  async validateModel(): Promise<ModelInfo> {
    const models = await this.models();
    const match = models.find((id) => id === this.options.model);
    if (!match)
      throw new Error(
        `Model "${this.options.model}" is not available at ${this.options.baseURL}. Run "kyokao models" to see available IDs.`,
      );
    const unavailableFallback = (this.options.fallbackModels ?? []).find(
      (model) => !models.includes(model),
    );
    if (unavailableFallback)
      throw new Error(
        `Fallback model "${unavailableFallback}" is not available at ${this.options.baseURL}. Remove it or use "kyokao models" to choose a valid fallback.`,
      );
    return {
      id: match,
      ...modelCatalog.find((item) => item.id === match),
      provider: this.options.baseURL,
    };
  }
  async chat(
    messages: ChatMessage[],
    tools: unknown[],
    events: StreamEvents = {},
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    try {
      if (this.client) return await this.sdkChat(messages, tools, events, signal);
      return await this.fetchChat(messages, tools, signal);
    } catch (error) {
      const next = (this.options.fallbackModels ?? [])[this.fallbackIndex + 1];
      if (!next || (error instanceof Error && error.name === 'AbortError')) throw error;
      this.fallbackIndex += 1;
      return this.chat(messages, tools, events, signal);
    }
  }
  private async sdkChat(
    messages: ChatMessage[],
    tools: unknown[],
    events: StreamEvents,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const request = {
      model: this.activeModel(),
      messages: messages.map(toOpenAIMessage),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      ...(this.options.maxTokens === undefined ? {} : { max_tokens: this.options.maxTokens }),
      ...(this.options.topP === undefined ? {} : { top_p: this.options.topP }),
    };
    if (this.options.stream === false)
      return this.fromCompletion(
        (await this.client!.chat.completions.create(request, {
          signal,
        })) as OpenAI.Chat.ChatCompletion,
      );
    const stream = await this.client!.chat.completions.create(
      { ...request, stream: true, stream_options: { include_usage: true } },
      { signal },
    );
    let content = '';
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const chunk of stream) {
      const chunkUsage = (chunk as unknown as { usage?: OpenAI.CompletionUsage }).usage;
      if (chunkUsage)
        usage = {
          promptTokens: chunkUsage.prompt_tokens,
          completionTokens: chunkUsage.completion_tokens,
          totalTokens: chunkUsage.total_tokens,
        };
      const choice = chunk.choices[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      if (choice.delta.content) {
        content += choice.delta.content;
        events.onText?.(choice.delta.content);
      }
      for (const delta of choice.delta.tool_calls ?? []) {
        const index = delta.index ?? 0;
        const current = calls.get(index) ?? {
          id: delta.id ?? '',
          name: delta.function?.name ?? '',
          arguments: '',
        };
        if (delta.id) current.id = delta.id;
        if (delta.function?.name && !current.name) current.name = delta.function.name;
        if (delta.function?.arguments) current.arguments += delta.function.arguments;
        calls.set(index, current);
      }
    }
    const toolCalls = [...calls.values()];
    for (const call of toolCalls) events.onToolCall?.(call);
    return {
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finishReason,
      usage,
    };
  }
  private fromCompletion(response: OpenAI.Chat.ChatCompletion): ChatResponse {
    const choice = response.choices[0];
    const message = choice?.message;
    if (!message) throw new Error('Provider returned no choices');
    return {
      message: {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      },
      finishReason: choice.finish_reason,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }
  private async fetchChat(
    messages: ChatMessage[],
    tools: unknown[],
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const response = await this.request(
      `${this.options.baseURL!.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: this.activeModel(),
          messages: messages.map(toOpenAIMessage),
          tools,
          stream: false,
          ...(this.options.temperature === undefined
            ? {}
            : { temperature: this.options.temperature }),
          ...(this.options.maxTokens === undefined ? {} : { max_tokens: this.options.maxTokens }),
          ...(this.options.topP === undefined ? {} : { top_p: this.options.topP }),
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Chat request failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as {
      choices?: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = body.choices?.[0];
    if (!choice) throw new Error('Provider returned no choices');
    return {
      message: {
        role: 'assistant',
        content: choice.message.content,
        tool_calls: choice.message.tool_calls?.map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })),
      },
      finishReason: choice.finish_reason,
      usage: body.usage
        ? {
            promptTokens: body.usage.prompt_tokens ?? 0,
            completionTokens: body.usage.completion_tokens ?? 0,
            totalTokens: body.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
  private headers(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }
  private activeModel(): string {
    return this.fallbackIndex < 0
      ? this.options.model
      : ((this.options.fallbackModels ?? [])[this.fallbackIndex] ?? this.options.model);
  }
}
