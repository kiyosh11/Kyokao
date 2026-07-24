export const CAPY_BASE_URL = 'https://capy.ai/api/v1';

export interface CapyClientOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

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
  description: string | null;
  taskCode: string;
  repos: CapyRepository[];
  createdAt?: string;
  updatedAt?: string;
}

export type CapyThreadStatus = 'active' | 'idle' | 'archived';
export type CapyRunState =
  'running' | 'stopping' | 'queued' | 'waiting' | 'blocked' | 'ready' | 'archived';
export type CapyWaitingOn = 'task' | 'review' | 'ci' | 'timer' | 'worker';
export type CapyBlockedOn = 'auth' | 'permission';
export type CapyTaskStatus =
  'backlog' | 'queued' | 'in_progress' | 'needs_review' | 'completed' | 'error' | 'archived';

export interface CapyTask {
  id: string;
  threadIndex?: number | null;
  identifier: string;
  title: string;
  status: CapyTaskStatus;
}

export interface CapyPullRequest {
  number: number;
  url: string;
  repoFullName: string;
  state: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
}

export interface CapyThreadParticipant {
  userId: string;
  userType: 'human' | 'service_user';
  firstParticipatedAt: string;
  lastParticipatedAt: string;
}

export interface CapySlackThread {
  teamId: string;
  channelId: string;
  threadTs: string;
  url: string;
}

export interface CapyThread {
  id: string;
  projectId: string;
  title: string | null;
  status: CapyThreadStatus;
  runState: CapyRunState;
  waitingOn: CapyWaitingOn[];
  blockedOn: CapyBlockedOn[];
  pendingWakeups?: number;
  tasks: CapyTask[];
  participants: CapyThreadParticipant[];
  pullRequests: CapyPullRequest[];
  slackThreads: CapySlackThread[];
  /** Present on create responses when the thread was started from Slack. */
  slack?: CapySlackThread | null;
  tags?: CapyThreadTag[];
  createdAt: string;
  updatedAt?: string;
}

export interface CapyMessage {
  id: string;
  source: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface CapyThreadListItem extends CapyThread {
  status: CapyThreadStatus;
  pendingWakeups: number;
  tags: CapyThreadTag[];
  createdAt: string;
  updatedAt: string;
}

export interface CapyTaskDetail {
  id: string;
  projectId: string;
  threadIndex: number | null;
  identifier: string;
  title: string;
  prompt: string;
  status: CapyTaskStatus;
  pullRequest: CapyPullRequest | null;
  slackThreads: CapySlackThread[];
  threadId: string | null;
  currentJamId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CapyTaskDiffMode = 'uncommitted' | 'pr';
export type CapyTaskDiffSource = 'snapshot' | 'github' | 'summary';

export interface CapyTaskDiff {
  stats: { files: number; additions: number; deletions: number };
  files: Array<{
    path: string;
    state: string;
    additions: number;
    deletions: number;
    patch: string;
  }>;
  source: CapyTaskDiffSource;
}

export type CapyTagColor =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'orange'
  | 'lime';

export interface CapyThreadTag {
  name: string;
  color: CapyTagColor;
}

export interface CapyUsageTotals {
  llmDollars: number;
  vmDollars: number;
  totalDollars: number;
}

export type CapyUsageRoute =
  | 'paid'
  | 'no_cost'
  | 'oss'
  | 'external_copilot'
  | 'external_codex'
  | 'external_byok'
  | 'external_azure'
  | 'external_unknown'
  | 'external_xai'
  | 'all';

export interface CapyUsageUser extends CapyUsageTotals {
  userId: string;
  userType: 'human' | 'service_user';
  name: string | null;
  email: string | null;
  imageUrl: string | null;
  isServiceUser: boolean;
}

export interface CapyUsageDiffSummary {
  additions: number;
  deletions: number;
  hasChanges: boolean;
  generatedAt: string;
  baselineRef: string;
  fileCount?: number;
  changedFiles?: string[];
}

export interface CapyUsageItem extends CapyUsageTotals {
  jamId: string;
  jamTitle: string | null;
  jamStatus: string | null;
  jamAgentType: string | null;
  jamProjectId: string | null;
  jamCreatedAt: string | null;
  jamUpdatedAt: string | null;
  userId: string;
  userType: 'human' | 'service_user';
  userName: string | null;
  userEmail: string | null;
  userImageUrl: string | null;
  isServiceUser: boolean;
  taskId: string | null;
  taskProjectId: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  lastActivityAt: string;
  modelCount: number;
  diffSummaryByMode: Partial<Record<'uncommitted' | 'pr' | 'run', CapyUsageDiffSummary>> | null;
  routedSource: Exclude<CapyUsageRoute, 'all'>;
  routedSpendDollars: Partial<Record<Exclude<CapyUsageRoute, 'all'>, number>> | null;
}

export interface CapyUsage {
  orgId: string;
  from: string;
  to: string;
  currency: 'USD';
  routed: CapyUsageRoute;
  totals: CapyUsageTotals;
  users: CapyUsageUser[];
  items: CapyUsageItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CapyUsageQuery {
  orgId: string;
  from: string;
  to: string;
  routed?: CapyUsageRoute;
  userId?: string;
  projectIds?: string;
  agentType?: 'build' | 'captain' | 'review';
  sortBy?: 'lastActivity' | 'cost' | 'name' | 'diff' | 'owner';
  sortDirection?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export type CapyVmSize = 'small' | 'medium' | 'large' | 'ultra' | 'hyper';

export interface CapySetupRepository {
  repository: string;
  branch: string;
  scripts: {
    initialize: string | null;
    updateAfterCheckout: string | null;
    startup: string | null;
  };
  timeouts?: {
    initialize?: number;
    updateAfterCheckout?: number;
    startup?: number;
  };
  commands: Array<{ name: string; command: string }>;
}

export interface CapySetupHook {
  commands: string[];
  agents?: Array<'captain' | 'build' | 'review'>;
}

export interface CapySetupHooks {
  pre?: Record<string, string[] | CapySetupHook>;
  post?: Record<string, string[] | CapySetupHook>;
  context?: {
    maxOutputLength?: number;
    truncateStrategy?: 'head' | 'tail' | 'middle';
  };
}

export interface CapySetup {
  vmSize?: CapyVmSize;
  repositories: CapySetupRepository[];
  hooks?: CapySetupHooks;
}

export interface CapyProjectSetup {
  source: 'legacy' | 'setup' | 'none';
  setup: CapySetup;
  legacyHooks: {
    status: 'active' | 'ignored' | 'none';
    repositories: string[];
    checkComplete: boolean;
  };
}

export type CapyUpdateProjectSetupInput = CapySetup;

export interface CapySessionToken {
  token: string;
  expiresAt: string;
  issuedAt: string;
}

/**
 * Capy deliberately returns metadata only. Secret values are write-only and
 * must never be represented as readable API data.
 */
export interface CapyEnvironmentVariable {
  name: string;
  configured: true;
  updatedAt: string;
  lastUpdatedByUserId: string | null;
}

export interface CapySnapshotsSetting {
  enabled: boolean;
}

export interface CapyUpdateSnapshotsResult extends CapySnapshotsSetting {
  initialBuildId?: string;
  reusedSnapshot?: { snapshotId: string; lane: string };
  queuedBehindActiveBuild?: boolean;
}

export interface CapyBrowserSnapshotStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface CapyBrowserSnapshot {
  id: string;
  projectId: string;
  name: string;
  domains: string[] | null;
  isPrivate: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CapyBrowserSnapshotDetail extends CapyBrowserSnapshot {
  storageState: CapyBrowserSnapshotStorageState | null;
}

export interface CapyCreateBrowserSnapshotInput {
  name: string;
  storageState: CapyBrowserSnapshotStorageState;
  isPrivate?: boolean;
  isDefault?: boolean;
}

export interface CapyUpdateBrowserSnapshotInput {
  name?: string;
  isPrivate?: boolean;
  isDefault?: boolean;
}

export type CapyAutomationTriggerType =
  'schedule' | 'webhook' | 'incoming_webhook' | 'on_demand' | 'integration';

export interface CapyMcpOverrides {
  enabledServerKeys?: string[];
  disabledServerKeys?: string[];
}

export interface CapyAutomation {
  id: string;
  projectId: string;
  createdByUserId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: CapyAutomationTriggerType;
  webhookConfig: Record<string, unknown> | null;
  integrationTriggerConfig: unknown | null;
  cron: string | null;
  timezone: string;
  prompt: string;
  model: string | null;
  buildModel: string | null;
  baseBranch: string | null;
  repoBranches: Record<string, string> | null;
  agentType: 'build' | 'captain';
  visibilityScope: 'project' | 'creator';
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  runCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  mcpOverrides: CapyMcpOverrides | null;
  triggers: Array<Record<string, unknown>>;
}

export interface CapyCreateAutomationInput {
  name: string;
  prompt: string;
  description?: string | null;
  enabled?: boolean;
  triggerType?: Exclude<CapyAutomationTriggerType, 'integration'>;
  cron?: string | null;
  timezone?: string;
  webhookConfig?: Record<string, unknown> | null;
  model?: string | null;
  buildModel?: string | null;
  baseBranch?: string | null;
  repoBranches?: Record<string, string> | null;
  agentType?: 'build' | 'captain';
  visibilityScope?: 'project' | 'creator';
  webhookSecret?: string | null;
  triggers?: Array<Record<string, unknown>>;
  mcpOverrides?: CapyMcpOverrides | null;
}

export type CapyUpdateAutomationInput = Partial<CapyCreateAutomationInput>;

export interface CapyListAutomationsOptions {
  impersonateUserEmail?: string;
  includeDisabled?: boolean;
  enabled?: boolean;
  limit?: number;
  cursor?: string;
}

export interface CapyTriggerAutomationResult {
  runId: string | null;
  jamId: string | null;
  status: 'running' | 'skipped' | 'failed';
}

export type CapyVerifiedSession =
  | {
      valid: true;
      threadId: string;
      projectId: string;
      orgId: string | null;
      userId: string;
      instanceId: string;
      issuedAt: string;
      expiresAt: string;
    }
  | {
      valid: false;
      reason: 'invalid' | 'expired';
    };

export type CapySpeed = 'fast' | 'standard';
export type CapyReasoningMode =
  'off' | 'on' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CapyCreateThreadInput {
  projectId: string;
  prompt: string;
  model?: string;
  speed?: CapySpeed;
  reasoning?: { mode: CapyReasoningMode };
  buildModel?: string;
  buildSpeed?: CapySpeed;
  buildReasoning?: { mode: CapyReasoningMode };
  repos?: CapyRepository[];
  browserSnapshotIds?: string[];
  attachmentUrls?: string[];
  tags?: string[];
  impersonateUserEmail?: string;
  slack?: { channel: string };
  reliabilityInvestigationId?: string;
}

export interface CapySendMessageInput {
  message: string;
  messageId?: string;
  mode?: 'interrupt' | 'queue';
  model?: string;
  speed?: CapySpeed;
  reasoning?: { mode: CapyReasoningMode };
  buildModel?: string;
  buildSpeed?: CapySpeed;
  buildReasoning?: { mode: CapyReasoningMode };
  browserSnapshotIds?: string[];
  attachmentUrls?: string[];
  impersonateUserEmail?: string;
}

export interface CapySendMessageResponse {
  id: string;
  status: 'sent' | 'queued' | 'pending';
  inputEventId?: string;
  timelineSequence?: string;
  appendState?: 'inserted' | 'already_present';
}

export interface CapyListThreadsOptions {
  projectId: string;
  limit?: number;
  cursor?: string;
  status?: CapyThreadStatus;
  branch?: string;
  prNumber?: number;
  prState?: 'open' | 'merged' | 'closed' | 'none';
  tag?: string;
  origin?: 'web' | 'slack' | 'api' | 'linear' | 'automation' | 'github';
  authorId?: string;
  authorEmail?: string;
  participantId?: string;
  participantEmail?: string;
  slackThreadTs?: string;
  slackChannelId?: string;
  q?: string;
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
