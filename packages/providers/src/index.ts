// @ts-nocheck
import OpenAI from 'openai';
import { modelCatalog } from './types.js';
// Public API re-exports — package surface unchanged for consumers.
export * from './types.js';
export * from './capy.js';
/** Maps Kyokao's stable transcript shape to the OpenAI wire protocol. */
export function toOpenAIMessage(message) {
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: message.content,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
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
/**
 * OpenAI-compatible chat client. Works against any endpoint that speaks the
 * `/chat/completions` and `/models` surface — hosted (OpenAI, OpenRouter,
 * Groq, …) or local (Ollama, LM Studio, vLLM). Uses the official `openai`
 * SDK when no custom `fetch` is injected, else a raw fetch path. Streaming
 * is on by default; tool-call deltas are reassembled by index.
 *
 * Fallback behavior: when the primary model rejects, `chat` walks
 * `fallbackModels` in order. A successful call resets the fallback index so a
 * single transient failure does not permanently downgrade the session.
 */
export class OpenAICompatibleProvider {
  options;
  client;
  fallbackIndex = -1;
  modelCache;
  constructor(options) {
    this.options = options;
    if (!options.baseURL) throw new Error('Provider baseURL is required');
    if (!options.fetch)
      this.client = new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey ?? 'not-required',
      });
  }
  get request() {
    return this.options.fetch ?? fetch;
  }
  get baseURL() {
    return this.options.baseURL;
  }
  async models(signal) {
    if (this.modelCache && this.modelCache.expiresAt > Date.now())
      return [...this.modelCache.values];
    let values;
    if (this.client)
      values = (await this.client.models.list({ signal })).data.map((model) => model.id);
    else {
      const response = await this.request(`${this.options.baseURL.replace(/\/$/, '')}/models`, {
        headers: this.headers(),
        signal,
      });
      if (!response.ok) throw new Error(`Model listing failed: ${response.status}`);
      values = (await response.json()).data?.map((model) => model.id) ?? [];
    }
    this.modelCache = { values: [...values], expiresAt: Date.now() + 30_000 };
    return values;
  }
  async modelCatalog() {
    const ids = await this.models();
    // NOTE: references the imported `modelCatalog` const, not a method.
    return ids.map((id) => ({
      id,
      ...modelCatalog.find((item) => item.id === id),
      provider: this.options.baseURL,
    }));
  }
  async validateModel() {
    const models = await this.models();
    const match = models.find((id) => id === this.options.model);
    if (!match)
      throw new Error(
        `Model "${this.options.model}" is not available at ${this.options.baseURL}. Run "kyokao models" to see available IDs.`,
      );
    // Fallbacks are an availability safety net: warn (don't throw) when one is
    // missing from /models, since it may simply not be listed transiently and
    // hard-failing here defeats the resilience the fallback exists to provide.
    for (const fallback of this.options.fallbackModels ?? [])
      if (!models.includes(fallback))
        console.warn(
          `Kyokao: fallback model "${fallback}" is not listed at ${this.options.baseURL}; it will be skipped if the primary fails.`,
        );
    return {
      id: match,
      ...modelCatalog.find((item) => item.id === match),
      provider: this.options.baseURL,
    };
  }
  async chat(messages, tools, events = {}, signal) {
    try {
      const result = this.client
        ? await this.sdkChat(messages, tools, events, signal)
        : await this.fetchChat(messages, tools, events, signal);
      // A successful call restores the primary model: a single transient 5xx
      // on the primary must not permanently downgrade the whole session.
      this.fallbackIndex = -1;
      return result;
    } catch (error) {
      const next = (this.options.fallbackModels ?? [])[this.fallbackIndex + 1];
      if (!next || (error instanceof Error && error.name === 'AbortError')) throw error;
      this.fallbackIndex += 1;
      return this.chat(messages, tools, events, signal);
    }
  }
  async sdkChat(messages, tools, events, signal) {
    const request = {
      model: this.activeModel(),
      messages: messages.map(toOpenAIMessage),
      tools: tools,
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      ...(this.options.maxTokens === undefined ? {} : { max_tokens: this.options.maxTokens }),
      ...(this.options.topP === undefined ? {} : { top_p: this.options.topP }),
    };
    if (this.options.stream === false)
      return this.fromCompletion(
        await this.client.chat.completions.create(request, {
          signal,
        }),
      );
    const stream = await this.client.chat.completions.create(
      { ...request, stream: true, stream_options: { include_usage: true } },
      { signal },
    );
    let content = '';
    let reasoningContent = '';
    let finishReason;
    let usage;
    const calls = new Map();
    for await (const chunk of stream) {
      const chunkUsage = chunk.usage;
      if (chunkUsage)
        usage = {
          promptTokens: chunkUsage.prompt_tokens,
          completionTokens: chunkUsage.completion_tokens,
          totalTokens: chunkUsage.total_tokens,
        };
      const choice = chunk.choices[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const reasoningDelta = choice.delta.reasoning_content ?? choice.delta.reasoning;
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        reasoningContent += reasoningDelta;
        events.onReasoning?.(reasoningDelta);
      }
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
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finishReason,
      usage,
    };
  }
  fromCompletion(response) {
    const choice = response.choices[0];
    const message = choice?.message;
    if (!message) throw new Error('Provider returned no choices');
    return {
      message: {
        role: 'assistant',
        content: message.content,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
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
  async fetchChat(messages, tools, events, signal) {
    const wantStream = this.options.stream !== false;
    const response = await this.request(
      `${this.options.baseURL.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'content-type': 'application/json',
          ...(wantStream ? { accept: 'text/event-stream' } : {}),
        },
        signal,
        body: JSON.stringify({
          model: this.activeModel(),
          messages: messages.map(toOpenAIMessage),
          tools,
          stream: wantStream,
          ...(wantStream ? { stream_options: { include_usage: true } } : {}),
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
    // Streaming path: parse the SSE body incrementally, mirroring sdkChat.
    if (wantStream && response.body) {
      return await this.consumeSSEStream(response.body, events, signal);
    }
    // Non-streaming path: read the full JSON body.
    const body = await response.json();
    const choice = body.choices?.[0];
    if (!choice) throw new Error('Provider returned no choices');
    return {
      message: {
        role: 'assistant',
        content: choice.message.content,
        ...(choice.message.reasoning_content
          ? { reasoning_content: choice.message.reasoning_content }
          : {}),
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
  /**
   * Consume a Server-Sent Events stream from `/chat/completions` with
   * `stream: true`. Parses `data: {…}` frames, accumulates text/tool-call
   * deltas across chunks (matching the OpenAI wire format), and fires
   * `events.onText`/`events.onToolCall` per delta — the same callback shape
   * the SDK path uses, so callers see identical streaming behavior.
   */
  async consumeSSEStream(body, events, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    let finishReason;
    let usage;
    const calls = new Map();
    const handleFrame = (data) => {
      if (data === '[DONE]') return;
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return; // Skip malformed frames (keepalive comments, partial JSON).
      }
      if (frame.usage)
        usage = {
          promptTokens: frame.usage.prompt_tokens ?? 0,
          completionTokens: frame.usage.completion_tokens ?? 0,
          totalTokens: frame.usage.total_tokens ?? 0,
        };
      const choice = frame.choices?.[0];
      if (!choice) return;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta ?? {};
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        reasoningContent += reasoningDelta;
        events.onReasoning?.(reasoningDelta);
      }
      if (delta.content) {
        content += delta.content;
        events.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name && !current.name) current.name = tc.function.name;
        if (tc.function?.arguments) current.arguments += tc.function.arguments;
        calls.set(index, current);
      }
    };
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line. A frame may carry several
        // `data:` lines; per the spec, multi-line data is concatenated with
        // `\n` before parsing. OpenAI sends one JSON object per frame, but
        // other providers (and proxies) may split a payload across lines.
        let separator;
        while ((separator = buffer.match(/\r?\n\r?\n/))) {
          const separatorIndex = separator.index ?? 0;
          const rawFrame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + separator[0].length);
          const dataLines = rawFrame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''));
          if (dataLines.length) handleFrame(dataLines.join('\n'));
        }
      }
      // Flush any trailing buffered frame (servers may omit the final blank line).
      buffer += decoder.decode();
      const trailingData = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''));
      if (trailingData.length) handleFrame(trailingData.join('\n'));
    } finally {
      reader.releaseLock();
    }
    const toolCalls = [...calls.values()];
    for (const call of toolCalls) events.onToolCall?.(call);
    return {
      message: {
        role: 'assistant',
        content: content || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finishReason,
      usage,
    };
  }
  headers() {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }
  activeModel() {
    return this.fallbackIndex < 0
      ? this.options.model
      : ((this.options.fallbackModels ?? [])[this.fallbackIndex] ?? this.options.model);
  }
}
/**
 * Adapts {@link CapyClient} to the {@link Provider} surface so callers can
 * list/validate models and read display metadata uniformly across backends.
 * `chat` is intentionally unsupported — Capy conversations run through
 * threads via {@link CapyRemoteBackend}, not the /chat/completions endpoint
 * this interface otherwise represents.
 */
export class CapyProviderAdapter {
  client;
  options;
  constructor(client, options) {
    this.client = client;
    this.options = options;
  }
  get baseURL() {
    return this.client.baseURL;
  }
  async models(signal) {
    return (await this.client.models(signal)).map((model) => model.id);
  }
  async validateModel() {
    const models = await this.client.models();
    const match = models.find((model) => model.id === this.options.model && model.captainEligible);
    if (!match)
      throw new Error(
        `Capy model "${this.options.model}" is not available or not Captain eligible at ${this.client.baseURL}.`,
      );
    return {
      id: match.id,
      provider: this.client.baseURL,
      supportsTools: true,
    };
  }
  async chat() {
    throw new Error(
      'Capy chat runs through threads (CapyRemoteBackend); use the backend, not Provider.chat.',
    );
  }
}
