import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CapyRemoteBackend,
  LocalAgentBackend,
  PromptScheduler,
  type BackendEmit,
  type PromptBackend,
} from '@kyokao/agent';
import { LocalStore } from '@kyokao/memory';
import { CapyClient } from '@kyokao/providers';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

class ControlledBackend implements PromptBackend {
  readonly provider = 'fake';
  runs: string[] = [];
  active = 0;
  maximumActive = 0;
  releases: Array<() => void> = [];
  fail = new Set<string>();
  cancelled = 0;

  async run(prompt: string, _emit: BackendEmit, signal: AbortSignal) {
    this.runs.push(prompt);
    this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      if (this.fail.has(prompt)) throw new Error(`failed ${prompt}`);
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        this.releases.push(finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    } finally {
      this.active--;
    }
  }
  async cancel() {
    this.cancelled++;
  }
  async reset() {}
  async resume() {}
  status() {
    return { provider: this.provider, state: this.active ? 'running' : 'ready' };
  }
  session() {
    return undefined;
  }
  async close() {}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('prompt scheduler', () => {
  it('stops then starts a replacement ahead of existing FIFO work without double-starting', async () => {
    const backend = new ControlledBackend();
    const phases: string[] = [];
    const events: string[] = [];
    const scheduler = new PromptScheduler({
      backend,
      emit: (kind, value) => events.push(`${kind}:${String(value)}`),
      onRunStart: (prompt) => events.push(`user:${prompt}`),
      onState: (state) => phases.push(state.phase),
    });
    backend.run = async (prompt, emit, signal) => {
      backend.runs.push(prompt);
      backend.active++;
      backend.maximumActive = Math.max(backend.maximumActive, backend.active);
      emit('assistant', `${prompt}-output`);
      try {
        await new Promise<void>((resolve) => {
          backend.releases.push(resolve);
          signal.addEventListener('abort', resolve, { once: true });
        });
      } finally {
        backend.active--;
      }
    };
    void scheduler.submit('first');
    await tick();
    await scheduler.submit('queued', 'queue');
    const replacing = scheduler.submit('replacement', 'replace');
    await tick();
    await replacing;
    expect(backend.runs).toEqual(['first', 'replacement']);
    backend.releases.at(-1)!();
    await tick();
    expect(backend.runs).toEqual(['first', 'replacement', 'queued']);
    backend.releases.at(-1)!();
    await scheduler.waitForIdle();
    expect(backend.maximumActive).toBe(1);
    expect(phases).toContain('stopping');
    expect(phases).toContain('starting-replacement');
    expect(events).toEqual([
      'user:first',
      'assistant:first-output',
      'status:Request cancelled.',
      'user:replacement',
      'assistant:replacement-output',
      'user:queued',
      'assistant:queued-output',
    ]);
  });

  it('persists replacement-first recoverable work during the stopping window', async () => {
    const backend = new ControlledBackend();
    let releaseCancel!: () => void;
    backend.cancel = async () =>
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    const persisted: string[][] = [];
    const scheduler = new PromptScheduler({
      backend,
      emit: () => {},
      onQueueChange: (queue) => persisted.push([...queue]),
    });
    void scheduler.submit('active');
    await tick();
    await scheduler.submit('queued', 'queue');
    const replacing = scheduler.submit('replacement', 'replace');
    await tick();
    expect(scheduler.state()).toMatchObject({
      phase: 'stopping',
      queue: ['replacement', 'queued'],
    });
    expect(persisted.at(-1)).toEqual(['replacement', 'queued']);

    const recoveredBackend = new ControlledBackend();
    const recovered = new PromptScheduler({
      backend: recoveredBackend,
      emit: () => {},
      initialQueue: persisted.at(-1),
    });
    await tick();
    expect(recoveredBackend.runs).toEqual(['replacement']);
    recoveredBackend.releases.at(-1)!();
    while (recoveredBackend.runs.length < 2) await tick();
    expect(recoveredBackend.runs).toEqual(['replacement', 'queued']);
    recoveredBackend.releases.at(-1)!();
    await recovered.waitForIdle();

    expect(replacing).toBeInstanceOf(Promise);
    expect(releaseCancel).toBeTypeOf('function');
  });

  it('queues in insertion order, clears pending work, cancels active work, and resets', async () => {
    const backend = new ControlledBackend();
    let resets = 0;
    backend.reset = async () => {
      resets++;
    };
    const scheduler = new PromptScheduler({ backend, emit: () => {} });
    void scheduler.submit('one');
    await tick();
    await scheduler.submit('two', 'queue');
    await scheduler.submit('three', 'queue');
    expect(await scheduler.clearQueue()).toBe(2);
    await scheduler.cancelActive();
    await scheduler.reset();
    expect(backend.runs).toEqual(['one']);
    expect(backend.cancelled).toBe(1);
    expect(resets).toBe(1);
  });

  it('keeps failed prompts retryable and never starts two runs', async () => {
    const backend = new ControlledBackend();
    backend.fail.add('bad');
    const errors: string[] = [];
    const scheduler = new PromptScheduler({
      backend,
      emit: (kind, value) => kind === 'error' && errors.push(String(value)),
    });
    await scheduler.submit('bad');
    await scheduler.submit('later', 'queue');
    await scheduler.waitForIdle();
    expect(scheduler.state()).toMatchObject({ phase: 'failed', queue: ['bad', 'later'] });
    backend.fail.clear();
    await scheduler.retry();
    await tick();
    backend.releases.at(-1)!();
    await tick();
    backend.releases.at(-1)!();
    await scheduler.waitForIdle();
    expect(backend.runs).toEqual(['bad', 'bad', 'later']);
    expect(backend.maximumActive).toBe(1);
    expect(errors[0]).toContain('/queue retry');
  });

  it('persists a newly created interrupted local session with user context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kyokao-scheduler-'));
    const store = new LocalStore(join(root, '.kyokao'));
    const backend = new LocalAgentBackend({
      store,
      createAgent: (signal) => ({
        async run(prompt, session) {
          session!.messages.push({ role: 'user', content: prompt });
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
          signal.throwIfAborted();
          return session!;
        },
      }),
    });
    const scheduler = new PromptScheduler({ backend, emit: () => {} });
    void scheduler.submit('remember this');
    await tick();
    await scheduler.cancelActive();
    const session = backend.session()!;
    const persisted = JSON.parse(
      await readFile(join(root, '.kyokao', 'sessions', `${session.id}.json`), 'utf8'),
    );
    expect(persisted.checkpoint).toBe('interrupted');
    expect(persisted.messages).toContainEqual({ role: 'user', content: 'remember this' });
  });
});

async function capyServer() {
  const requests: Array<{ method: string; url: string; body: any; authorization?: string }> = [];
  let threadState = 'running';
  let polls = 0;
  let turn = 1;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({
      method: request.method!,
      url: request.url!,
      body,
      authorization: request.headers.authorization,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models')
      return response.end(
        JSON.stringify({
          models: [
            { id: 'captain', name: 'Captain', provider: 'test', captainEligible: true },
            { id: 'other', name: 'Other', provider: 'test', captainEligible: false },
          ],
        }),
      );
    if (request.url?.startsWith('/v1/projects'))
      return response.end(
        JSON.stringify({
          items: [
            {
              id: 'project-1',
              name: 'Project',
              description: null,
              taskCode: 'PRJ',
              repos: [{ repoFullName: 'owner/repo', branch: 'main' }],
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      );
    if (request.method === 'POST' && request.url === '/v1/threads') {
      threadState = 'running';
      polls = 0;
      return response.end(JSON.stringify(thread('running')));
    }
    if (request.method === 'POST' && request.url === '/v1/threads/jam-1/message') {
      turn++;
      threadState = 'running';
      polls = 0;
      return response.end(JSON.stringify({ id: `input-${turn}`, status: 'sent' }));
    }
    if (request.method === 'POST' && request.url === '/v1/threads/jam-1/stop') {
      threadState = 'ready';
      return response.end(JSON.stringify({ id: 'jam-1', status: 'idle' }));
    }
    if (request.url?.startsWith('/v1/threads/jam-1/messages'))
      return response.end(
        JSON.stringify({
          items: [
            {
              id: `assistant-${turn}`,
              source: 'assistant',
              content: `answer-${turn}`,
              createdAt: new Date().toISOString(),
            },
            {
              id: `assistant-${turn}`,
              source: 'assistant',
              content: `answer-${turn}`,
              createdAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      );
    if (request.url === '/v1/threads/jam-1') {
      if (threadState === 'running' && ++polls >= 2) threadState = 'ready';
      return response.end(JSON.stringify(thread(threadState)));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseURL: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`,
    requests,
  };
}

function thread(runState: string) {
  return {
    id: 'jam-1',
    projectId: 'project-1',
    title: 'Test',
    status: runState === 'ready' ? 'idle' : 'active',
    runState,
    waitingOn: runState === 'waiting' ? ['ci'] : [],
    blockedOn: runState === 'blocked' ? ['auth'] : [],
    tasks: [
      {
        id: 'task-1',
        identifier: 'PRJ-1',
        title: 'Task',
        status: runState === 'ready' ? 'completed' : 'in_progress',
      },
    ],
    pullRequests: [
      {
        number: 7,
        url: 'https://github.com/owner/repo/pull/7',
        repoFullName: 'owner/repo',
        state: 'open',
      },
    ],
  };
}

describe('Capy API and remote backend', () => {
  it('surfaces waiting and blocked polling states before readiness', async () => {
    const states = ['waiting', 'blocked', 'ready'];
    const fakeClient = {
      async createThread() {
        return thread('running');
      },
      async getThread() {
        return thread(states.shift() ?? 'ready');
      },
      async messages() {
        return [];
      },
      async sendMessage() {
        return { id: 'input', status: 'sent' };
      },
      async stopThread() {},
    } as unknown as CapyClient;
    const root = await mkdtemp(join(tmpdir(), 'kyokao-capy-states-'));
    const statuses: string[] = [];
    const backend = new CapyRemoteBackend({
      client: fakeClient,
      store: new LocalStore(join(root, '.kyokao')),
      projectId: 'project-1',
      model: 'captain',
      pollMinMs: 1,
      pollMaxMs: 1,
      random: () => 0.5,
    });
    await backend.run(
      'observe',
      (kind, value) => kind === 'status' && statuses.push(String(value)),
      new AbortController().signal,
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.stringContaining('waiting on ci'),
        expect.stringContaining('blocked on auth'),
        expect.stringContaining('Capy ready'),
      ]),
    );
  });

  it('returns actionable API errors without including bearer tokens', async () => {
    const client = new CapyClient({
      apiKey: 'private-capy-token',
      baseURL: 'https://capy.test/v1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'forbidden',
              message: 'Project is inaccessible for Bearer private-capy-token',
            },
          }),
          { status: 403 },
        ),
    });
    const error = await client.projects().catch((value) => value as Error);
    expect(error.message).toContain('Project is inaccessible');
    expect(error.message).not.toContain('private-capy-token');
    expect(error.message).toContain('[REDACTED]');
  });

  it('bounds hanging discovery and stop requests with distinct timeout errors', async () => {
    const hangingFetch: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const client = new CapyClient({
      baseURL: 'https://capy.test/v1',
      fetch: hangingFetch,
      requestTimeoutMs: 10,
    });
    await expect(client.models()).rejects.toMatchObject({ code: 'timeout', status: 408 });

    const fakeClient = {
      async createThread() {
        return thread('running');
      },
      async getThread(_id: string, signal?: AbortSignal) {
        return await new Promise<any>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
      async messages() {
        return [];
      },
      async sendMessage() {
        return { id: 'input', status: 'sent' };
      },
      async stopThread(_id: string, signal?: AbortSignal) {
        return await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
    } as unknown as CapyClient;
    const root = await mkdtemp(join(tmpdir(), 'kyokao-capy-timeout-'));
    const backend = new CapyRemoteBackend({
      client: fakeClient,
      store: new LocalStore(join(root, '.kyokao')),
      projectId: 'project-1',
      model: 'captain',
      stopTimeoutMs: 15,
    });
    const controller = new AbortController();
    const running = backend.run('hang', () => {}, controller.signal);
    while (!backend.status().threadId) await tick();
    await expect(backend.cancel()).rejects.toMatchObject({ name: 'CapyStopTimeoutError' });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses native models/projects/thread/message shapes, deduplicates output, and resumes', async () => {
    const fake = await capyServer();
    const client = new CapyClient({ baseURL: fake.baseURL, apiKey: 'secret-token' });
    expect((await client.models()).filter((model) => model.captainEligible)).toHaveLength(1);
    expect(await client.projects()).toMatchObject([
      { id: 'project-1', repos: [{ repoFullName: 'owner/repo' }] },
    ]);
    const root = await mkdtemp(join(tmpdir(), 'kyokao-capy-'));
    const store = new LocalStore(join(root, '.kyokao'));
    const output: string[] = [];
    const backend = new CapyRemoteBackend({
      client,
      store,
      projectId: 'project-1',
      model: 'captain',
      pollMinMs: 1,
      pollMaxMs: 2,
      random: () => 0.5,
    });
    await backend.run(
      'first',
      (kind, value) => kind === 'assistant' && output.push(String(value)),
      new AbortController().signal,
    );
    await backend.run(
      'second',
      (kind, value) => kind === 'assistant' && output.push(String(value)),
      new AbortController().signal,
    );
    expect(output).toEqual(['answer-1', 'answer-2']);
    expect(fake.requests.find((request) => request.url === '/v1/threads')?.body).toEqual({
      projectId: 'project-1',
      prompt: 'first',
      model: 'captain',
    });
    expect(fake.requests.find((request) => request.url.endsWith('/message'))?.body).toEqual({
      message: 'second',
      model: 'captain',
    });
    expect(fake.requests.every((request) => request.authorization === 'Bearer secret-token')).toBe(
      true,
    );
    expect(JSON.stringify(backend.status())).not.toContain('secret-token');
    const resumed = new CapyRemoteBackend({
      client,
      store,
      projectId: 'project-1',
      model: 'captain',
    });
    await resumed.resume(await store.loadSession(backend.session()!.id));
    expect(resumed.status()).toMatchObject({ threadId: 'jam-1', projectId: 'project-1' });
  });

  it('stops a remote thread on cancellation without leaking the token', async () => {
    const fake = await capyServer();
    const client = new CapyClient({ baseURL: fake.baseURL, apiKey: 'never-render-me' });
    const root = await mkdtemp(join(tmpdir(), 'kyokao-capy-stop-'));
    const backend = new CapyRemoteBackend({
      client,
      store: new LocalStore(join(root, '.kyokao')),
      projectId: 'project-1',
      model: 'captain',
      pollMinMs: 50,
      pollMaxMs: 50,
      stopTimeoutMs: 500,
    });
    const controller = new AbortController();
    const running = backend.run('work', () => {}, controller.signal);
    while (!backend.status().threadId) await tick();
    await backend.cancel();
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.requests.some((request) => request.url.endsWith('/stop'))).toBe(true);
    expect(String(backend.status())).not.toContain('never-render-me');
  });
});
