import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SubAgentTools,
  ToolSubset,
  SUBAGENT_DEFAULT_TOOLS,
  SUBAGENT_ALLOWED_TOOLS,
} from '@kyokao/agent';
import { WorkspaceSandbox, CoreTools } from '@kyokao/tools';
import { LocalStore } from '@kyokao/memory';
import { OpenAICompatibleProvider, type ChatMessage } from '@kyokao/providers';

describe('ToolSubset', () => {
  it('exposes only the granted definitions and rejects execution outside the grant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-subset-'));
    const core = new CoreTools(new WorkspaceSandbox(dir), 'full-auto');
    const subset = new ToolSubset(core, ['read_file', 'list_files']);
    const names = subset.definitions().map((d) => d.function.name);
    expect(names).toEqual(['read_file', 'list_files']);

    const blocked = await subset.execute('write_file', { path: 'x', content: 'y' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('not permitted');
  });
});

describe('SubAgentTools', () => {
  it('exposes only the spawn_subagent tool', () => {
    const dir = mkdtempSyncHelper();
    const tools = new SubAgentTools({
      workspace: dir,
      store: new LocalStore(join(dir, '.kyokao')),
      provider: stubProvider(),
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
    });
    expect(tools.definitions().map((d) => d.function.name)).toEqual(['spawn_subagent']);
  });

  it('rejects an empty prompt', async () => {
    const dir = mkdtempSyncHelper();
    const tools = new SubAgentTools({
      workspace: dir,
      store: new LocalStore(join(dir, '.kyokao')),
      provider: stubProvider(),
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
    });
    const result = await tools.execute('spawn_subagent', { prompt: '' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-empty');
  });

  it('rejects an unknown tool name in the requested grant', async () => {
    const dir = mkdtempSyncHelper();
    const tools = new SubAgentTools({
      workspace: dir,
      store: new LocalStore(join(dir, '.kyokao')),
      provider: stubProvider(),
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
    });
    const result = await tools.execute('spawn_subagent', {
      prompt: 'do something',
      tools: ['delete_everything'],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown tool');
  });

  it('runs a sub-agent whose restricted tool set cannot write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-sub-nowrite-'));

    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://stub.test/v1',
      model: 'stub',
      stream: false,
      fetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const hadToolResult = body.messages.some((m: ChatMessage) => m.role === 'tool');

        const message = hadToolResult
          ? { role: 'assistant', content: 'investigation complete' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'w1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"x","content":"y"}' },
                },
              ],
            };
        return new Response(
          JSON.stringify({
            choices: [
              { message, finish_reason: hadToolResult ? 'stop' : 'tool_calls' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const tools = new SubAgentTools({
      workspace: dir,
      store: new LocalStore(join(dir, '.kyokao')),
      provider,
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
    });
    const result = await tools.execute('spawn_subagent', { prompt: 'write a file' });

    expect(result.content).toContain('investigation complete');

    await expect(readFile(join(dir, 'x'), 'utf8')).rejects.toThrow();
  });

  it('honors an explicit write grant when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kyokao-sub-write-'));
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://stub.test/v1',
      model: 'stub',
      stream: false,
      fetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const hadToolResult = body.messages.some((m: ChatMessage) => m.role === 'tool');
        const message = hadToolResult
          ? { role: 'assistant', content: 'wrote it' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'w1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":"granted.txt","content":"ok"}',
                  },
                },
              ],
            };
        return new Response(
          JSON.stringify({
            choices: [
              { message, finish_reason: hadToolResult ? 'stop' : 'tool_calls' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const tools = new SubAgentTools({
      workspace: dir,
      store: new LocalStore(join(dir, '.kyokao')),
      provider,
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
    });
    const result = await tools.execute('spawn_subagent', {
      prompt: 'write granted.txt',
      tools: ['write_file'],
    });
    expect(result.content).toContain('wrote it');
    expect(await readFile(join(dir, 'granted.txt'), 'utf8')).toBe('ok');
  });

  it('enforces the parent cost budget: a spawn that would exceed it fails', async () => {
    const dir = mkdtempSyncHelper();
    let spent = 0.3;
    const tools = new SubAgentTools({
      workspace: dir,
      store: new LocalStore(join(dir, '.kyokao')),
      provider: stubProvider(),
      tools: new CoreTools(new WorkspaceSandbox(dir), 'full-auto'),
      remainingCostUsd: () => 0.1 - spent,
    });

    const result = await tools.execute('spawn_subagent', { prompt: 'go' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('budget exhausted');
  });
});

function mkdtempSyncHelper(): string {
  return mkdtempSync(join(tmpdir(), 'kyokao-sub-'));
}

function stubProvider() {
  return new OpenAICompatibleProvider({
    baseURL: 'https://stub.test/v1',
    model: 'stub',
    stream: false,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'stub' }, finish_reason: 'stop' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  });
}

describe('SubAgentTools constants', () => {
  it('the default grant is read-only and excludes write/shell/http', () => {
    expect(SUBAGENT_DEFAULT_TOOLS).toContain('read_file');
    expect(SUBAGENT_DEFAULT_TOOLS).toContain('git');
    expect(SUBAGENT_DEFAULT_TOOLS).not.toContain('write_file');
    expect(SUBAGENT_DEFAULT_TOOLS).not.toContain('shell');
    expect(SUBAGENT_DEFAULT_TOOLS).not.toContain('http_get');
  });

  it('the allowed set covers all CoreTools names', () => {
    for (const name of ['read_file', 'list_files', 'glob', 'grep', 'write_file', 'apply_patch', 'shell', 'git', 'http_get'])
      expect(SUBAGENT_ALLOWED_TOOLS.has(name)).toBe(true);
  });
});
