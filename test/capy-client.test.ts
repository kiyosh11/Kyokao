import { describe, expect, it } from 'vitest';
import { CapyClient, CapyApiError, type CapyCreateThreadInput } from '@kyokao/providers';

function client(routes: Array<{ match: RegExp; body: unknown; status?: number }>): CapyClient {
  const fetchMock = (async (url: URL | string, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if (route.match.test(`${method} ${target}`)) {
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(
      JSON.stringify({ error: { code: 'not_found', message: `no route for ${method} ${target}` } }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  return new CapyClient({ baseURL: 'https://capy.test/api/v1', apiKey: 'token', fetch: fetchMock });
}

describe('CapyClient new endpoints (0.8.0)', () => {
  it('caches model discovery to avoid duplicate startup requests', async () => {
    let requests = 0;
    const capy = new CapyClient({
      baseURL: 'https://capy.test/api/v1',
      apiKey: 'token',
      fetch: (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            models: [
              {
                id: 'captain',
                name: 'Captain',
                provider: 'openai',
                captainEligible: true,
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    expect(await capy.models()).toHaveLength(1);
    expect(await capy.models()).toHaveLength(1);
    expect(requests).toBe(1);
  });

  it('listThreads filters by project and parses tags/tasks/PRs', async () => {
    const capy = client([
      {
        match: /GET .*\/threads\?projectId=project-1/,
        body: {
          items: [
            {
              id: 'jam-1',
              projectId: 'project-1',
              title: 'fix login bug',
              status: 'idle',
              runState: 'ready',
              waitingOn: [],
              blockedOn: [],
              pendingWakeups: 0,
              tasks: [
                {
                  id: 'task-1',
                  threadIndex: 1,
                  identifier: 'AUTH-1',
                  title: 'Fix login',
                  status: 'completed',
                },
              ],
              participants: [
                {
                  userId: 'user-1',
                  userType: 'human',
                  firstParticipatedAt: '2026-01-01T00:00:00Z',
                  lastParticipatedAt: '2026-01-02T00:00:00Z',
                },
              ],
              pullRequests: [
                {
                  number: 42,
                  url: 'https://github.com/owner/repo/pull/42',
                  repoFullName: 'owner/repo',
                  state: 'open',
                  headRef: 'fix/login',
                  baseRef: 'main',
                  draft: false,
                },
              ],
              tags: [{ name: 'bug', color: 'destructive' }],
              slackThreads: [
                {
                  teamId: 'team-1',
                  channelId: 'channel-1',
                  threadTs: '123.456',
                  url: 'https://slack.example/thread',
                },
              ],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-02T00:00:00Z',
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      },
    ]);
    const threads = await capy.listThreads({ projectId: 'project-1' });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: 'jam-1',
      title: 'fix login bug',
      runState: 'ready',
      pendingWakeups: 0,
    });
    expect(threads[0]!.tasks[0]).toMatchObject({ identifier: 'AUTH-1', status: 'completed' });
    expect(threads[0]!.tags).toEqual([{ name: 'bug', color: 'destructive' }]);
    expect(threads[0]!.participants[0]?.userId).toBe('user-1');
    expect(threads[0]!.slackThreads[0]?.channelId).toBe('channel-1');
    expect(threads[0]!.pullRequests[0]).toMatchObject({ number: 42, repoFullName: 'owner/repo' });
  });

  it('listThreads forwards filter params to the query string', async () => {
    let capturedUrl = '';
    const fetchMock = (async (url: URL | string) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const capy = new CapyClient({
      baseURL: 'https://capy.test/api/v1',
      apiKey: 'token',
      fetch: fetchMock,
    });
    await capy.listThreads({
      projectId: 'p1',
      status: 'idle',
      tag: 'bug',
      branch: 'main',
      prNumber: 7,
      q: 'login',
    });
    expect(capturedUrl).toContain('projectId=p1');
    expect(capturedUrl).toContain('status=idle');
    expect(capturedUrl).toContain('tag=bug');
    expect(capturedUrl).toContain('branch=main');
    expect(capturedUrl).toContain('prNumber=7');
    expect(capturedUrl).toContain('q=login');
  });

  it('archiveThread and unarchiveThread POST the lifecycle endpoints', async () => {
    const calls: string[] = [];
    const capy = new CapyClient({
      baseURL: 'https://capy.test/api/v1',
      apiKey: 'token',
      fetch: (async (url: URL | string, init?: RequestInit) => {
        const target = typeof url === 'string' ? url : url.toString();
        calls.push(`${init?.method ?? 'GET'} ${target}`);
        return new Response(JSON.stringify({ id: 'jam-1', status: 'archived' }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await capy.archiveThread('jam-1');
    await capy.unarchiveThread('jam-1');
    expect(calls).toEqual([
      'POST https://capy.test/api/v1/threads/jam-1/archive',
      'POST https://capy.test/api/v1/threads/jam-1/unarchive',
    ]);
  });

  it('getTask parses the full task record including the linked pull request', async () => {
    const capy = client([
      {
        match: /GET .*\/tasks\/task-9$/,
        body: {
          id: 'task-9',
          projectId: 'project-1',
          identifier: 'AUTH-9',
          title: 'Rotate tokens',
          prompt: 'rotate all the api tokens',
          status: 'in_progress',
          pullRequest: {
            number: 99,
            url: 'https://github.com/owner/repo/pull/99',
            repoFullName: 'owner/repo',
            state: 'open',
          },
          threadId: 'jam-9',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      },
    ]);
    const task = await capy.getTask('task-9');
    expect(task.identifier).toBe('AUTH-9');
    expect(task.prompt).toContain('rotate');
    expect(task.pullRequest?.number).toBe(99);
    expect(task.threadId).toBe('jam-9');
  });

  it('getTaskDiff parses stats, files, and patch', async () => {
    const capy = client([
      {
        match: /GET .*\/tasks\/task-1\/diff/,
        body: {
          stats: { files: 2, additions: 10, deletions: 3 },
          files: [
            {
              path: 'src/a.ts',
              state: 'modified',
              additions: 8,
              deletions: 1,
              patch: '@@ -1 +1,8 @@',
            },
            {
              path: 'src/b.ts',
              state: 'modified',
              additions: 2,
              deletions: 2,
              patch: '@@ -3 +3 @@',
            },
          ],
          source: 'summary',
        },
      },
    ]);
    const diff = await capy.getTaskDiff('task-1');
    expect(diff.stats).toEqual({ files: 2, additions: 10, deletions: 3 });
    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({ path: 'src/a.ts', patch: '@@ -1 +1,8 @@' });

    await capy.getTaskDiff('task-1', 'pr');
  });

  it('thread tags: list, create, set', async () => {
    const capy = client([
      {
        match: /GET .*\/projects\/p1\/tags$/,
        body: {
          items: [
            { name: 'bug', color: 'destructive' },
            { name: 'feature', color: 'success' },
          ],
        },
      },
      { match: /POST .*\/projects\/p1\/tags$/, body: { name: 'urgent', color: 'warning' } },
      {
        match: /PUT .*\/threads\/jam-1\/tags$/,
        body: { tags: [{ name: 'urgent', color: 'warning' }] },
      },
    ]);
    const tags = await capy.listThreadTags('p1');
    expect(tags.map((t) => t.name)).toEqual(['bug', 'feature']);
    const created = await capy.createThreadTag('p1', { name: 'urgent', color: 'warning' });
    expect(created).toEqual({ name: 'urgent', color: 'warning' });
    const set = await capy.setThreadTags('jam-1', ['urgent']);
    expect(set).toEqual([{ name: 'urgent', color: 'warning' }]);
  });

  it('getProject parses a single project', async () => {
    const capy = client([
      {
        match: /GET .*\/projects\/project-1$/,
        body: {
          id: 'project-1',
          name: 'Main',
          description: 'the main project',
          taskCode: 'MAIN',
          repos: [{ repoFullName: 'owner/repo', branch: 'main' }],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      },
    ]);
    const project = await capy.getProject('project-1');
    expect(project).toMatchObject({ id: 'project-1', name: 'Main', taskCode: 'MAIN' });
    expect(project.repos[0]).toMatchObject({ repoFullName: 'owner/repo', branch: 'main' });
  });

  it('getUsage parses totals and pagination', async () => {
    const capy = client([
      {
        match: /GET .*\/usage\?/,
        body: {
          orgId: 'org-1',
          from: '2026-01-01',
          to: '2026-01-31',
          currency: 'USD',
          routed: 'paid',
          totals: { llmDollars: 12.34, vmDollars: 1.5, totalDollars: 13.84 },
          users: [
            {
              llmDollars: 12.34,
              vmDollars: 1.5,
              totalDollars: 13.84,
              userId: 'user-1',
              userType: 'human',
              name: 'Ada',
              email: 'ada@example.com',
              imageUrl: null,
              isServiceUser: false,
            },
          ],
          items: [
            {
              llmDollars: 12.34,
              vmDollars: 1.5,
              totalDollars: 13.84,
              jamId: 'jam-1',
              jamTitle: 'Fix login',
              jamStatus: 'ready',
              jamAgentType: 'captain',
              jamProjectId: 'p1',
              jamCreatedAt: '2026-01-01T00:00:00Z',
              jamUpdatedAt: '2026-01-02T00:00:00Z',
              userId: 'user-1',
              userType: 'human',
              userName: 'Ada',
              userEmail: 'ada@example.com',
              userImageUrl: null,
              isServiceUser: false,
              taskId: 'task-1',
              taskProjectId: 'p1',
              taskNumber: 1,
              taskTitle: 'Fix login',
              lastActivityAt: '2026-01-02T00:00:00Z',
              modelCount: 1,
              diffSummaryByMode: null,
              routedSource: 'paid',
              routedSpendDollars: { paid: 13.84 },
            },
          ],
          total: 100,
          page: 1,
          pageSize: 50,
          totalPages: 2,
        },
      },
    ]);
    const usage = await capy.getUsage({ orgId: 'org-1', from: '2026-01-01', to: '2026-01-31' });
    expect(usage.totals.totalDollars).toBe(13.84);
    expect(usage.totals.llmDollars).toBe(12.34);
    expect(usage.totalPages).toBe(2);
    expect(usage.users[0]?.name).toBe('Ada');
    expect(usage.items[0]?.routedSpendDollars?.paid).toBe(13.84);
  });

  it('getProjectSetup and updateProjectSetup round-trip', async () => {
    const capy = client([
      {
        match: /GET .*\/projects\/p1\/setup$/,
        body: {
          source: 'setup',
          legacyHooks: { status: 'none', repositories: [], checkComplete: true },
          setup: {
            vmSize: 'small',
            repositories: [
              {
                repository: 'o/r',
                branch: 'main',
                scripts: { initialize: null, updateAfterCheckout: null, startup: null },
                commands: [],
              },
            ],
          },
        },
      },
      {
        match: /PATCH .*\/projects\/p1\/setup/,
        body: {
          source: 'setup',
          legacyHooks: { status: 'none', repositories: [], checkComplete: true },
          setup: {
            vmSize: 'medium',
            repositories: [
              {
                repository: 'o/r',
                branch: 'main',
                scripts: { initialize: null, updateAfterCheckout: null, startup: null },
                commands: [],
              },
            ],
          },
        },
      },
    ]);
    const setup = await capy.getProjectSetup('p1');
    expect(setup.setup.vmSize).toBe('small');
    const updated = await capy.updateProjectSetup('p1', {
      vmSize: 'medium',
      repositories: [
        {
          repository: 'o/r',
          branch: 'main',
          scripts: { initialize: null, updateAfterCheckout: null, startup: null },
          commands: [],
        },
      ],
    });
    expect(updated.setup.vmSize).toBe('medium');
  });

  it('getSessionToken returns the JWT and expiry', async () => {
    const capy = client([
      {
        match: /GET .*\/threads\/jam-1\/session-token$/,
        body: {
          token: 'eyJhbGciOi.eyJzdWIi.fakesig',
          expiresAt: '2026-12-31T23:59:59Z',
          issuedAt: '2026-01-01T00:00:00Z',
        },
      },
    ]);
    const token = await capy.getSessionToken('jam-1');
    expect(token.token.startsWith('eyJ')).toBe(true);
    expect(token.expiresAt).toBe('2026-12-31T23:59:59Z');
  });

  it('environment variables: list, upsert, delete', async () => {
    const calls: string[] = [];
    const capy = new CapyClient({
      baseURL: 'https://capy.test/api/v1',
      apiKey: 'token',
      fetch: (async (url: URL | string, init?: RequestInit) => {
        const target = typeof url === 'string' ? url : url.toString();
        calls.push(`${init?.method ?? 'GET'} ${target}`);
        if (target.includes('/environment-variables/personal') && (init?.method ?? 'GET') === 'GET')
          return new Response(
            JSON.stringify({
              items: [
                {
                  name: 'DATABASE_URL',
                  configured: true,
                  updatedAt: '2026-01-01T00:00:00Z',
                  lastUpdatedByUserId: 'u1',
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        if (target.includes('/environment-variables/personal') && init?.method === 'PUT')
          return new Response(
            JSON.stringify({
              items: [
                {
                  name: 'DATABASE_URL',
                  configured: true,
                  updatedAt: '2026-01-02T00:00:00Z',
                  lastUpdatedByUserId: 'u1',
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const list = await capy.listEnvironmentVariables('p1');
    expect(list).toEqual([
      {
        name: 'DATABASE_URL',
        configured: true,
        updatedAt: '2026-01-01T00:00:00Z',
        lastUpdatedByUserId: 'u1',
      },
    ]);
    const upserted = await capy.upsertEnvironmentVariables('p1', [
      { name: 'DATABASE_URL', value: 'new-value' },
    ]);
    expect(upserted[0]).toMatchObject({ name: 'DATABASE_URL', configured: true });
    expect(JSON.stringify(upserted)).not.toContain('new-value');
    await capy.deleteEnvironmentVariable('p1', 'DATABASE_URL');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true);
  });

  it('createThread forwards the enriched body (speed, tags, repos)', async () => {
    let captured: { url: string; method: string; body: string } | undefined;
    const capy = new CapyClient({
      baseURL: 'https://capy.test/api/v1',
      apiKey: 'token',
      fetch: (async (url: URL | string, init?: RequestInit) => {
        captured = {
          url: typeof url === 'string' ? url : url.toString(),
          method: init?.method ?? 'GET',
          body: init?.body as string,
        };
        return new Response(
          JSON.stringify({
            id: 'jam-new',
            projectId: 'p1',
            title: 'new thread',
            status: 'running',
            runState: 'running',
            waitingOn: [],
            blockedOn: [],
            pendingWakeups: 0,
            participants: [],
            tags: [],
            createdAt: '2026-01-01T00:00:00Z',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const input: CapyCreateThreadInput = {
      projectId: 'p1',
      prompt: 'fix the bug',
      model: 'gpt-5.6-sol',
      speed: 'fast',
      tags: ['urgent'],
      repos: [{ repoFullName: 'owner/repo', branch: 'main' }],
      attachmentUrls: ['https://example.com/img.png'],
    };
    const thread = await capy.createThread(input);
    expect(thread.id).toBe('jam-new');
    expect(captured!.method).toBe('POST');
    const body = JSON.parse(captured!.body);
    expect(body).toMatchObject({
      projectId: 'p1',
      prompt: 'fix the bug',
      model: 'gpt-5.6-sol',
      speed: 'fast',
      tags: ['urgent'],
      repos: [{ repoFullName: 'owner/repo', branch: 'main' }],
      attachmentUrls: ['https://example.com/img.png'],
    });
  });

  it('redacts the API key from error messages', async () => {
    const capy = new CapyClient({
      baseURL: 'https://capy.test/api/v1',
      apiKey: 'secret-capy-abc123',
      fetch: (async () =>
        new Response(
          JSON.stringify({ error: { code: 'bad', message: 'token secret-capy-abc123 rejected' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    await expect(capy.getTask('t1')).rejects.toThrow(CapyApiError);

    try {
      await capy.getTask('t1');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-capy-abc123');
      expect((error as Error).message).toContain('[REDACTED]');
    }
  });

  it('snapshots setting get/update round-trip', async () => {
    const capy = client([
      { match: /GET .*\/projects\/p1\/snapshots$/, body: { enabled: true } },
      {
        match: /PATCH .*\/projects\/p1\/snapshots/,
        body: { enabled: false, queuedBehindActiveBuild: true },
      },
    ]);
    const setting = await capy.getSnapshotsSetting('p1');
    expect(setting.enabled).toBe(true);
    const updated = await capy.updateSnapshotsSetting('p1', false);
    expect(updated.enabled).toBe(false);
    expect(updated.queuedBehindActiveBuild).toBe(true);
  });

  it('browser snapshots CRUD', async () => {
    const capy = client([
      {
        match: /GET .*\/projects\/p1\/browser-snapshots$/,
        body: {
          items: [
            {
              id: 'snap-1',
              projectId: 'p1',
              name: 'login state',
              domains: ['app.example.com'],
              isPrivate: false,
              isDefault: true,
            },
          ],
        },
      },
      {
        match: /POST .*\/projects\/p1\/browser-snapshots$/,
        body: {
          id: 'snap-2',
          projectId: 'p1',
          name: 'new',
          domains: [],
          isPrivate: true,
          isDefault: false,
        },
      },
      {
        match: /GET .*\/browser-snapshots\/snap-1$/,
        body: {
          id: 'snap-1',
          projectId: 'p1',
          name: 'login state',
          domains: [],
          isPrivate: false,
          isDefault: true,
          storageState: { cookies: [], origins: [] },
        },
      },
      {
        match: /PATCH .*\/browser-snapshots\/snap-1/,
        body: {
          id: 'snap-1',
          projectId: 'p1',
          name: 'renamed',
          domains: [],
          isPrivate: true,
          isDefault: false,
        },
      },
      { match: /DELETE .*\/browser-snapshots\/snap-1/, body: { success: true } },
    ]);
    const list = await capy.listBrowserSnapshots('p1');
    expect(list[0]).toMatchObject({ id: 'snap-1', isDefault: true });
    const created = await capy.createBrowserSnapshot('p1', {
      name: 'new',
      storageState: { cookies: [], origins: [] },
    });
    expect(created.id).toBe('snap-2');
    const got = await capy.getBrowserSnapshot('p1', 'snap-1');
    expect(got.name).toBe('login state');
    const updated = await capy.updateBrowserSnapshot('p1', 'snap-1', {
      name: 'renamed',
      isPrivate: true,
    });
    expect(updated.name).toBe('renamed');
    await expect(capy.deleteBrowserSnapshot('p1', 'snap-1')).resolves.toBeUndefined();
  });

  it('automations CRUD + trigger', async () => {
    const capy = client([
      {
        match: /GET .*\/projects\/p1\/automations\?/,
        body: {
          items: [
            {
              id: 'auto-1',
              projectId: 'p1',
              name: 'nightly',
              enabled: true,
              triggerType: 'schedule',
              prompt: 'run tests',
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      },
      {
        match: /POST .*\/projects\/p1\/automations$/,
        body: {
          id: 'auto-2',
          projectId: 'p1',
          name: 'deploy',
          enabled: false,
          triggerType: 'webhook',
          prompt: 'deploy',
        },
      },
      {
        match: /GET .*\/automations\/auto-1$/,
        body: {
          id: 'auto-1',
          projectId: 'p1',
          name: 'nightly',
          enabled: true,
          triggerType: 'schedule',
          prompt: 'run tests',
        },
      },
      {
        match: /PATCH .*\/automations\/auto-1/,
        body: {
          id: 'auto-1',
          projectId: 'p1',
          name: 'nightly-v2',
          enabled: false,
          triggerType: 'schedule',
          prompt: 'run tests',
        },
      },
      { match: /DELETE .*\/automations\/auto-1/, body: { success: true } },
      {
        match: /POST .*\/automations\/auto-1\/trigger/,
        body: { runId: 'r1', jamId: 'jam-1', status: 'running' },
      },
    ]);
    const list = await capy.listAutomations('p1');
    expect(list[0]).toMatchObject({ id: 'auto-1', triggerType: 'schedule' });
    const created = await capy.createAutomation('p1', { name: 'deploy', prompt: 'deploy' });
    expect(created.id).toBe('auto-2');
    const got = await capy.getAutomation('p1', 'auto-1');
    expect(got.name).toBe('nightly');
    const updated = await capy.updateAutomation('p1', 'auto-1', {
      name: 'nightly-v2',
      enabled: false,
    });
    expect(updated.name).toBe('nightly-v2');
    expect(updated.enabled).toBe(false);
    await expect(capy.deleteAutomation('p1', 'auto-1')).resolves.toBeUndefined();
    const triggered = await capy.triggerAutomation('p1', 'auto-1');
    expect(triggered).toMatchObject({ status: 'running', jamId: 'jam-1' });
  });

  it('verifySessionToken reports validity and identity', async () => {
    const capy = client([
      {
        match: /POST .*\/sessions\/verify/,
        body: {
          valid: true,
          threadId: 'jam-1',
          projectId: 'p1',
          userId: 'u1',
          orgId: 'org-1',
          instanceId: 'vm-1',
          issuedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-01T01:00:00Z',
        },
      },
    ]);
    const result = await capy.verifySessionToken('eyJ.fake.jwt');
    expect(result).toMatchObject({
      valid: true,
      threadId: 'jam-1',
      projectId: 'p1',
      orgId: 'org-1',
      instanceId: 'vm-1',
    });
  });
});
