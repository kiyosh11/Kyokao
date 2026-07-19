import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, redact } from '@kyokao/config';
import {
  WorkspaceSandbox,
  CoreTools,
  CompositeTools,
  loadPlugins,
  connectMcp,
} from '@kyokao/tools';
import { LocalStore } from '@kyokao/memory';
import { OpenAICompatibleProvider, modelCatalog, toOpenAIMessage } from '@kyokao/providers';
import { Agent, compressMessages, estimateTokens, loadInstructionFiles } from '@kyokao/agent';
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
  it('accepts MCP, plugin, and context settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    await writeFile(
      join(dir, '.kyokao.json'),
      JSON.stringify({
        contextWindow: 4000,
        compressionThreshold: 0.7,
        plugins: ['./plugin.mjs'],
        editor: 'code',
        editorArgs: ['--wait'],
        temperature: 0.2,
        maxTokens: 500,
        fallbackModels: ['backup'],
        limits: { maxToolCalls: 4, maxCostUsd: 1, allowedHosts: ['example.com'] },
        mcp: { demo: { command: 'demo-server', args: ['--stdio'] } },
      }),
    );
    const config = await loadConfig({ cwd: dir });
    expect(config.contextWindow).toBe(4000);
    expect(config.mcp.demo.command).toBe('demo-server');
    expect(config.plugins).toEqual(['./plugin.mjs']);
    expect(config.editorArgs).toEqual(['--wait']);
    expect(config.temperature).toBe(0.2);
    expect(config.limits.maxToolCalls).toBe(4);
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
  it('enforces file and network safety limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    const tools = new CoreTools(new WorkspaceSandbox(dir), 'full-auto', undefined, {
      maxShellTimeoutMs: 1000,
      maxOutputChars: 100,
      maxFileBytes: 3,
      allowedHosts: ['example.com'],
    });
    expect(
      (await tools.execute('write_file', { path: 'large.txt', content: 'four' })).isError,
    ).toBe(true);
    expect(
      (await tools.execute('http_get', { url: 'https://not-example.test' })).content,
    ).toContain('not allowed');
  });
  it.skipIf(process.platform === 'win32')('canonicalizes a symlinked workspace root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    const workspace = join(dir, 'workspace');
    const alias = join(dir, 'workspace-link');
    await mkdir(workspace);
    await symlink(workspace, alias);
    const tools = new CoreTools(new WorkspaceSandbox(alias), 'full-auto');
    expect((await tools.execute('write_file', { path: 'answer.txt', content: 'ok' })).isError).toBe(
      undefined,
    );
    expect(await readFile(join(workspace, 'answer.txt'), 'utf8')).toBe('ok');
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
    expect(session.usage?.totalTokens).toBeGreaterThan(0);
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
describe('platform extensions', () => {
  it('compresses old context while preserving the system prompt and recent turn', () => {
    const messages = [
      { role: 'system' as const, content: 'system' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: 'user' as const,
        content: `old ${i} `.repeat(40),
      })),
      { role: 'user' as const, content: 'latest' },
    ];
    const result = compressMessages(messages, 200);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.messages[0]).toMatchObject({ role: 'system' });
    expect(result.messages.at(-1)).toMatchObject({ content: 'latest' });
    expect(estimateTokens(result.messages)).toBeLessThan(500);
  });
  it('composes core and plugin tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    const pluginPath = join(dir, 'plugin.mjs');
    await writeFile(
      pluginPath,
      `export default {
        name: 'demo',
        tools: [{ type: 'function', function: { name: 'demo_echo', description: 'echo', parameters: { type: 'object', properties: {} } } }],
        async execute(name, args) { return { content: name + ':' + JSON.stringify(args) }; }
      }`,
    );
    const [plugin] = await loadPlugins([pluginPath], dir);
    const tools = new CompositeTools([
      new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
      plugin,
    ]);
    expect(tools.definitions().some((definition) => definition.function.name === 'demo_echo')).toBe(
      true,
    );
    expect((await tools.execute('demo_echo', { ok: true })).content).toContain('"ok":true');
  });
  it('ships a model catalog with tool capability metadata', () => {
    expect(modelCatalog.find((model) => model.id === 'gpt-4o-mini')).toMatchObject({
      supportsTools: true,
      contextWindow: 128000,
    });
  });
  it('validates live model availability before a request', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'available' }] }));
      } else response.end(JSON.stringify({ choices: [] }));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const baseURL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
    const provider = new OpenAICompatibleProvider({ baseURL, model: 'available' });
    await expect(provider.validateModel()).resolves.toMatchObject({ id: 'available' });
    await expect(
      new OpenAICompatibleProvider({ baseURL, model: 'missing' }).validateModel(),
    ).rejects.toThrow('not available');
  });
  it('discovers and executes MCP stdio tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    const serverPath = join(dir, 'mcp-server.mjs');
    await writeFile(
      serverPath,
      `let buffer = Buffer.alloc(0);
       process.stdin.on('data', chunk => {
         buffer = Buffer.concat([buffer, chunk]);
         while (true) {
           const end = buffer.indexOf('\\r\\n\\r\\n');
           if (end < 0) break;
           const length = Number(buffer.subarray(0, end).toString().match(/\\d+/)[0]);
           if (buffer.length < end + 4 + length) break;
           const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
           buffer = buffer.subarray(end + 4 + length);
           if (!message.id) continue;
           const result = message.method === 'tools/list'
             ? { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: {} } }] }
             : message.method === 'tools/call'
               ? { content: [{ type: 'text', text: 'mcp ok' }] }
               : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1' } };
           const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
           process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
           process.stdout.write(body);
         }
       });`,
    );
    const tools = await connectMcp(
      { demo: { command: process.execPath, args: [serverPath] } },
      dir,
    );
    expect(tools?.definitions().map((definition) => definition.function.name)).toEqual([
      'mcp_demo_echo',
    ]);
    expect((await tools!.execute('mcp_demo_echo', {})).content).toBe('mcp ok');
    await tools?.close?.();
  });
  it('loads repository instruction files in deterministic order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-'));
    await writeFile(join(dir, 'SOUL.md'), 'Be precise.');
    await writeFile(join(dir, 'CLAUDE.md'), 'Run tests.');
    await mkdir(join(dir, '.kyokao'));
    await writeFile(join(dir, '.kyokao', 'instructions.md'), 'Prefer small patches.');
    const instructions = await loadInstructionFiles(dir);
    expect(instructions.indexOf('SOUL.md')).toBeLessThan(instructions.indexOf('CLAUDE.md'));
    expect(instructions).toContain('Prefer small patches.');
  });
  it('falls back to the next model when a provider rejects the primary', async () => {
    const bodies: any[] = [];
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://provider.test/v1',
      model: 'primary',
      fallbackModels: ['backup'],
      stream: false,
      fetch: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1
          ? new Response('unavailable', { status: 503 })
          : new Response(
              JSON.stringify({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              }),
              { headers: { 'content-type': 'application/json' } },
            );
      }) as typeof fetch,
    });
    await expect(provider.chat([], [])).resolves.toMatchObject({
      message: { content: 'ok' },
    });
    expect(bodies.map((body) => body.model)).toEqual(['primary', 'backup']);
  });
});
