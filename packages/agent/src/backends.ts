import type { LocalStore, Session } from '@kyokao/memory';
import {
  CapyClient,
  type CapyPullRequest,
  type CapyTask,
  type CapyThread,
} from '@kyokao/providers';

export type BackendEventKind = 'assistant' | 'tool' | 'status' | 'error' | 'usage';
export type BackendEmit = (kind: BackendEventKind, value: unknown) => void;

export interface BackendStatus {
  provider: string;
  state: string;
  sessionId?: string;
  projectId?: string;
  threadId?: string;
  waitingOn?: string[];
  blockedOn?: string[];
  tasks?: CapyTask[];
  pullRequests?: CapyPullRequest[];
}

export interface PromptBackend {
  readonly provider: string;
  run(prompt: string, emit: BackendEmit, signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  resume(session: Session): Promise<void>;
  status(): BackendStatus;
  session(): Session | undefined;
  close(): Promise<void>;
}

export interface LocalAgentBackendOptions {
  store: LocalStore;
  createAgent: (
    signal: AbortSignal,
    emit: BackendEmit,
  ) => { run(prompt: string, session?: Session): Promise<Session> };
}

export class LocalAgentBackend implements PromptBackend {
  readonly provider = 'local';
  private current?: Session;
  private controller?: AbortController;

  constructor(private readonly options: LocalAgentBackendOptions) {}

  async run(prompt: string, emit: BackendEmit, signal: AbortSignal): Promise<void> {
    this.current ??= await this.options.store.create(prompt);
    this.current.provider = 'local';
    this.current.checkpoint = 'starting';
    await this.options.store.saveSession(this.current);
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
    try {
      if (controller.signal.aborted) {
        this.current.messages.push({ role: 'user', content: prompt });
        this.current.checkpoint = 'interrupted';
        await this.options.store.saveSession(this.current);
        throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
      }
      this.current = await this.options
        .createAgent(controller.signal, emit)
        .run(prompt, this.current);
    } catch (error) {
      if (controller.signal.aborted) {
        this.current.checkpoint = 'interrupted';
        await this.options.store.saveSession(this.current);
        throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
      }
      this.current.checkpoint = `failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.options.store.saveSession(this.current);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.controller = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
  }

  async reset(): Promise<void> {
    this.current = undefined;
  }

  async resume(session: Session): Promise<void> {
    if (session.remote)
      throw new Error('This is a Capy session; switch to the Capy provider first.');
    this.current = session;
  }

  status(): BackendStatus {
    return {
      provider: this.provider,
      state: this.controller ? 'running' : 'ready',
      sessionId: this.current?.id,
    };
  }

  session(): Session | undefined {
    return this.current;
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}

export interface CapyRemoteBackendOptions {
  client: CapyClient;
  store: LocalStore;
  projectId: string;
  model: string;
  pollMinMs?: number;
  pollMaxMs?: number;
  stopTimeoutMs?: number;
  random?: () => number;
}

const activeStates = new Set(['running', 'stopping', 'queued', 'waiting', 'blocked']);

export class CapyRemoteBackend implements PromptBackend {
  readonly provider = 'capy';
  private current?: Session;
  private thread?: CapyThread;
  private stopping?: Promise<void>;
  private seenMessages = new Set<string>();

  constructor(private readonly options: CapyRemoteBackendOptions) {}

  async run(prompt: string, emit: BackendEmit, signal: AbortSignal): Promise<void> {
    this.current ??= await this.options.store.create(prompt);
    this.current.provider = 'capy';
    this.current.messages.push({ role: 'user', content: prompt });
    this.current.checkpoint = 'remote starting';
    await this.options.store.saveSession(this.current);
    if (this.current.remote) {
      if (this.current.remote.projectId !== this.options.projectId)
        throw new Error(
          `Session is bound to Capy project ${this.current.remote.projectId}; configured project is ${this.options.projectId}.`,
        );
      await this.options.client.sendMessage(
        this.current.remote.threadId,
        { message: prompt, model: this.options.model },
        signal,
      );
    } else {
      this.thread = await this.options.client.createThread(
        { projectId: this.options.projectId, prompt, model: this.options.model },
        signal,
      );
      this.current.remote = {
        provider: 'capy',
        projectId: this.options.projectId,
        threadId: this.thread.id,
        runState: this.thread.runState,
      };
      await this.options.store.saveSession(this.current);
    }
    await this.poll(emit, signal);
  }

  async cancel(): Promise<void> {
    const threadId = this.current?.remote?.threadId;
    if (!threadId || (this.thread && !activeStates.has(this.thread.runState))) return;
    this.stopping ??= this.stopAndWait(threadId).finally(() => {
      this.stopping = undefined;
    });
    await this.stopping;
  }

  async reset(): Promise<void> {
    await this.cancel();
    this.current = undefined;
    this.thread = undefined;
    this.seenMessages.clear();
  }

  async resume(session: Session): Promise<void> {
    if (!session.remote || session.remote.provider !== 'capy')
      throw new Error('This is a local session; switch to its local provider first.');
    if (session.remote.projectId !== this.options.projectId)
      throw new Error(
        `Session uses Capy project ${session.remote.projectId}; select that project before resuming.`,
      );
    this.current = session;
    this.thread = await this.options.client.getThread(session.remote.threadId);
    for (const message of await this.options.client.messages(session.remote.threadId))
      this.seenMessages.add(message.id);
  }

  status(): BackendStatus {
    return {
      provider: this.provider,
      state: this.thread?.runState ?? this.current?.remote?.runState ?? 'ready',
      sessionId: this.current?.id,
      projectId: this.current?.remote?.projectId ?? this.options.projectId,
      threadId: this.current?.remote?.threadId,
      waitingOn: this.thread?.waitingOn,
      blockedOn: this.thread?.blockedOn,
      tasks: this.thread?.tasks,
      pullRequests: this.thread?.pullRequests,
    };
  }

  session(): Session | undefined {
    return this.current;
  }

  async close(): Promise<void> {
    await this.cancel();
  }

  private async poll(emit: BackendEmit, signal: AbortSignal): Promise<void> {
    const threadId = this.current!.remote!.threadId;
    let delay = this.options.pollMinMs ?? 700;
    let previousStatus = '';
    while (true) {
      signal.throwIfAborted();
      this.thread = await this.options.client.getThread(threadId, signal);
      this.current!.remote!.runState = this.thread.runState;
      const status = this.describe(this.thread);
      if (status !== previousStatus) {
        emit('status', status);
        previousStatus = status;
      }
      for (const message of await this.options.client.messages(threadId, signal)) {
        if (this.seenMessages.has(message.id)) continue;
        this.seenMessages.add(message.id);
        if (message.source === 'assistant') {
          this.current!.messages.push({ role: 'assistant', content: message.content });
          emit('assistant', message.content);
        }
      }
      this.current!.checkpoint = `remote ${this.thread.runState}`;
      await this.options.store.saveSession(this.current!);
      if (this.thread.runState === 'ready' || this.thread.runState === 'archived') return;
      await sleep(jitter(delay, this.options.random), signal);
      delay = Math.min(this.options.pollMaxMs ?? 5000, Math.ceil(delay * 1.5));
    }
  }

  private async stopAndWait(threadId: string): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.options.stopTimeoutMs ?? 8000;
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CapyStopTimeoutError(threadId, timeoutMs));
        controller.abort();
      }, timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          await this.options.client.stopThread(threadId, controller.signal);
          while (true) {
            this.thread = await this.options.client.getThread(threadId, controller.signal);
            if (!activeStates.has(this.thread.runState)) return;
            await sleep(Math.min(500, Math.max(10, deadline - Date.now())), controller.signal);
          }
        })(),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private describe(thread: CapyThread): string {
    const details = [
      thread.waitingOn.length ? `waiting on ${thread.waitingOn.join(', ')}` : '',
      thread.blockedOn.length ? `blocked on ${thread.blockedOn.join(', ')}` : '',
      thread.tasks.length
        ? `tasks ${thread.tasks.map((task) => `${task.identifier}:${task.status}`).join(', ')}`
        : '',
      thread.pullRequests.length
        ? `PRs ${thread.pullRequests.map((pull) => pull.url).join(', ')}`
        : '',
    ].filter(Boolean);
    return `Capy ${thread.runState}${details.length ? ` · ${details.join(' · ')}` : ''}`;
  }
}

export class CapyStopTimeoutError extends Error {
  constructor(threadId: string, timeoutMs: number) {
    super(`Capy thread ${threadId} stop timed out after ${timeoutMs}ms`);
    this.name = 'CapyStopTimeoutError';
  }
}

function jitter(delay: number, random = Math.random): number {
  return Math.max(1, Math.round(delay * (0.85 + random() * 0.3)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
