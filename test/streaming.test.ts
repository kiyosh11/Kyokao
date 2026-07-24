import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '@kyokao/providers';

function streamingFetch(frames: unknown[]): typeof fetch {
  const encoder = new TextEncoder();
  const body =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    )) as typeof fetch;
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('fetchChat streaming (custom-fetch path)', () => {
  it('streams text deltas via onText and accumulates the full message', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'fake',
      fetch: streamingFetch([
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: { content: ', ' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'world!' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ]),
    });
    const deltas: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      onText: (delta) => deltas.push(delta),
    });
    expect(deltas).toEqual(['Hello', ', ', 'world!']);
    expect(result.message.content).toBe('Hello, world!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.totalTokens).toBe(13);
  });

  it('streams NVIDIA reasoning separately before the final answer', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'test-key',
      model: 'openai/gpt-oss-120b',
      fetch: streamingFetch([
        { choices: [{ delta: { reasoning_content: 'Inspecting' }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_content: ' the request.' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'Final answer.' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    });
    const order: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      onReasoning: (delta) => order.push(`reasoning:${delta}`),
      onText: (delta) => order.push(`text:${delta}`),
    });

    expect(order).toEqual([
      'reasoning:Inspecting',
      'reasoning: the request.',
      'text:Final answer.',
    ]);
    expect(result.message).toMatchObject({
      reasoning_content: 'Inspecting the request.',
      content: 'Final answer.',
    });
  });

  it('uses the NVIDIA GPT-OSS multi-turn contract on the second request', async () => {
    let requestBody: any;
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'test-key',
      model: 'openai/gpt-oss-120b',
      reasoningEffort: 'low',
      fetch: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return streamingFetch([
          { choices: [{ delta: { content: 'Second answer.' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])(_input, init);
      }) as typeof fetch,
    });

    await provider.chat(
      [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          reasoning_content: 'Private first-turn reasoning.',
          content: 'First answer.',
        },
        { role: 'user', content: 'second' },
      ],
      [],
    );

    expect(requestBody.reasoning_effort).toBe('low');
    expect(requestBody.stream).toBe(true);
    expect(requestBody.messages).toHaveLength(1);
    expect(requestBody.messages[0]).toMatchObject({ role: 'user' });
    expect(requestBody.messages[0].content).toContain('<conversation_history>');
    expect(requestBody.messages[0].content).toContain('User: first');
    expect(requestBody.messages[0].content).toContain('Assistant: First answer.');
    expect(requestBody.messages[0].content).toContain('<current_request>\nsecond');
    expect(requestBody.messages[0].content).not.toContain('Private first-turn reasoning.');
  });

  it('keeps current-turn NVIDIA tool calls structured after flattening completed turns', async () => {
    let requestBody: any;
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'test-key',
      model: 'openai/gpt-oss-120b',
      reasoningEffort: 'low',
      stream: false,
      fetch: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return jsonFetch({
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        })(_input, init);
      }) as typeof fetch,
    });

    await provider.chat(
      [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'First answer.' },
        { role: 'user', content: 'write it' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Do not replay this reasoning.',
          tool_calls: [{ id: 'call-1', name: 'write_file', arguments: '{"path":"a.txt"}' }],
        },
        { role: 'tool', tool_call_id: 'call-1', name: 'write_file', content: 'Wrote a.txt' },
      ],
      [],
    );

    expect(requestBody.messages.map((message: any) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(requestBody.messages[1].content).toContain('First answer.');
    expect(requestBody.messages[2]).toMatchObject({
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    expect(requestBody.messages[2]).not.toHaveProperty('reasoning_content');
    expect(requestBody.messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'Wrote a.txt',
    });
  });

  it('does not send NVIDIA-only reasoning parameters to other providers', async () => {
    let requestBody: any;
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'provider/reasoning-model',
      reasoningEffort: 'low',
      stream: false,
      fetch: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return jsonFetch({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        })(_input, init);
      }) as typeof fetch,
    });

    await provider.chat(
      [
        {
          role: 'assistant',
          reasoning_content: 'Provider-specific history.',
          content: 'Previous answer.',
        },
      ],
      [],
    );

    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(requestBody.messages[0]).toMatchObject({
      reasoning_content: 'Provider-specific history.',
    });
  });

  it('turns a bodyless NVIDIA 404 into an actionable model error', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'test-key',
      model: '01-ai/yi-large',
      fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });

    await expect(provider.chat([{ role: 'user', content: 'hi' }], [])).rejects.toMatchObject({
      name: 'ProviderModelUnavailableError',
      status: 404,
      message:
        'NVIDIA cannot serve model "01-ai/yi-large" through Chat Completions (404). Choose another NVIDIA chat model with /model.',
    });
  });

  it('lists only NVIDIA models that are active free chat endpoints', async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'test-key',
      model: 'openai/gpt-oss-120b',
      fetch: (async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, authorization: headers.get('authorization') ?? undefined });
        if (url.endsWith('/models'))
          return new Response(
            JSON.stringify({
              data: [
                { id: '01-ai/yi-large' },
                { id: 'openai/gpt-oss-120b' },
                { id: 'meta/llama-3.1-70b-instruct' },
                { id: 'nvidia/nv-embed-v1' },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        if (url.startsWith('https://api.ngc.nvidia.com/'))
          return new Response(
            JSON.stringify({
              results: [
                {
                  resources: [
                    {
                      name: 'gpt-oss-120b',
                      displayName: 'gpt-oss-120b',
                      labels: [
                        { key: 'publisher', values: ['openai'] },
                        { key: 'nimType', values: ['Download Available', 'Free Endpoint'] },
                        { key: 'playgroundType', values: ['chat'] },
                      ],
                      attributes: [{ key: 'AVAILABLE', value: 'true' }],
                    },
                    {
                      name: 'llama-3_1-70b-instruct',
                      displayName: 'llama-3.1-70b-instruct',
                      labels: [
                        { key: 'publisher', values: ['meta'] },
                        { key: 'nimType', values: ['Free Endpoint'] },
                        { key: 'playgroundType', values: ['chat'] },
                      ],
                      attributes: [{ key: 'AVAILABLE', value: 'true' }],
                    },
                    {
                      name: 'nv-embed-v1',
                      displayName: 'nv-embed-v1',
                      labels: [
                        { key: 'publisher', values: ['nvidia'] },
                        { key: 'nimType', values: ['Free Endpoint'] },
                        { key: 'playgroundType', values: ['embedding'] },
                      ],
                      attributes: [{ key: 'AVAILABLE', value: 'true' }],
                    },
                  ],
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch,
    });

    await expect(provider.models()).resolves.toEqual([
      'openai/gpt-oss-120b',
      'meta/llama-3.1-70b-instruct',
    ]);
    expect(calls[0]).toMatchObject({
      url: 'https://integrate.api.nvidia.com/v1/models',
      authorization: 'Bearer test-key',
    });
    expect(
      calls[1]!.url.startsWith('https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT?'),
    ).toBe(true);
    expect(calls[1]!.authorization).toBeUndefined();
  });

  it('reassembles tool-call deltas split across chunks and fires onToolCall', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'fake',
      fetch: streamingFetch([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'write_file', arguments: '{"path":"answer' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '.txt","content":"ok"}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    });
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const result = await provider.chat([{ role: 'user', content: 'write it' }], [], {
      onToolCall: (call) => toolCalls.push(call),
    });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'write_file',
      arguments: '{"path":"answer.txt","content":"ok"}',
    });
    expect(result.message.tool_calls?.[0]).toMatchObject({ id: 'call_1', name: 'write_file' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('parses usage from the final stream chunk', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'fake',
      fetch: streamingFetch([
        { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
      ]),
    });
    const result = await provider.chat([{ role: 'user', content: 'go' }], []);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
  });

  it('falls back to the non-streaming JSON path when stream === false', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'fake',
      stream: false,
      fetch: jsonFetch({
        choices: [
          {
            message: { content: 'all at once', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    });
    const deltas: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      onText: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual([]);
    expect(result.message.content).toBe('all at once');
    expect(result.usage?.totalTokens).toBe(3);
  });

  it('parses multi-line data frames and ignores malformed JSON gracefully', async () => {
    const encoder = new TextEncoder();
    const body =
      'data: {"choices":' +
      '\n' +
      'data: [{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: not-json-keepalive\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      apiKey: 'test-key',
      model: 'fake',
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        )) as typeof fetch,
    });
    const deltas: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      onText: (delta) => deltas.push(delta),
    });
    expect(deltas).toEqual(['ok']);
    expect(result.message.content).toBe('ok');
    expect(result.finishReason).toBe('stop');
  });

  it('parses CRLF-delimited NVIDIA-compatible SSE frames', async () => {
    const encoder = new TextEncoder();
    const body =
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'test-key',
      model: 'openai/gpt-oss-120b',
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch,
    });
    const result = await provider.chat([{ role: 'user', content: 'go' }], []);
    expect(result.message).toMatchObject({
      reasoning_content: 'thinking',
      content: 'done',
    });
  });
});
