import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runAgentClient, type JsonRpcMessage } from '@kyokao/agent';
import type { PromptBackend, BackendEmit } from '@kyokao/agent';
import type { Session } from '@kyokao/memory';

class StubBackend implements PromptBackend {
  readonly provider = 'stub';
  public prompts: string[] = [];
  public runs = 0;
  public cancelled = false;
  private currentSession: Session = {
    id: 'stub-session',
    task: 'stub',
    messages: [],
    checkpoint: 'ready',
  } as unknown as Session;
  private emitFn: BackendEmit = () => {};

  constructor(private readonly script: (emit: BackendEmit) => void) {}

  async run(prompt: string, emit: BackendEmit): Promise<void> {
    this.prompts.push(prompt);
    this.runs += 1;
    this.emitFn = emit;
    this.script(emit);
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
  }
  async reset(): Promise<void> {
    this.prompts = [];
  }
  async resume(): Promise<void> {}
  status() {
    return { provider: this.provider, state: 'ready' };
  }
  session() {
    return this.currentSession;
  }
  async close(): Promise<void> {}
}

function readMessages(stream: PassThrough): JsonRpcMessage[] {
  const output = stream.read()?.toString() ?? '';
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcMessage);
}

async function runProtocol(
  backend: PromptBackend,
  lines: string[],
): Promise<{ messages: JsonRpcMessage[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runAgentClient(input, output, backend);
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return { messages: readMessages(output) };
}

describe('Agent Client protocol', () => {
  it('initialize handshake returns protocol version and capabilities', async () => {
    const backend = new StubBackend(() => {});
    const { messages } = await runProtocol(backend, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ]);
    const init = messages.find((m) => m.id === 1);
    expect(init?.result).toMatchObject({
      protocolVersion: expect.any(String),
      serverInfo: { name: expect.any(String), version: expect.any(String) },
      capabilities: { approvalPolicy: true, streaming: true },
    });
  });

  it('rejects requests before initialize', async () => {
    const backend = new StubBackend(() => {});
    const { messages } = await runProtocol(backend, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'turn/run', params: { prompt: 'hi' } }),
    ]);
    expect(messages.find((m) => m.id === 1)?.error?.message).toContain('not initialized');
  });

  it('turn/run streams item notifications then turn/completed', async () => {
    const backend = new StubBackend((emit) => {
      emit('assistant', 'hello');
      emit('tool', 'read_file {}');
      emit('tool-result', 'read_file: done');
      emit('usage', { totalTokens: 42 });
    });
    const { messages } = await runProtocol(backend, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'turn/run', params: { prompt: 'greet' } }),
    ]);
    const methods = messages.map((m) => m.method);
    expect(methods).toContain('turn/started');
    expect(methods).toContain('item/assistant');
    expect(methods).toContain('item/tool');
    expect(methods).toContain('item/toolResult');
    expect(methods).toContain('item/usage');
    expect(methods).toContain('turn/completed');

    const turnResponse = messages.find((m) => m.id === 2);
    expect(turnResponse?.result).toMatchObject({ turnId: expect.any(String) });

    expect(backend.prompts).toEqual(['greet']);
  });

  it('turn/interrupt cancels an in-flight turn', async () => {
    let releaseTurn!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const backend = new StubBackend(async () => {
      await blocked;
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const done = runAgentClient(input, output, backend);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'turn/run', params: { prompt: 'block' } })}\n`,
    );

    await new Promise((r) => setImmediate(r));
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/interrupt', params: {} })}\n`,
    );
    releaseTurn();
    input.end();
    await done;
    expect(backend.cancelled).toBe(true);
  });

  it('returns a method-not-found error for unknown methods', async () => {
    const backend = new StubBackend(() => {});
    const { messages } = await runProtocol(backend, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nonexistent', params: {} }),
    ]);
    const err = messages.find((m) => m.id === 2)?.error;
    expect(err?.code).toBe(-32601);
    expect(err?.message).toContain('Method not found');
  });

  it('rejects malformed JSON with a parse error', async () => {
    const backend = new StubBackend(() => {});
    const { messages } = await runProtocol(backend, ['{not valid json']);
    expect(messages[0]?.error?.code).toBe(-32700);
  });
});
