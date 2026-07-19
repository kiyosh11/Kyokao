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
}
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
  constructor(
    readonly options: {
      baseURL?: string;
      apiKey?: string;
      model: string;
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
  async models(): Promise<string[]> {
    if (this.client) return (await this.client.models.list()).data.map((model) => model.id);
    const response = await this.request(`${this.options.baseURL!.replace(/\/$/, '')}/models`, {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`Model listing failed: ${response.status}`);
    return (
      ((await response.json()) as { data?: Array<{ id: string }> }).data?.map(
        (model) => model.id,
      ) ?? []
    );
  }
  async chat(
    messages: ChatMessage[],
    tools: unknown[],
    events: StreamEvents = {},
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    if (this.client) return this.sdkChat(messages, tools, events, signal);
    return this.fetchChat(messages, tools, signal);
  }
  private async sdkChat(
    messages: ChatMessage[],
    tools: unknown[],
    events: StreamEvents,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const request = {
      model: this.options.model,
      messages: messages.map(toOpenAIMessage),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
    };
    if (this.options.stream === false)
      return this.fromCompletion(
        (await this.client!.chat.completions.create(request, {
          signal,
        })) as OpenAI.Chat.ChatCompletion,
      );
    const stream = await this.client!.chat.completions.create(
      { ...request, stream: true },
      { signal },
    );
    let content = '';
    let finishReason: string | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const chunk of stream) {
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
          model: this.options.model,
          messages: messages.map(toOpenAIMessage),
          tools,
          stream: false,
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
    };
  }
  private headers(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }
}
