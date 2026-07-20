export const CAPY_BASE_URL = 'https://capy.ai/api/v1';

export interface CapyModel {
  id: string;
  name: string;
  provider: string;
  captainEligible: boolean;
}

export interface CapyRepository {
  repoFullName: string;
  branch: string;
}

export interface CapyProject {
  id: string;
  name: string;
  description?: string | null;
  taskCode?: string;
  repos: CapyRepository[];
}

export type CapyRunState =
  'running' | 'stopping' | 'queued' | 'waiting' | 'blocked' | 'ready' | 'archived' | string;

export interface CapyTask {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

export interface CapyPullRequest {
  number: number;
  url: string;
  repoFullName: string;
  state: string;
  headRef?: string;
  baseRef?: string;
  draft?: boolean;
}

export interface CapyThread {
  id: string;
  projectId: string;
  title?: string | null;
  status?: string;
  runState: CapyRunState;
  waitingOn: string[];
  blockedOn: string[];
  tasks: CapyTask[];
  pullRequests: CapyPullRequest[];
}

export interface CapyMessage {
  id: string;
  source: 'user' | 'assistant' | string;
  content: string;
  createdAt?: string;
}

export class CapyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CapyApiError';
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const body = object(value);
  return Array.isArray(body.items) ? body.items : [];
}

export class CapyClient {
  readonly baseURL: string;
  private readonly request: typeof fetch;

  constructor(
    readonly options: {
      apiKey?: string;
      baseURL?: string;
      fetch?: typeof fetch;
      requestTimeoutMs?: number;
    },
  ) {
    this.baseURL = (options.baseURL ?? CAPY_BASE_URL).replace(/\/$/, '');
    this.request = options.fetch ?? fetch;
  }

  async models(signal?: AbortSignal): Promise<CapyModel[]> {
    const body = object(await this.json('/models', { signal }));
    return (Array.isArray(body.models) ? body.models : []).flatMap((value) => {
      const model = object(value);
      const id = string(model.id);
      if (!id) return [];
      return [
        {
          id,
          name: string(model.name, id),
          provider: string(model.provider),
          captainEligible: model.captainEligible === true,
        },
      ];
    });
  }

  async projects(signal?: AbortSignal): Promise<CapyProject[]> {
    return await this.paginate('/projects', signal, (value) => {
      const project = object(value);
      const id = string(project.id);
      if (!id) return undefined;
      return {
        id,
        name: string(project.name, id),
        description: typeof project.description === 'string' ? project.description : null,
        taskCode: string(project.taskCode) || undefined,
        repos: items(project.repos).flatMap((value) => {
          const repo = object(value);
          const repoFullName = string(repo.repoFullName);
          return repoFullName ? [{ repoFullName, branch: string(repo.branch, 'main') }] : [];
        }),
      };
    });
  }

  async createThread(
    input: { projectId: string; prompt: string; model?: string },
    signal?: AbortSignal,
  ): Promise<CapyThread> {
    return this.thread(
      await this.json('/threads', {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
  }

  async sendMessage(
    threadId: string,
    input: { message: string; model?: string },
    signal?: AbortSignal,
  ): Promise<{ id: string; status: string }> {
    const body = object(
      await this.json(`/threads/${encodeURIComponent(threadId)}/message`, {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
    return { id: string(body.id), status: string(body.status) };
  }

  async stopThread(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/threads/${encodeURIComponent(threadId)}/stop`, {
      method: 'POST',
      signal,
      body: '{}',
    });
  }

  async getThread(threadId: string, signal?: AbortSignal): Promise<CapyThread> {
    return this.thread(await this.json(`/threads/${encodeURIComponent(threadId)}`, { signal }));
  }

  async messages(threadId: string, signal?: AbortSignal): Promise<CapyMessage[]> {
    return await this.paginate(
      `/threads/${encodeURIComponent(threadId)}/messages`,
      signal,
      (value) => {
        const message = object(value);
        const id = string(message.id);
        const content = string(message.content);
        if (!id) return undefined;
        return {
          id,
          source: string(message.source),
          content,
          createdAt: string(message.createdAt) || undefined,
        };
      },
    );
  }

  private thread(value: unknown): CapyThread {
    const body = object(value);
    const id = string(body.id);
    const projectId = string(body.projectId);
    if (!id || !projectId) throw new Error('Capy returned an invalid thread response');
    return {
      id,
      projectId,
      title: typeof body.title === 'string' ? body.title : null,
      status: string(body.status) || undefined,
      runState: string(body.runState, string(body.status, 'running')),
      waitingOn: strings(body.waitingOn),
      blockedOn: strings(body.blockedOn),
      tasks: items(body.tasks).flatMap((value) => {
        const task = object(value);
        const taskId = string(task.id);
        return taskId
          ? [
              {
                id: taskId,
                identifier: string(task.identifier, taskId),
                title: string(task.title),
                status: string(task.status),
              },
            ]
          : [];
      }),
      pullRequests: items(body.pullRequests).flatMap((value) => {
        const pull = object(value);
        const url = string(pull.url);
        return url
          ? [
              {
                number: typeof pull.number === 'number' ? pull.number : 0,
                url,
                repoFullName: string(pull.repoFullName),
                state: string(pull.state),
                headRef: string(pull.headRef) || undefined,
                baseRef: string(pull.baseRef) || undefined,
                draft: pull.draft === true,
              },
            ]
          : [];
      }),
    };
  }

  private async paginate<T>(
    path: string,
    signal: AbortSignal | undefined,
    parse: (value: unknown) => T | undefined,
  ): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const query = `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = object(await this.json(query, { signal }));
      for (const value of items(body)) {
        const parsed = parse(value);
        if (parsed !== undefined) result.push(parsed);
      }
      cursor = typeof body.nextCursor === 'string' ? body.nextCursor : undefined;
      if (body.hasMore !== true || !cursor) break;
    }
    return result;
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000;
    const controller = new AbortController();
    let timedOut = false;
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Capy request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let response: Response;
    let raw: string;
    try {
      response = await this.request(`${this.baseURL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...init.headers,
        },
      });
      raw = await response.text();
    } catch (error) {
      if (timedOut)
        throw new CapyApiError(`Capy request timed out after ${timeoutMs}ms`, 408, 'timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = object(object(body).error);
      const message = this.sanitize(
        string(error.message, `Capy request failed (${response.status})`),
      );
      throw new CapyApiError(message, response.status, string(error.code) || undefined);
    }
    return body;
  }

  private sanitize(message: string): string {
    let safe = message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    if (this.options.apiKey) safe = safe.split(this.options.apiKey).join('[REDACTED]');
    return safe.replace(/\bcapy_[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  }
}
