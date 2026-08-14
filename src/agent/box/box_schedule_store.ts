import type { RedisClient } from '../../utils/redis';
import { sha256Hex } from '../../utils/helpers';
import type { BoxModelRoute } from './pi_runtime';

const RECORD_PREFIX = 'box_schedule:v1:';
const CHAT_INDEX_PREFIX = 'box_schedules:v1:chat:';
const RUN_PREFIX = 'box_schedule_run:v1:';
const RUN_INDEX_PREFIX = 'box_schedule_runs:v1:';
const RECORD_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export type BoxScheduleStatus = 'provisioning' | 'active' | 'paused' | 'error' | 'deleted';

export interface BoxScheduleRecord {
  id: string;
  chatId: number;
  ownerUserId: string;
  cron: string;
  prompt: string;
  route: BoxModelRoute;
  model: string;
  status: BoxScheduleStatus;
  callbackNonceHash: string;
  createdAt: number;
  updatedAt: number;
  boxId?: string;
  upstreamScheduleId?: string;
  lastRunId?: string;
  lastRunStatus?: 'completed' | 'failed';
  lastRunAt?: number;
  totalRuns: number;
  totalFailures: number;
  lastOutput?: string;
  lastError?: string;
}

export interface BoxScheduleRunRecord {
  id: string;
  scheduleId: string;
  upstreamRunId: string;
  status: 'completed' | 'failed';
  output?: string;
  error?: string;
  createdAt: number;
  deliveredAt?: number;
  deliveryLeaseId?: string;
  deliveryLeaseExpiresAt?: number;
}

type ScheduleRedis = Pick<RedisClient, 'get' | 'getMany' | 'set' | 'zadd' | 'zrangeAll' | 'withLock'>;

export class BoxScheduleStore {
  constructor(private readonly redis: ScheduleRedis) {}

  async create(input: Omit<BoxScheduleRecord, 'id' | 'status' | 'callbackNonceHash' | 'createdAt' | 'updatedAt' | 'totalRuns' | 'totalFailures'> & { callbackNonce: string; now?: number }): Promise<BoxScheduleRecord> {
    const now = input.now ?? Date.now();
    const record: BoxScheduleRecord = {
      id: `bs_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      chatId: input.chatId,
      ownerUserId: input.ownerUserId,
      cron: input.cron,
      prompt: input.prompt.trim().slice(0, 8_000),
      route: input.route,
      model: input.model,
      status: 'provisioning',
      callbackNonceHash: await hash(input.callbackNonce),
      createdAt: now,
      updatedAt: now,
      totalRuns: 0,
      totalFailures: 0,
    };
    await Promise.all([
      this.save(record),
      this.redis.zadd(`${CHAT_INDEX_PREFIX}${record.chatId}`, now, record.id),
    ]);
    return record;
  }

  async get(id: string): Promise<BoxScheduleRecord | null> {
    return parse(await this.redis.get(`${RECORD_PREFIX}${id.trim().toLowerCase()}`));
  }

  async list(chatId: number): Promise<BoxScheduleRecord[]> {
    const ids = await this.redis.zrangeAll(`${CHAT_INDEX_PREFIX}${chatId}`, 50);
    return (await this.redis.getMany(ids.map(id => `${RECORD_PREFIX}${id}`)))
      .map(parse).filter((item): item is BoxScheduleRecord => !!item && item.chatId === chatId && item.status !== 'deleted')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(id: string, patch: Partial<BoxScheduleRecord>, now = Date.now()): Promise<BoxScheduleRecord> {
    return await this.redis.withLock(`box-schedule:${id}`, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error('Box schedule not found.');
      const updated = { ...existing, ...patch, id: existing.id, updatedAt: now };
      await this.save(updated);
      return updated;
    });
  }

  async applyRun(id: string, nonce: string, payload: { run_id: string; status: 'completed' | 'failed'; output?: string; error?: string }, now = Date.now()): Promise<{ record: BoxScheduleRecord; run: BoxScheduleRunRecord; duplicate: boolean }> {
    const upstreamRunId = normalizeRunId(payload.run_id);
    const runId = `bsr_${(await hash(`${id}\0${upstreamRunId}`)).slice(0, 24)}`;
    return await this.redis.withLock(`box-schedule:${id}`, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error('Box schedule not found.');
      if (existing.callbackNonceHash !== await hash(nonce)) throw new Error('Box schedule callback nonce mismatch.');
      const priorRun = parseRun(await this.redis.get(`${RUN_PREFIX}${runId}`));
      if (priorRun) return { record: existing, run: priorRun, duplicate: true };
      const failed = payload.status === 'failed';
      const run: BoxScheduleRunRecord = {
        id: runId,
        scheduleId: existing.id,
        upstreamRunId,
        status: payload.status,
        output: payload.output?.trim().slice(0, 12_000),
        error: payload.error?.trim().slice(0, 4_000),
        createdAt: now,
      };
      const updated: BoxScheduleRecord = {
        ...existing,
        lastRunId: upstreamRunId,
        lastRunStatus: payload.status,
        lastRunAt: now,
        totalRuns: existing.totalRuns + 1,
        totalFailures: existing.totalFailures + (failed ? 1 : 0),
        lastOutput: payload.output?.trim().slice(0, 12_000),
        lastError: payload.error?.trim().slice(0, 4_000),
        updatedAt: now,
      };
      await this.saveRun(run);
      await this.redis.zadd(`${RUN_INDEX_PREFIX}${existing.id}`, now, run.id);
      await this.save(updated);
      return { record: updated, run, duplicate: false };
    });
  }

  async listPendingRuns(scheduleId: string, limit = 50): Promise<BoxScheduleRunRecord[]> {
    const ids = await this.redis.zrangeAll(`${RUN_INDEX_PREFIX}${scheduleId}`, limit);
    return (await this.redis.getMany(ids.map(id => `${RUN_PREFIX}${id}`)))
      .map(parseRun)
      .filter((run): run is BoxScheduleRunRecord => !!run && !run.deliveredAt)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async claimRunDelivery(runId: string, now = Date.now(), leaseMs = 60_000): Promise<{ run: BoxScheduleRunRecord; leaseId: string } | null> {
    return await this.redis.withLock(`box-schedule-run:${runId}`, async () => {
      const run = parseRun(await this.redis.get(`${RUN_PREFIX}${runId}`));
      if (!run || run.deliveredAt) return null;
      if (run.deliveryLeaseId && (run.deliveryLeaseExpiresAt ?? 0) > now) return null;
      const leaseId = crypto.randomUUID();
      const updated = { ...run, deliveryLeaseId: leaseId, deliveryLeaseExpiresAt: now + leaseMs };
      await this.saveRun(updated);
      return { run: updated, leaseId };
    });
  }

  async markRunDelivered(runId: string, leaseId: string, now = Date.now()): Promise<BoxScheduleRunRecord> {
    return await this.redis.withLock(`box-schedule-run:${runId}`, async () => {
      const run = parseRun(await this.redis.get(`${RUN_PREFIX}${runId}`));
      if (!run) throw new Error('Box schedule run not found.');
      if (run.deliveredAt) return run;
      if (run.deliveryLeaseId !== leaseId) throw new Error('Box schedule delivery lease mismatch.');
      const updated = { ...run, deliveredAt: now, deliveryLeaseId: undefined, deliveryLeaseExpiresAt: undefined };
      await this.saveRun(updated);
      return updated;
    });
  }

  async releaseRunDelivery(runId: string, leaseId: string): Promise<void> {
    await this.redis.withLock(`box-schedule-run:${runId}`, async () => {
      const run = parseRun(await this.redis.get(`${RUN_PREFIX}${runId}`));
      if (!run || run.deliveredAt || run.deliveryLeaseId !== leaseId) return;
      await this.saveRun({ ...run, deliveryLeaseId: undefined, deliveryLeaseExpiresAt: undefined });
    });
  }

  private async save(record: BoxScheduleRecord): Promise<void> {
    await this.redis.set(`${RECORD_PREFIX}${record.id}`, JSON.stringify(record), RECORD_TTL_SECONDS);
  }

  private async saveRun(run: BoxScheduleRunRecord): Promise<void> {
    await this.redis.set(`${RUN_PREFIX}${run.id}`, JSON.stringify(run), RECORD_TTL_SECONDS);
  }
}

function normalizeRunId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error('Box schedule callback run ID is invalid.');
  return normalized;
}

function parseRun(raw: string | null): BoxScheduleRunRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as BoxScheduleRunRecord;
    return value?.id?.startsWith('bsr_') ? value : null;
  } catch { return null; }
}

async function hash(value: string): Promise<string> {
  return await sha256Hex(value);
}

function parse(raw: string | null): BoxScheduleRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as BoxScheduleRecord;
    return value?.id?.startsWith('bs_') ? value : null;
  } catch { return null; }
}
