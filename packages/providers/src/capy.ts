/**
 * Capy API client — HTTP methods for the full Capy REST surface.
 *
 * Types live in `./capy-types.js`; coercion helpers and domain parsers live
 * in `./capy-transport.js`. This file is just the `CapyClient` class: one
 * cohesive unit of 37 API methods + the `json`/`paginate`/`sanitize`
 * transport core (private methods that reference `this.baseURL` etc.).
 */
import { CAPY_BASE_URL, CapyApiError } from './capy-types.js';
import type {
  CapyAutomation,
  CapyBrowserSnapshot,
  CapyBrowserSnapshotDetail,
  CapyClientOptions,
  CapyCreateAutomationInput,
  CapyCreateBrowserSnapshotInput,
  CapyCreateThreadInput,
  CapyEnvironmentVariable,
  CapyListAutomationsOptions,
  CapyListThreadsOptions,
  CapyMessage,
  CapyModel,
  CapyProject,
  CapyProjectSetup,
  CapySendMessageInput,
  CapySendMessageResponse,
  CapySessionToken,
  CapySnapshotsSetting,
  CapyTagColor,
  CapyTaskDetail,
  CapyTaskDiff,
  CapyTaskDiffMode,
  CapyThread,
  CapyThreadListItem,
  CapyThreadTag,
  CapyTriggerAutomationResult,
  CapyUpdateAutomationInput,
  CapyUpdateBrowserSnapshotInput,
  CapyUpdateProjectSetupInput,
  CapyUpdateSnapshotsResult,
  CapyUsage,
  CapyUsageQuery,
  CapyVerifiedSession,
} from './capy-types.js';
import {
  automation as parseAutomation,
  browserSnapshot as parseBrowserSnapshot,
  browserSnapshotDetail as parseBrowserSnapshotDetail,
  items,
  object,
  parsePullRequest,
  parseTag,
  string,
  thread as parseThread,
  threadListItem as parseThreadListItem,
} from './capy-transport.js';
// Re-export everything consumers expect from the capy module surface.
export * from './capy-types.js';
export {
  items,
  object,
  parsePullRequest,
  parseTag,
  parseTask,
  string,
  strings,
} from './capy-transport.js';
export class CapyClient {
  readonly baseURL: string;
  private readonly request: typeof fetch;
  private modelCache?: { values: CapyModel[]; expiresAt: number };
  constructor(readonly options: CapyClientOptions) {
    this.options = options;
    this.baseURL = (options.baseURL ?? CAPY_BASE_URL).replace(/\/$/, '');
    this.request = options.fetch ?? fetch;
  }
  async models(signal?: AbortSignal): Promise<CapyModel[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now())
      return this.modelCache.values.map((model) => ({ ...model }));
    const body = object(await this.json('/models', { signal }));
    const values = (Array.isArray(body.models) ? body.models : []).flatMap((value): CapyModel[] => {
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
    this.modelCache = { values, expiresAt: Date.now() + 30_000 };
    return values;
  }
  async projects(signal?: AbortSignal): Promise<CapyProject[]> {
    return await this.paginate('/projects', signal, (value): CapyProject | undefined => {
      const project = object(value);
      const id = string(project.id);
      if (!id) return undefined;
      return {
        id,
        name: string(project.name, id),
        description: typeof project.description === 'string' ? project.description : null,
        taskCode: string(project.taskCode),
        repos: items(project.repos).flatMap((value) => {
          const repo = object(value);
          const repoFullName = string(repo.repoFullName);
          return repoFullName ? [{ repoFullName, branch: string(repo.branch, 'main') }] : [];
        }),
        createdAt: string(project.createdAt) || undefined,
        updatedAt: string(project.updatedAt) || undefined,
      };
    });
  }
  async createThread(input: CapyCreateThreadInput, signal?: AbortSignal): Promise<CapyThread> {
    return parseThread(
      await this.json('/threads', {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
  }
  async sendMessage(
    threadId: string,
    input: CapySendMessageInput,
    signal?: AbortSignal,
  ): Promise<CapySendMessageResponse> {
    const body = object(
      await this.json(`/threads/${encodeURIComponent(threadId)}/message`, {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
    return {
      id: string(body.id),
      status: string(body.status, 'pending') as CapySendMessageResponse['status'],
      inputEventId: string(body.inputEventId) || undefined,
      timelineSequence: string(body.timelineSequence) || undefined,
      appendState: (string(body.appendState) ||
        undefined) as CapySendMessageResponse['appendState'],
    };
  }
  async stopThread(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/threads/${encodeURIComponent(threadId)}/stop`, {
      method: 'POST',
      signal,
      body: '{}',
    });
  }
  async getThread(threadId: string, signal?: AbortSignal): Promise<CapyThread> {
    return parseThread(await this.json(`/threads/${encodeURIComponent(threadId)}`, { signal }));
  }
  async messages(threadId: string, signal?: AbortSignal): Promise<CapyMessage[]> {
    return await this.paginate(
      `/threads/${encodeURIComponent(threadId)}/messages`,
      signal,
      (value): CapyMessage | undefined => {
        const message = object(value);
        const id = string(message.id);
        const content = string(message.content);
        if (!id) return undefined;
        return {
          id,
          source: string(message.source, 'assistant') as CapyMessage['source'],
          content,
          createdAt: string(message.createdAt),
        };
      },
    );
  }
  /**
   * List threads for a project. Supports filtering by status, branch, PR,
   * tag, origin, author/participant email, and a free-text `q` query.
   * Returns the raw list (pagination handled transparently).
   */
  async listThreads(
    options: CapyListThreadsOptions,
    signal?: AbortSignal,
  ): Promise<CapyThreadListItem[]> {
    const params = new URLSearchParams();
    params.set('projectId', options.projectId);
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.status) params.set('status', options.status);
    if (options.branch) params.set('branch', options.branch);
    if (options.prNumber != null) params.set('prNumber', String(options.prNumber));
    if (options.prState) params.set('prState', options.prState);
    if (options.tag) params.set('tag', options.tag);
    if (options.origin) params.set('origin', options.origin);
    if (options.authorId) params.set('authorId', options.authorId);
    if (options.authorEmail) params.set('authorEmail', options.authorEmail);
    if (options.participantId) params.set('participantId', options.participantId);
    if (options.participantEmail) params.set('participantEmail', options.participantEmail);
    if (options.slackThreadTs) params.set('slackThreadTs', options.slackThreadTs);
    if (options.slackChannelId) params.set('slackChannelId', options.slackChannelId);
    if (options.q) params.set('q', options.q);
    return await this.paginate(`/threads?${params.toString()}`, signal, (value) =>
      parseThreadListItem(value),
    );
  }
  async archiveThread(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/threads/${encodeURIComponent(threadId)}/archive`, {
      method: 'POST',
      signal,
      body: '{}',
    });
  }
  async unarchiveThread(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.json(`/threads/${encodeURIComponent(threadId)}/unarchive`, {
      method: 'POST',
      signal,
      body: '{}',
    });
  }
  async getTask(taskId: string, signal?: AbortSignal): Promise<CapyTaskDetail> {
    const body = object(await this.json(`/tasks/${encodeURIComponent(taskId)}`, { signal }));
    const id = string(body.id);
    if (!id) throw new Error('Capy returned an invalid task response');
    const pr =
      body.pullRequest && typeof body.pullRequest === 'object'
        ? (parsePullRequest(body.pullRequest)[0] ?? null)
        : null;
    return {
      id,
      projectId: string(body.projectId),
      threadIndex: typeof body.threadIndex === 'number' ? body.threadIndex : null,
      identifier: string(body.identifier, id),
      title: string(body.title),
      prompt: string(body.prompt),
      status: string(body.status, 'backlog') as CapyTaskDetail['status'],
      pullRequest: pr,
      slackThreads: items(body.slackThreads).flatMap((value) => {
        const slack = object(value);
        const channelId = string(slack.channelId);
        return channelId
          ? [
              {
                teamId: string(slack.teamId),
                channelId,
                threadTs: string(slack.threadTs),
                url: string(slack.url),
              },
            ]
          : [];
      }),
      threadId: string(body.threadId) || null,
      currentJamId: string(body.currentJamId) || null,
      createdAt: string(body.createdAt),
      updatedAt: string(body.updatedAt),
    };
  }
  /**
   * Fetch the diff produced by a task. `mode` controls the format
   * (`uncommitted` or `pr`); defaults to the server's current workspace diff.
   */
  async getTaskDiff(
    taskId: string,
    mode?: CapyTaskDiffMode,
    signal?: AbortSignal,
  ): Promise<CapyTaskDiff> {
    const path = mode
      ? `/tasks/${encodeURIComponent(taskId)}/diff?mode=${encodeURIComponent(mode)}`
      : `/tasks/${encodeURIComponent(taskId)}/diff`;
    const body = object(await this.json(path, { signal }));
    const stats = object(body.stats);
    return {
      stats: {
        files: typeof stats.files === 'number' ? stats.files : 0,
        additions: typeof stats.additions === 'number' ? stats.additions : 0,
        deletions: typeof stats.deletions === 'number' ? stats.deletions : 0,
      },
      files: items(body.files).map((value) => {
        const file = object(value);
        return {
          path: string(file.path),
          state: string(file.state),
          additions: typeof file.additions === 'number' ? file.additions : 0,
          deletions: typeof file.deletions === 'number' ? file.deletions : 0,
          patch: string(file.patch),
        };
      }),
      source: string(body.source, 'summary') as CapyTaskDiff['source'],
    };
  }
  async listThreadTags(projectId: string, signal?: AbortSignal): Promise<CapyThreadTag[]> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/tags`, { signal }),
    );
    return items(body.items).flatMap((v) => parseTag(v));
  }
  async createThreadTag(
    projectId: string,
    input: { name: string; color: CapyTagColor },
    signal?: AbortSignal,
  ): Promise<CapyThreadTag> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/tags`, {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
    return {
      name: string(body.name),
      color: string(body.color, 'default') as CapyTagColor,
    };
  }
  async setThreadTags(
    threadId: string,
    tags: string[],
    signal?: AbortSignal,
  ): Promise<CapyThreadTag[]> {
    const body = object(
      await this.json(`/threads/${encodeURIComponent(threadId)}/tags`, {
        method: 'PUT',
        signal,
        body: JSON.stringify({ tags }),
      }),
    );
    return items(body.tags).flatMap((v) => parseTag(v));
  }
  async getProject(projectId: string, signal?: AbortSignal): Promise<CapyProject> {
    const body = object(await this.json(`/projects/${encodeURIComponent(projectId)}`, { signal }));
    const id = string(body.id);
    if (!id) throw new Error('Capy returned an invalid project response');
    return {
      id,
      name: string(body.name, id),
      description: typeof body.description === 'string' ? body.description : null,
      taskCode: string(body.taskCode),
      repos: items(body.repos).flatMap((value) => {
        const repo = object(value);
        const repoFullName = string(repo.repoFullName);
        return repoFullName ? [{ repoFullName, branch: string(repo.branch, 'main') }] : [];
      }),
      createdAt: string(body.createdAt) || undefined,
      updatedAt: string(body.updatedAt) || undefined,
    };
  }
  /**
   * Fetch org usage/billing. Requires the org id and a date range.
   * Returns totals (LLM/VM/total dollars) plus pagination metadata.
   */
  async getUsage(input: CapyUsageQuery, signal?: AbortSignal): Promise<CapyUsage> {
    const params = new URLSearchParams();
    params.set('orgId', input.orgId);
    params.set('from', input.from);
    params.set('to', input.to);
    params.set('routed', input.routed ?? 'paid');
    params.set('page', String(input.page ?? 1));
    params.set('pageSize', String(input.pageSize ?? 20));
    if (input.userId) params.set('userId', input.userId);
    if (input.projectIds) params.set('projectIds', input.projectIds);
    if (input.agentType) params.set('agentType', input.agentType);
    if (input.sortBy) params.set('sortBy', input.sortBy);
    if (input.sortDirection) params.set('sortDirection', input.sortDirection);
    const body = object(await this.json(`/usage?${params.toString()}`, { signal }));
    const totals = object(body.totals);
    const dollars = (value: Record<string, unknown>) => ({
      llmDollars: typeof value.llmDollars === 'number' ? value.llmDollars : 0,
      vmDollars: typeof value.vmDollars === 'number' ? value.vmDollars : 0,
      totalDollars: typeof value.totalDollars === 'number' ? value.totalDollars : 0,
    });
    const nullableString = (value: unknown) => (typeof value === 'string' ? value : null);
    return {
      orgId: string(body.orgId),
      from: string(body.from),
      to: string(body.to),
      currency: 'USD',
      routed: string(body.routed, input.routed ?? 'paid') as CapyUsage['routed'],
      totals: {
        llmDollars: typeof totals.llmDollars === 'number' ? totals.llmDollars : 0,
        vmDollars: typeof totals.vmDollars === 'number' ? totals.vmDollars : 0,
        totalDollars: typeof totals.totalDollars === 'number' ? totals.totalDollars : 0,
      },
      users: items(body.users).map((value) => {
        const user = object(value);
        return {
          ...dollars(user),
          userId: string(user.userId),
          userType: string(user.userType, 'human') as 'human' | 'service_user',
          name: nullableString(user.name),
          email: nullableString(user.email),
          imageUrl: nullableString(user.imageUrl),
          isServiceUser: user.isServiceUser === true,
        };
      }),
      items: items(body.items).map((value) => {
        const item = object(value);
        const rawDiff =
          item.diffSummaryByMode && typeof item.diffSummaryByMode === 'object'
            ? object(item.diffSummaryByMode)
            : null;
        const diffSummaryByMode = rawDiff
          ? (Object.fromEntries(
              ['uncommitted', 'pr', 'run'].flatMap((mode) => {
                const raw = rawDiff[mode];
                if (!raw || typeof raw !== 'object') return [];
                const summary = object(raw);
                return [
                  [
                    mode,
                    {
                      additions: typeof summary.additions === 'number' ? summary.additions : 0,
                      deletions: typeof summary.deletions === 'number' ? summary.deletions : 0,
                      hasChanges: summary.hasChanges === true,
                      generatedAt: string(summary.generatedAt),
                      baselineRef: string(summary.baselineRef),
                      ...(typeof summary.fileCount === 'number'
                        ? { fileCount: summary.fileCount }
                        : {}),
                      ...(Array.isArray(summary.changedFiles)
                        ? {
                            changedFiles: summary.changedFiles.filter(
                              (path): path is string => typeof path === 'string',
                            ),
                          }
                        : {}),
                    },
                  ],
                ];
              }),
            ) as CapyUsage['items'][number]['diffSummaryByMode'])
          : null;
        const rawSpend =
          item.routedSpendDollars && typeof item.routedSpendDollars === 'object'
            ? object(item.routedSpendDollars)
            : null;
        const routedSpendDollars = rawSpend
          ? (Object.fromEntries(
              Object.entries(rawSpend).filter(
                (entry): entry is [string, number] => typeof entry[1] === 'number',
              ),
            ) as CapyUsage['items'][number]['routedSpendDollars'])
          : null;
        return {
          ...dollars(item),
          jamId: string(item.jamId),
          jamTitle: nullableString(item.jamTitle),
          jamStatus: nullableString(item.jamStatus),
          jamAgentType: nullableString(item.jamAgentType),
          jamProjectId: nullableString(item.jamProjectId),
          jamCreatedAt: nullableString(item.jamCreatedAt),
          jamUpdatedAt: nullableString(item.jamUpdatedAt),
          userId: string(item.userId),
          userType: string(item.userType, 'human') as 'human' | 'service_user',
          userName: nullableString(item.userName),
          userEmail: nullableString(item.userEmail),
          userImageUrl: nullableString(item.userImageUrl),
          isServiceUser: item.isServiceUser === true,
          taskId: nullableString(item.taskId),
          taskProjectId: nullableString(item.taskProjectId),
          taskNumber: typeof item.taskNumber === 'number' ? item.taskNumber : null,
          taskTitle: nullableString(item.taskTitle),
          lastActivityAt: string(item.lastActivityAt),
          modelCount: typeof item.modelCount === 'number' ? item.modelCount : 0,
          diffSummaryByMode,
          routedSource: string(
            item.routedSource,
            'paid',
          ) as CapyUsage['items'][number]['routedSource'],
          routedSpendDollars,
        };
      }),
      total: typeof body.total === 'number' ? body.total : 0,
      page: typeof body.page === 'number' ? body.page : 0,
      pageSize: typeof body.pageSize === 'number' ? body.pageSize : 0,
      totalPages: typeof body.totalPages === 'number' ? body.totalPages : 0,
    };
  }
  async getProjectSetup(projectId: string, signal?: AbortSignal): Promise<CapyProjectSetup> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/setup`, { signal }),
    );
    return {
      source: string(body.source, 'none') as CapyProjectSetup['source'],
      setup: object(body.setup) as unknown as CapyProjectSetup['setup'],
      legacyHooks: object(body.legacyHooks) as unknown as CapyProjectSetup['legacyHooks'],
    };
  }
  async updateProjectSetup(
    projectId: string,
    input: CapyUpdateProjectSetupInput,
    signal?: AbortSignal,
    replaceLegacyHooks = false,
  ): Promise<CapyProjectSetup> {
    const suffix = replaceLegacyHooks ? '?replaceLegacyHooks=true' : '';
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/setup${suffix}`, {
        method: 'PATCH',
        signal,
        body: JSON.stringify(input),
      }),
    );
    return {
      source: string(body.source, 'none') as CapyProjectSetup['source'],
      setup: object(body.setup) as unknown as CapyProjectSetup['setup'],
      legacyHooks: object(body.legacyHooks) as unknown as CapyProjectSetup['legacyHooks'],
    };
  }
  /**
   * Fetch a short-lived session token for a thread (used for embedding the
   * Capy web view or authenticating a sub-session). The token is a JWT.
   */
  async getSessionToken(threadId: string, signal?: AbortSignal): Promise<CapySessionToken> {
    const body = object(
      await this.json(`/threads/${encodeURIComponent(threadId)}/session-token`, { signal }),
    );
    const token = string(body.token);
    if (!token) throw new Error('Capy returned an invalid session-token response');
    return {
      token,
      expiresAt: string(body.expiresAt),
      issuedAt: string(body.issuedAt),
    };
  }
  async listEnvironmentVariables(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CapyEnvironmentVariable[]> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/environment-variables/personal`, {
        signal,
      }),
    );
    return items(body.items).map((value) => {
      const v = object(value);
      const name = string(v.name);
      return {
        name,
        configured: true,
        updatedAt: string(v.updatedAt),
        lastUpdatedByUserId: string(v.lastUpdatedByUserId) || null,
      };
    });
  }
  async upsertEnvironmentVariables(
    projectId: string,
    variables: Array<{ name: string; value: string }>,
    signal?: AbortSignal,
  ): Promise<CapyEnvironmentVariable[]> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/environment-variables/personal`, {
        method: 'PUT',
        signal,
        body: JSON.stringify({ variables }),
      }),
    );
    return items(body.items).map((value) => {
      const v = object(value);
      return {
        name: string(v.name),
        configured: true,
        updatedAt: string(v.updatedAt),
        lastUpdatedByUserId: string(v.lastUpdatedByUserId) || null,
      };
    });
  }
  async deleteEnvironmentVariable(
    projectId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(
      `/projects/${encodeURIComponent(projectId)}/environment-variables/personal/${encodeURIComponent(name)}`,
      { method: 'DELETE', signal },
    );
  }
  // ── Snapshots setting ───────────────────────────────────────────────────
  async getSnapshotsSetting(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CapySnapshotsSetting> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/snapshots`, { signal }),
    );
    return { enabled: body.enabled === true };
  }
  async updateSnapshotsSetting(
    projectId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<CapyUpdateSnapshotsResult> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/snapshots`, {
        method: 'PATCH',
        signal,
        body: JSON.stringify({ enabled }),
      }),
    );
    return {
      enabled: body.enabled === true,
      initialBuildId: string(body.initialBuildId) || undefined,
      reusedSnapshot:
        body.reusedSnapshot && typeof body.reusedSnapshot === 'object'
          ? {
              snapshotId: string(object(body.reusedSnapshot).snapshotId),
              lane: string(object(body.reusedSnapshot).lane),
            }
          : undefined,
      queuedBehindActiveBuild: body.queuedBehindActiveBuild === true,
    };
  }
  // ── Browser snapshots ───────────────────────────────────────────────────
  async listBrowserSnapshots(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CapyBrowserSnapshot[]> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/browser-snapshots`, { signal }),
    );
    return items(body.items).map((v) => parseBrowserSnapshot(v));
  }
  async createBrowserSnapshot(
    projectId: string,
    input: CapyCreateBrowserSnapshotInput,
    signal?: AbortSignal,
  ): Promise<CapyBrowserSnapshot> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/browser-snapshots`, {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
    return parseBrowserSnapshot(body);
  }
  async getBrowserSnapshot(
    projectId: string,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<CapyBrowserSnapshotDetail> {
    const body = object(
      await this.json(
        `/projects/${encodeURIComponent(projectId)}/browser-snapshots/${encodeURIComponent(snapshotId)}`,
        { signal },
      ),
    );
    return parseBrowserSnapshotDetail(body);
  }
  async updateBrowserSnapshot(
    projectId: string,
    snapshotId: string,
    input: CapyUpdateBrowserSnapshotInput,
    signal?: AbortSignal,
  ): Promise<CapyBrowserSnapshot> {
    const body = object(
      await this.json(
        `/projects/${encodeURIComponent(projectId)}/browser-snapshots/${encodeURIComponent(snapshotId)}`,
        { method: 'PATCH', signal, body: JSON.stringify(input) },
      ),
    );
    return parseBrowserSnapshot(body);
  }
  async deleteBrowserSnapshot(
    projectId: string,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(
      `/projects/${encodeURIComponent(projectId)}/browser-snapshots/${encodeURIComponent(snapshotId)}`,
      { method: 'DELETE', signal },
    );
  }
  // ── Automations ─────────────────────────────────────────────────────────
  async listAutomations(
    projectId: string,
    options: CapyListAutomationsOptions = {},
    signal?: AbortSignal,
  ): Promise<CapyAutomation[]> {
    const params = new URLSearchParams();
    if (options.impersonateUserEmail)
      params.set('impersonateUserEmail', options.impersonateUserEmail);
    params.set('includeDisabled', String(options.includeDisabled ?? false));
    if (options.enabled != null) params.set('enabled', String(options.enabled));
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    return await this.paginate(
      `/projects/${encodeURIComponent(projectId)}/automations?${params.toString()}`,
      signal,
      (value): CapyAutomation => parseAutomation(value),
    );
  }
  async createAutomation(
    projectId: string,
    input: CapyCreateAutomationInput,
    signal?: AbortSignal,
  ): Promise<CapyAutomation> {
    const body = object(
      await this.json(`/projects/${encodeURIComponent(projectId)}/automations`, {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      }),
    );
    return parseAutomation(body);
  }
  async getAutomation(
    projectId: string,
    automationId: string,
    signal?: AbortSignal,
  ): Promise<CapyAutomation> {
    const body = object(
      await this.json(
        `/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}`,
        { signal },
      ),
    );
    return parseAutomation(body);
  }
  async updateAutomation(
    projectId: string,
    automationId: string,
    input: CapyUpdateAutomationInput,
    signal?: AbortSignal,
  ): Promise<CapyAutomation> {
    const body = object(
      await this.json(
        `/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}`,
        { method: 'PATCH', signal, body: JSON.stringify(input) },
      ),
    );
    return parseAutomation(body);
  }
  async deleteAutomation(
    projectId: string,
    automationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(
      `/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}`,
      { method: 'DELETE', signal },
    );
  }
  async triggerAutomation(
    projectId: string,
    automationId: string,
    signal?: AbortSignal,
  ): Promise<CapyTriggerAutomationResult> {
    const body = object(
      await this.json(
        `/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}/trigger`,
        { method: 'POST', signal, body: '{}' },
      ),
    );
    return {
      runId: string(body.runId) || null,
      jamId: string(body.jamId) || null,
      status: string(body.status, 'failed') as CapyTriggerAutomationResult['status'],
    };
  }
  // ── Session verification ────────────────────────────────────────────────
  /**
   * Verify a session token (JWT issued by `getSessionToken`). Returns whether
   * the token is valid and, if so, the identity claims it carries.
   */
  async verifySessionToken(token: string, signal?: AbortSignal): Promise<CapyVerifiedSession> {
    const body = object(
      await this.json('/sessions/verify', {
        method: 'POST',
        signal,
        body: JSON.stringify({ token }),
      }),
    );
    if (body.valid !== true) {
      return {
        valid: false,
        reason: string(body.reason, 'invalid') as 'invalid' | 'expired',
      };
    }
    return {
      valid: true,
      threadId: string(body.threadId),
      projectId: string(body.projectId),
      orgId: string(body.orgId) || null,
      userId: string(body.userId),
      instanceId: string(body.instanceId),
      issuedAt: string(body.issuedAt),
      expiresAt: string(body.expiresAt),
    };
  }
  // ── Transport core (private) ────────────────────────────────────────────
  private async paginate<T>(
    path: string,
    signal: AbortSignal | undefined,
    parse: (value: unknown) => T | undefined,
  ): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const [pathname, rawQuery = ''] = path.split('?', 2);
      const params = new URLSearchParams(rawQuery);
      if (!params.has('limit')) params.set('limit', '100');
      if (cursor) params.set('cursor', cursor);
      const query = `${pathname}?${params.toString()}`;
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
