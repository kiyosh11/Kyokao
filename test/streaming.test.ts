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
