import type { WebhookPayload } from '@upstash/box';
import type { RedisClient } from '../../utils/redis';
import { constantTimeEqual, hashToken } from '../../utils/helpers';
import type { BoxModelRoute } from './pi_runtime';
import { parseApprovalMarker, type PendingBoxApproval } from './execution_policy';

const RECORD_PREFIX = 'box_job:v1:';
const CHAT_INDEX_PREFIX = 'box_jobs:v1:chat:';
const USER_INDEX_PREFIX = 'box_jobs:v1:user:';
const RECORD_TTL_SECONDS = 45 * 24 * 60 * 60;

export type BoxJobStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out';

export interface BoxJobCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelResponses: number;
  totalUsd: number;
}

export interface BoxJob {
  id: string;
  chatId: number;
  userId: string;
  sessionKey: string;
  request: string;
  route: BoxModelRoute;
  model: string;
  status: BoxJobStatus;
  createdAt: number;
  updatedAt: number;
  callbackNonceHash: string;
  artifactSessionTokenHash: string;
  approvalNonceHash: string;
  callbackConsumedAt?: number;
  boxId?: string;
  runId?: string;
  result?: string;
  error?: string;
  terminalReason?: string;
  cost?: BoxJobCost;
  artifactIds: string[];
  deliveryLeaseId?: string;
  deliveryLeaseExpiresAt?: number;
  completionDeliveredAt?: number;
  cleanupCompletedAt?: number;
  pendingApproval?: PendingBoxApproval & { expiresAt: number };
  approvalNoticeDeliveredAt?: number;
  approvalDeliveryLeaseId?: string;
  approvalDeliveryLeaseExpiresAt?: number;
  approvalCount?: number;
  /** Telegram message edited in place with live progress, if one was sent. */
  progressMessageId?: number;
  progressHeader?: string;
  progressText?: string;
  progressUpdatedAt?: number;
}

export interface CreateBoxJobInput {
  chatId: number;
  userId: string;
  sessionKey: string;
  request: string;
  route: BoxModelRoute;
  model: string;
  callbackNonce: string;
  artifactSessionToken: string;
  approvalNonce?: string;
  now?: number;
}

type BoxJobRedis = Pick<
  RedisClient,
  'get' | 'getMany' | 'set' | 'zadd' | 'zrangeAll' | 'withLock'
>;

const TERMINAL_STATUSES = new Set<BoxJobStatus>([
  'succeeded', 'failed', 'canceled', 'timed_out',
]);

const ALLOWED_TRANSITIONS: Record<BoxJobStatus, ReadonlySet<BoxJobStatus>> = {
  queued: new Set(['provisioning', 'canceled', 'failed', 'timed_out']),
  provisioning: new Set(['running', 'succeeded', 'failed', 'canceled', 'timed_out']),
  running: new Set(['awaiting_approval', 'succeeded', 'failed', 'canceled', 'timed_out']),
  awaiting_approval: new Set(['running', 'succeeded', 'failed', 'canceled', 'timed_out']),
  succeeded: new Set(),
  failed: new Set(),
  canceled: new Set(),
  timed_out: new Set(),
};

export class BoxJobStore {
  constructor(private readonly redis: BoxJobRedis) {}

  async create(input: CreateBoxJobInput): Promise<BoxJob> {
    const request = input.request.trim().replace(/\s+/g, ' ').slice(0, 8_000);
    if (!request) throw new Error('Box job request is empty.');
    const callbackNonce = normalizeToken(input.callbackNonce, 'callback nonce');
    const artifactSessionToken = normalizeToken(input.artifactSessionToken, 'artifact session token');
    const approvalNonce = normalizeToken(input.approvalNonce ?? callbackNonce, 'approval nonce');
    const userId = normalizeToken(input.userId, 'user ID');
    const now = input.now ?? Date.now();
    const job: BoxJob = {
      id: `bj_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      chatId: input.chatId,
      userId,
      sessionKey: input.sessionKey.trim(),
      request,
      route: input.route,
      model: input.model,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      callbackNonceHash: await hashToken(callbackNonce),
      artifactSessionTokenHash: await hashToken(artifactSessionToken),
      approvalNonceHash: await hashToken(approvalNonce),
      artifactIds: [],
    };
    await Promise.all([
      this.save(job),
      this.redis.zadd(`${CHAT_INDEX_PREFIX}${job.chatId}`, now, job.id),
      this.redis.zadd(`${USER_INDEX_PREFIX}${job.userId}`, now, job.id),
    ]);
    return job;
  }

  async get(id: string): Promise<BoxJob | null> {
    const raw = await this.redis.get(this.recordKey(id));
    return this.parse(raw);
  }

  async verifyArtifactSession(id: string, token: string): Promise<BoxJob | null> {
    const job = await this.get(id);
    if (!job) return null;
    const supplied = await hashToken(normalizeToken(token, 'artifact session token'));
    return constantTimeEqual(job.artifactSessionTokenHash, supplied) ? job : null;
  }

  /**
   * Records the message that live progress will be edited into.
   *
   * Written without a lock and without a status check: it only ever affects a
   * cosmetic field, and blocking the acceptance path on the job lock would put
   * a Redis round trip between the user and their acknowledgement.
   */
  async setProgressMessage(
    id: string,
    input: { messageId: number; header: string },
  ): Promise<void> {
    const job = await this.get(id);
    if (!job) return;
    // `progressUpdatedAt` is deliberately left unset: it is the throttle clock
    // for real updates, and stamping it here would swallow the first one.
    await this.save({
      ...job,
      progressMessageId: input.messageId,
      progressHeader: input.header,
    });
  }

  /**
   * Stores the latest progress line if it is newer than `minIntervalMs`.
   *
   * Returns null when the update is dropped, which is the throttle: Box is the
   * one deciding how often to report, and an agent in a tight tool loop must
   * not be able to drive one Telegram edit per tool call.
   */
  async recordProgress(
    id: string,
    text: string,
    now = Date.now(),
    minIntervalMs = 4_000,
  ): Promise<BoxJob | null> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.get(id);
      if (!job || TERMINAL_STATUSES.has(job.status)) return null;
      if (job.progressUpdatedAt && now - job.progressUpdatedAt < minIntervalMs) return null;
      const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!normalized || normalized === job.progressText) return null;
      const updated = { ...job, progressText: normalized, progressUpdatedAt: now };
      await this.save(updated);
      return updated;
    });
  }

  async setArtifactIds(id: string, artifactIds: string[], now = Date.now()): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      const normalized = [...new Set(artifactIds.map(value => value.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
      const updated = { ...job, artifactIds: normalized, updatedAt: now };
      await this.save(updated);
      return updated;
    });
  }

  async listForChat(chatId: number, limit = 50): Promise<BoxJob[]> {
    const ids = await this.redis.zrangeAll(`${CHAT_INDEX_PREFIX}${chatId}`, limit);
    const jobs = (await this.redis.getMany(ids.map(id => this.recordKey(id))))
      .map(raw => this.parse(raw))
      .filter((job): job is BoxJob => !!job && job.chatId === chatId);
    return jobs.sort((left, right) => right.createdAt - left.createdAt);
  }

  async markProvisioning(id: string, now = Date.now()): Promise<BoxJob> {
    return await this.transition(id, 'provisioning', {}, now);
  }

  async markRunning(
    id: string,
    boxId: string,
    runId: string,
    now = Date.now(),
  ): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      // A very fast completion callback may win the race with this write. Keep
      // the terminal state and only attach identifiers that were not recorded.
      if (TERMINAL_STATUSES.has(job.status)) {
        const updated = { ...job, boxId: job.boxId ?? boxId, runId: job.runId ?? runId, updatedAt: now };
        await this.save(updated);
        return updated;
      }
      if (job.status === 'running') {
        const updated = { ...job, boxId, runId, updatedAt: now };
        await this.save(updated);
        return updated;
      }
      return await this.transitionUnlocked(job, 'running', { boxId, runId, error: undefined }, now);
    });
  }

  async cancel(id: string, now = Date.now()): Promise<BoxJob | null> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.get(id);
      if (!job || TERMINAL_STATUSES.has(job.status)) return null;
      return await this.transitionUnlocked(job, 'canceled', { terminalReason: 'canceled by request' }, now);
    });
  }

  async prepareApprovalResume(input: {
    id: string;
    nonce: string;
    nextCallbackNonce: string;
    nextApprovalNonce: string;
    now?: number;
  }): Promise<BoxJob> {
    const now = input.now ?? Date.now();
    return await this.redis.withLock(`box-job:${input.id}`, async () => {
      const job = await this.require(input.id);
      if (job.status !== 'awaiting_approval' || !job.pendingApproval) throw new Error('Box job is not awaiting approval.');
      if (job.pendingApproval.expiresAt < now) throw new Error('Box approval has expired.');
      const supplied = await hashToken(normalizeToken(input.nonce, 'approval nonce'));
      if (!constantTimeEqual(job.approvalNonceHash, supplied)) throw new Error('Invalid Box approval nonce.');
      return await this.transitionUnlocked(job, 'running', {
        callbackNonceHash: await hashToken(normalizeToken(input.nextCallbackNonce, 'callback nonce')),
        approvalNonceHash: await hashToken(normalizeToken(input.nextApprovalNonce, 'approval nonce')),
        callbackConsumedAt: undefined,
        pendingApproval: undefined,
        approvalNoticeDeliveredAt: undefined,
        approvalDeliveryLeaseId: undefined,
        approvalDeliveryLeaseExpiresAt: undefined,
        approvalCount: (job.approvalCount ?? 0) + 1,
        error: undefined,
        terminalReason: undefined,
      }, now);
    });
  }

  async markFailed(id: string, error: string, now = Date.now()): Promise<BoxJob> {
    return await this.markTerminal(id, 'failed', error, now);
  }

  async markTimedOut(id: string, error = 'Box job exceeded its time limit.', now = Date.now()): Promise<BoxJob> {
    return await this.markTerminal(id, 'timed_out', error, now);
  }

  async expireApproval(id: string, now = Date.now()): Promise<BoxJob | null> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.status !== 'awaiting_approval' || !job.pendingApproval || job.pendingApproval.expiresAt > now) return null;
      return await this.transitionUnlocked(job, 'failed', {
        error: 'Owner approval expired.', terminalReason: 'Owner approval expired.', pendingApproval: undefined,
        approvalDeliveryLeaseId: undefined, approvalDeliveryLeaseExpiresAt: undefined,
      }, now);
    });
  }

  async applyCompletion(input: {
    jobId: string;
    nonce: string;
    payload: WebhookPayload;
    now?: number;
  }): Promise<{ job: BoxJob; duplicate: boolean; late: boolean; approvalNonce?: string }> {
    const now = input.now ?? Date.now();
    return await this.redis.withLock(`box-job:${input.jobId}`, async () => {
      const job = await this.require(input.jobId);
      if (job.callbackNonceHash !== await hashToken(input.nonce)) throw new Error('Box callback nonce mismatch.');
      if (job.boxId && job.boxId !== input.payload.box_id) throw new Error('Box callback box ID mismatch.');
      if (job.runId && input.payload.run_id && job.runId !== input.payload.run_id) {
        throw new Error('Box callback run ID mismatch.');
      }
      if (job.callbackConsumedAt) {
        return { job, duplicate: true, late: job.status === 'canceled' || job.status === 'timed_out' };
      }

      if (job.status === 'canceled' || job.status === 'timed_out') {
        const consumed = { ...job, callbackConsumedAt: now, updatedAt: now };
        await this.save(consumed);
        return { job: consumed, duplicate: false, late: true };
      }
      if (job.status === 'queued') throw new Error('Box callback arrived before provisioning began.');

      const approval = input.payload.status === 'failed' ? parseApprovalMarker(input.payload.error) : null;
      if (approval) {
        if (!approval.nonce || job.approvalNonceHash !== await hashToken(approval.nonce)) {
          throw new Error('Box approval nonce mismatch.');
        }
        const awaiting = await this.transitionUnlocked(job, 'awaiting_approval', {
          boxId: input.payload.box_id,
          runId: input.payload.run_id ?? job.runId,
          callbackConsumedAt: now,
          pendingApproval: {
            nonce: approval.nonce,
            category: approval.category,
            action: approval.action,
            actionHash: approval.actionHash,
            requestedAt: approval.requestedAt,
            expiresAt: now + 15 * 60_000,
          },
          error: undefined,
          terminalReason: 'Awaiting owner approval for a protected action.',
        }, now);
        return { job: awaiting, duplicate: false, late: false, approvalNonce: approval.nonce };
      }

      const nextStatus: BoxJobStatus = input.payload.status === 'completed' ? 'succeeded' : 'failed';
      const metadata = input.payload.metadata ?? {};
      const updated = await this.transitionUnlocked(job, nextStatus, {
        boxId: input.payload.box_id,
        runId: input.payload.run_id ?? job.runId,
        callbackConsumedAt: now,
        result: input.payload.output?.trim().slice(0, 32_000),
        error: input.payload.error?.trim().slice(0, 4_000),
        terminalReason: input.payload.status === 'completed'
          ? 'Box run completed.'
          : input.payload.error?.trim().slice(0, 4_000) || 'Box run failed.',
        cost: parseCost(metadata),
      }, now);
      return { job: updated, duplicate: false, late: false };
    });
  }

  async claimApprovalDelivery(
    id: string,
    now = Date.now(),
    leaseMs = 60_000,
  ): Promise<{ job: BoxJob; leaseId: string } | null> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.status !== 'awaiting_approval' || !job.pendingApproval || job.approvalNoticeDeliveredAt) return null;
      if (job.approvalDeliveryLeaseId && (job.approvalDeliveryLeaseExpiresAt ?? 0) > now) return null;
      const leaseId = crypto.randomUUID();
      const updated = {
        ...job,
        approvalDeliveryLeaseId: leaseId,
        approvalDeliveryLeaseExpiresAt: now + leaseMs,
        updatedAt: now,
      };
      await this.save(updated);
      return { job: updated, leaseId };
    });
  }

  async markApprovalDelivered(id: string, leaseId: string, now = Date.now()): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.approvalNoticeDeliveredAt) return job;
      if (job.approvalDeliveryLeaseId !== leaseId) throw new Error('Box approval delivery lease mismatch.');
      const updated = {
        ...job,
        approvalNoticeDeliveredAt: now,
        approvalDeliveryLeaseId: undefined,
        approvalDeliveryLeaseExpiresAt: undefined,
        updatedAt: now,
      };
      await this.save(updated);
      return updated;
    });
  }

  async releaseApprovalDelivery(id: string, leaseId: string, now = Date.now()): Promise<void> {
    await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.approvalDeliveryLeaseId !== leaseId || job.approvalNoticeDeliveredAt) return;
      await this.save({
        ...job,
        approvalDeliveryLeaseId: undefined,
        approvalDeliveryLeaseExpiresAt: undefined,
        updatedAt: now,
      });
    });
  }

  async claimCompletionDelivery(
    id: string,
    now = Date.now(),
    leaseMs = 60_000,
  ): Promise<{ job: BoxJob; leaseId: string } | null> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (!TERMINAL_STATUSES.has(job.status) || job.completionDeliveredAt) return null;
      if (job.deliveryLeaseId && (job.deliveryLeaseExpiresAt ?? 0) > now) return null;
      const leaseId = crypto.randomUUID();
      const updated = {
        ...job,
        deliveryLeaseId: leaseId,
        deliveryLeaseExpiresAt: now + leaseMs,
        updatedAt: now,
      };
      await this.save(updated);
      return { job: updated, leaseId };
    });
  }

  async markCompletionDelivered(id: string, leaseId: string, now = Date.now()): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.completionDeliveredAt) return job;
      if (job.deliveryLeaseId !== leaseId) throw new Error('Box completion delivery lease mismatch.');
      const updated = {
        ...job,
        completionDeliveredAt: now,
        deliveryLeaseId: undefined,
        deliveryLeaseExpiresAt: undefined,
        updatedAt: now,
      };
      await this.save(updated);
      return updated;
    });
  }

  async releaseCompletionDelivery(id: string, leaseId: string, now = Date.now()): Promise<void> {
    await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.deliveryLeaseId !== leaseId || job.completionDeliveredAt) return;
      await this.save({
        ...job,
        deliveryLeaseId: undefined,
        deliveryLeaseExpiresAt: undefined,
        updatedAt: now,
      });
    });
  }

  async markCleanupCompleted(id: string, now = Date.now()): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (job.cleanupCompletedAt) return job;
      const updated = { ...job, cleanupCompletedAt: now, updatedAt: now };
      await this.save(updated);
      return updated;
    });
  }

  private async transition(
    id: string,
    status: BoxJobStatus,
    patch: Partial<BoxJob>,
    now: number,
  ): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      return await this.transitionUnlocked(job, status, patch, now);
    });
  }

  private async markTerminal(
    id: string,
    status: 'failed' | 'timed_out',
    error: string,
    now: number,
  ): Promise<BoxJob> {
    return await this.redis.withLock(`box-job:${id}`, async () => {
      const job = await this.require(id);
      if (TERMINAL_STATUSES.has(job.status)) return job;
      const normalizedError = error.trim().slice(0, 4_000) || `Box job ${status}.`;
      return await this.transitionUnlocked(job, status, {
        error: normalizedError,
        terminalReason: normalizedError,
      }, now);
    });
  }

  private async transitionUnlocked(
    job: BoxJob,
    status: BoxJobStatus,
    patch: Partial<BoxJob>,
    now: number,
  ): Promise<BoxJob> {
    if (!ALLOWED_TRANSITIONS[job.status].has(status)) {
      throw new Error(`Illegal Box job transition: ${job.status} -> ${status}`);
    }
    const updated: BoxJob = { ...job, ...patch, id: job.id, status, updatedAt: now };
    await this.save(updated);
    return updated;
  }

  private async require(id: string): Promise<BoxJob> {
    const job = await this.get(id);
    if (!job) throw new Error(`Box job not found: ${id}`);
    return job;
  }

  private async save(job: BoxJob): Promise<void> {
    await this.redis.set(this.recordKey(job.id), JSON.stringify(job), RECORD_TTL_SECONDS);
  }

  private recordKey(id: string): string {
    return `${RECORD_PREFIX}${id.trim().toLowerCase()}`;
  }

  private parse(raw: string | null): BoxJob | null {
    if (!raw) return null;
    try {
      const job = JSON.parse(raw) as BoxJob;
      return job?.id && ALLOWED_TRANSITIONS[job.status] ? job : null;
    } catch {
      return null;
    }
  }
}

function parseCost(metadata: Record<string, unknown>): BoxJobCost | undefined {
  const source = metadata.cost && typeof metadata.cost === 'object'
    ? metadata.cost as Record<string, unknown>
    : metadata;
  const values = {
    inputTokens: numberOrZero(source.input_tokens ?? source.inputTokens),
    outputTokens: numberOrZero(source.output_tokens ?? source.outputTokens),
    cachedInputTokens: numberOrZero(source.cached_input_tokens ?? source.cachedInputTokens),
    modelResponses: numberOrZero(source.model_responses ?? source.modelResponses),
    totalUsd: numberOrZero(source.total_cost_usd ?? source.totalUsd),
  };
  return Object.values(values).some(value => value !== 0) ? values : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeToken(value: string, label: string): string {
  const token = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) throw new Error(`Invalid ${label}.`);
  return token;
}
