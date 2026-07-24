import type {
  CapyAutomation,
  CapyBlockedOn,
  CapyBrowserSnapshot,
  CapyBrowserSnapshotDetail,
  CapyPullRequest,
  CapyRunState,
  CapySlackThread,
  CapyTask,
  CapyTaskStatus,
  CapyThread,
  CapyThreadListItem,
  CapyThreadParticipant,
  CapyThreadStatus,
  CapyThreadTag,
  CapyWaitingOn,
} from './capy-types.js';

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const body = object(value);
  return Array.isArray(body.items) ? body.items : [];
}

const THREAD_STATUSES = new Set<CapyThreadStatus>(['active', 'idle', 'archived']);
const RUN_STATES = new Set<CapyRunState>([
  'running',
  'stopping',
  'queued',
  'waiting',
  'blocked',
  'ready',
  'archived',
]);
const TASK_STATUSES = new Set<CapyTaskStatus>([
  'backlog',
  'queued',
  'in_progress',
  'needs_review',
  'completed',
  'error',
  'archived',
]);
const WAITING_REASONS = new Set<CapyWaitingOn>(['task', 'review', 'ci', 'timer', 'worker']);
const BLOCKING_REASONS = new Set<CapyBlockedOn>(['auth', 'permission']);

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, fallback: T): T {
  return typeof value === 'string' && values.has(value as T) ? (value as T) : fallback;
}

function enumValues<T extends string>(value: unknown, values: ReadonlySet<T>): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => typeof item === 'string' && values.has(item as T))
    : [];
}

export function parseTask(value: unknown): CapyTask[] {
  const task = object(value);
  const id = string(task.id);
  return id
    ? [
        {
          id,
          threadIndex: typeof task.threadIndex === 'number' ? task.threadIndex : null,
          identifier: string(task.identifier, id),
          title: string(task.title),
          status: enumValue(task.status, TASK_STATUSES, 'backlog'),
        },
      ]
    : [];
}

export function parsePullRequest(value: unknown): CapyPullRequest[] {
  const pull = object(value);
  const url = string(pull.url);
  return url
    ? [
        {
          number: typeof pull.number === 'number' ? pull.number : 0,
          url,
          repoFullName: string(pull.repoFullName),
          state: string(pull.state),
          headRef: string(pull.headRef),
          baseRef: string(pull.baseRef),
          draft: pull.draft === true,
        },
      ]
    : [];
}

export function parseTag(value: unknown): CapyThreadTag[] {
  const tag = object(value);
  const name = string(tag.name);
  const color = string(tag.color, 'default') as CapyThreadTag['color'];
  return name ? [{ name, color }] : [];
}

function parseParticipant(value: unknown): CapyThreadParticipant[] {
  const participant = object(value);
  const userId = string(participant.userId);
  return userId
    ? [
        {
          userId,
          userType: string(participant.userType, 'human') as CapyThreadParticipant['userType'],
          firstParticipatedAt: string(participant.firstParticipatedAt),
          lastParticipatedAt: string(participant.lastParticipatedAt),
        },
      ]
    : [];
}

function parseSlackThread(value: unknown): CapySlackThread[] {
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
}

export function threadListItem(value: unknown): CapyThreadListItem | undefined {
  const body = object(value);
  const id = string(body.id);
  const projectId = string(body.projectId);
  if (!id || !projectId) return undefined;
  return {
    id,
    projectId,
    title: typeof body.title === 'string' ? body.title : null,
    status: enumValue(body.status, THREAD_STATUSES, 'idle'),
    runState: enumValue(body.runState, RUN_STATES, 'ready'),
    waitingOn: enumValues(body.waitingOn, WAITING_REASONS),
    blockedOn: enumValues(body.blockedOn, BLOCKING_REASONS),
    pendingWakeups: typeof body.pendingWakeups === 'number' ? body.pendingWakeups : 0,
    tasks: items(body.tasks).flatMap((v) => parseTask(v)),
    participants: items(body.participants).flatMap((v) => parseParticipant(v)),
    pullRequests: items(body.pullRequests).flatMap((v) => parsePullRequest(v)),
    slackThreads: items(body.slackThreads).flatMap((v) => parseSlackThread(v)),
    tags: items(body.tags).flatMap((v) => parseTag(v)),
    createdAt: string(body.createdAt),
    updatedAt: string(body.updatedAt),
  };
}

export function thread(value: unknown): CapyThread {
  const body = object(value);
  const id = string(body.id);
  const projectId = string(body.projectId);
  if (!id || !projectId) throw new Error('Capy returned an invalid thread response');
  return {
    id,
    projectId,
    title: typeof body.title === 'string' ? body.title : null,
    status: enumValue(body.status, THREAD_STATUSES, 'idle'),
    runState: enumValue(body.runState, RUN_STATES, 'ready'),
    waitingOn: enumValues(body.waitingOn, WAITING_REASONS),
    blockedOn: enumValues(body.blockedOn, BLOCKING_REASONS),
    pendingWakeups: typeof body.pendingWakeups === 'number' ? body.pendingWakeups : 0,
    tasks: items(body.tasks).flatMap((v) => parseTask(v)),
    participants: items(body.participants).flatMap((v) => parseParticipant(v)),
    pullRequests: items(body.pullRequests).flatMap((v) => parsePullRequest(v)),
    slackThreads: items(body.slackThreads).flatMap((v) => parseSlackThread(v)),
    slack: parseSlackThread(body.slack)[0] ?? null,
    tags: items(body.tags).flatMap((v) => parseTag(v)),
    createdAt: string(body.createdAt),
    updatedAt: string(body.updatedAt) || undefined,
  };
}

export function browserSnapshot(value: unknown): CapyBrowserSnapshot {
  const body = object(value);
  return {
    id: string(body.id),
    projectId: string(body.projectId),
    name: string(body.name),
    domains: Array.isArray(body.domains)
      ? body.domains.filter((domain): domain is string => typeof domain === 'string')
      : null,
    isPrivate: body.isPrivate === true,
    isDefault: body.isDefault === true,
    createdAt: string(body.createdAt),
    updatedAt: string(body.updatedAt),
  };
}

export function browserSnapshotDetail(value: unknown): CapyBrowserSnapshotDetail {
  const snapshot = browserSnapshot(value);
  const body = object(value);
  const storage = object(body.storageState);
  return {
    ...snapshot,
    storageState:
      body.storageState && typeof body.storageState === 'object'
        ? {
            cookies: items(storage.cookies).map((value) => {
              const cookie = object(value);
              return {
                name: string(cookie.name),
                value: string(cookie.value),
                domain: string(cookie.domain),
                path: string(cookie.path),
                expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
                httpOnly: cookie.httpOnly === true,
                secure: cookie.secure === true,
                sameSite: string(cookie.sameSite, 'Lax') as 'Strict' | 'Lax' | 'None',
              };
            }),
            origins: items(storage.origins).map((value) => {
              const origin = object(value);
              return {
                origin: string(origin.origin),
                localStorage: items(origin.localStorage).map((item) => {
                  const entry = object(item);
                  return { name: string(entry.name), value: string(entry.value) };
                }),
              };
            }),
          }
        : null,
  };
}

export function automation(value: unknown): CapyAutomation {
  const body = object(value);
  return {
    id: string(body.id),
    projectId: string(body.projectId),
    name: string(body.name),
    description: typeof body.description === 'string' ? body.description : null,
    enabled: body.enabled === true,
    triggerType: string(body.triggerType, 'on_demand') as CapyAutomation['triggerType'],
    webhookConfig:
      body.webhookConfig && typeof body.webhookConfig === 'object'
        ? object(body.webhookConfig)
        : null,
    integrationTriggerConfig: body.integrationTriggerConfig ?? null,
    cron: typeof body.cron === 'string' ? body.cron : null,
    timezone: string(body.timezone, 'UTC'),
    prompt: string(body.prompt),
    model: typeof body.model === 'string' ? body.model : null,
    buildModel: typeof body.buildModel === 'string' ? body.buildModel : null,
    baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : null,
    repoBranches:
      body.repoBranches && typeof body.repoBranches === 'object'
        ? (object(body.repoBranches) as Record<string, string>)
        : null,
    createdByUserId: string(body.createdByUserId),
    agentType: string(body.agentType, 'captain') as CapyAutomation['agentType'],
    visibilityScope: string(body.visibilityScope, 'project') as CapyAutomation['visibilityScope'],
    webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : null,
    hasWebhookSecret: body.hasWebhookSecret === true,
    runCount: typeof body.runCount === 'number' ? body.runCount : 0,
    lastTriggeredAt: typeof body.lastTriggeredAt === 'string' ? body.lastTriggeredAt : null,
    createdAt: string(body.createdAt),
    updatedAt: string(body.updatedAt),
    mcpOverrides:
      body.mcpOverrides && typeof body.mcpOverrides === 'object' ? object(body.mcpOverrides) : null,
    triggers: items(body.triggers).map((trigger) => object(trigger)),
  };
}
