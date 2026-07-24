import { describe, expect, it, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOutputFormat,
  runHeadless,
  type RecordedEvent,
} from '../packages/cli/src/headless.js';
import { buildRuntime } from '../packages/cli/src/runtime.js';
import { loadConfig } from '@kyokao/config';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

async function fakeOpenAIServer() {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: body.model ?? 'stub' }] }));
      return;
    }

    response.end(
      event({ choices: [{ delta: { content: 'stubbed answer' }, finish_reason: null }] }) +
        event({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }) +
        'data: [DONE]\n\n',
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

describe('resolveOutputFormat', () => {
  it('honors an explicit format regardless of TTY', () => {
    expect(resolveOutputFormat('json', true)).toBe('json');
    expect(resolveOutputFormat('streaming-json', false)).toBe('streaming-json');
    expect(resolveOutputFormat('plain', true)).toBe('plain');
  });

  it('defaults to plain in a TTY and streaming-json when piped', () => {
    expect(resolveOutputFormat(undefined, true)).toBe('plain');
    expect(resolveOutputFormat(undefined, false)).toBe('streaming-json');
  });
});

describe('runHeadless', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildRuntimeAgainstFakeServer() {
    const baseURL = await fakeOpenAIServer();
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-headless-'));

    const home = await mkdtemp(join(tmpdir(), 'kyokao-home-'));
    const globalPath = join(dir, 'config.json');
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'custom',
        model: 'stub',
        approval: 'full-auto',
        providers: { custom: { baseURL } },
      }),
    );
    process.env.KYOKAO_HOME = home;

    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const config = await loadConfig({ globalPath });
      return { runtime: await buildRuntime(config), dir };
    } finally {
      process.chdir(previousCwd);
    }
  }

  it('streaming-json emits one NDJSON line per backend event', async () => {
    const { runtime, dir } = await buildRuntimeAgainstFakeServer();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await runHeadless(runtime, 'hello', undefined, 'streaming-json', true, undefined);
    } finally {
      spy.mockRestore();
      await runtime.tools.close?.();
      process.chdir(dir);
      delete process.env.KYOKAO_HOME;
    }
    const records = lines.flatMap((line) =>
      line
        .split('\n')
        .filter(Boolean)
        .map((json) => JSON.parse(json) as RecordedEvent),
    );
    const kinds = records.map((r) => r.kind);
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('usage');
    for (const record of records) expect(typeof record.ts).toBe('number');
  });

  it('json emits a single aggregated object with events, session, and answer', async () => {
    const { runtime, dir } = await buildRuntimeAgainstFakeServer();
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runHeadless(runtime, 'hello', undefined, 'json', true, undefined);
    } finally {
      spy.mockRestore();
      await runtime.tools.close?.();
      process.chdir(dir);
      delete process.env.KYOKAO_HOME;
    }
    const parsed = JSON.parse(output) as {
      events: RecordedEvent[];
      session: { id: string } | null;
      answer: string | null;
    };
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.session?.id).toBeTruthy();
    expect(parsed.answer).toBe('stubbed answer');
  });
});
