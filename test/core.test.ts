import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, redact } from '@kyokao/config';
import { WorkspaceSandbox, CoreTools } from '@kyokao/tools';
import { LocalStore } from '@kyokao/memory';
import { OpenAICompatibleProvider, toOpenAIMessage } from '@kyokao/providers';
import { Agent } from '@kyokao/agent';
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function fakeServer(handler: (body: any, call: number) => string) {
  let call = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(handler(JSON.parse(raw), ++call));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}
describe('configuration', () => {
  it('uses profile before environment and redacts nested secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    await writeFile(
      join(dir, '.kyokao.json'),
      JSON.stringify({ profiles: { dev: { model: 'profile' } } }),
    );
    const config = await loadConfig({
      cwd: dir,
      profile: 'dev',
      env: { ...process.env, KYOKAO_MODEL: 'environment', KYOKAO_MAX_ITERATIONS: '3' },
    });
    expect(config.model).toBe('environment');
    expect(config.maxIterations).toBe(3);
    expect(redact({ nested: { apiKey: 'x' } })).toEqual({ nested: { apiKey: '***REDACTED***' } });
  });
});
describe('sandbox and tools', () => {
  it('allows deeply nested creation and returns shell failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    const tools = new CoreTools(new WorkspaceSandbox(dir), 'full-auto');
    expect(
      (await tools.execute('write_file', { path: 'a/b/c/x.txt', content: 'ok' })).isError,
    ).toBeFalsy();
    expect(await readFile(join(dir, 'a/b/c/x.txt'), 'utf8')).toBe('ok');
    expect((await tools.execute('read_file', { path: '../x' })).isError).toBe(true);
    expect(
      (
        await tools.execute('shell', {
          command: process.platform === 'win32' ? 'exit /b 7' : 'echo bad >&2; exit 7',
        })
      ).content,
    ).toContain('exit code');
  });
});
describe('OpenAI SDK streaming transcript', () => {
  it('streams, reconstructs tool calls, persists wire-valid history, and resumes once', async () => {
    const requests: any[] = [];
    const url = await fakeServer((body, call) => {
      requests.push(body);
      if (call === 1) {
        const first = {
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
        };
        const second = {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '.txt","content":"ok"}' } }],
              },
              finish_reason: null,
            },
          ],
        };
        return (
          event(first) +
          event(second) +
          event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
          'data: [DONE]\n\n'
        );
      }
      return (
        event({
          choices: [{ delta: { content: call === 2 ? 'done' : 'resumed' }, finish_reason: null }],
        }) +
        event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n'
      );
    });
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    const store = new LocalStore(join(dir, '.kyokao'));
    const text: string[] = [];
    const agent = new Agent({
      provider: new OpenAICompatibleProvider({ baseURL: url, model: 'fake' }),
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
      store,
      maxIterations: 4,
      workspace: dir,
      onEvent: (kind, value) => {
        if (kind === 'text') text.push(value);
      },
    });
    const session = await agent.run('write it');
    expect(text.join('')).toContain('done');
    expect(session.messages.find((message) => message.role === 'tool')?.content).toBe(
      'Wrote answer.txt',
    );
    expect(await readFile(join(dir, 'answer.txt'), 'utf8')).toBe('ok');
    expect(
      requests[1].messages.find((message: any) => message.role === 'assistant').tool_calls[0],
    ).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'write_file' } });
    expect(requests[1].messages.find((message: any) => message.role === 'tool')).toMatchObject({
      tool_call_id: 'call_1',
      content: 'Wrote answer.txt',
    });
    await agent.run('continue', await store.loadSession(session.id));
    expect(
      requests[2].messages
        .filter((message: any) => message.role === 'user')
        .map((message: any) => message.content),
    ).toEqual(['write it', 'continue']);
  });
  it('maps internal calls to wire format', () =>
    expect(
      toOpenAIMessage({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'x', name: 'f', arguments: '{}' }],
      }),
    ).toMatchObject({
      tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
    }));
});
