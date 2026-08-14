import type { RedisClient } from '../../utils/redis';
import { constantTimeEqual, hashToken } from '../../utils/helpers';
import type { ActionName } from './action_catalog';

const RECORD_PREFIX = 'box_action:v1:';
const CHAT_INDEX_PREFIX = 'box_actions:v1:chat:';
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Approval window. Long enough for a phone notification, short enough that a
 * stale request cannot be approved into a situation that has since changed. */
export const ACTION_APPROVAL_TTL_MS = 15 * 60_000;

export type ActionStatus = 'pending' | 'approved' | 'executed' | 'failed' | 'denied' | 'expired';

export interface BrokeredAction {
  id: string;
  jobId: string;
  chatId: number;
  userId: string;
  action: ActionName;
  params: Record<string, string | number>;
  actionHash: string;
  description: string;
  status: ActionStatus;
  approvalNonceHash: string;
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
  executedAt?: number;
  result?: string;
  error?: string;
}

type ActionRedis = Pick<RedisClient, 'get' | 'getMany' | 'set' | 'zadd' | 'zrangeAll' | 'withLock'>;

export class ActionStore {
  constructor(private readonly redis: ActionRedis) {}

  async create(input: {
    jobId: string;
    chatId: number;
    userId: string;
    action: ActionName;
    params: Record<string, string | number>;
    actionHash: string;
    description: string;
    approvalNonce: string;
    now?: number;
  }): Promise<BrokeredAction> {
    const now = input.now ?? Date.now();
    const record: BrokeredAction = {
      id: `bx_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      jobId: input.jobId,
      chatId: input.chatId,
      userId: input.userId,
      action: input.action,
      params: input.params,
      actionHash: input.actionHash,
      description: input.description,
      status: 'pending',
      // Only the hash is stored. A Redis dump must not be enough to approve an
      // action, the same reason callback nonces are stored hashed.
      approvalNonceHash: await hashToken(input.approvalNonce, {
        label: 'action approval nonce',
        minLength: 8,
      }),
      createdAt: now,
      expiresAt: now + ACTION_APPROVAL_TTL_MS,
    };
    await Promise.all([
      this.save(record),
      this.redis.zadd(`${CHAT_INDEX_PREFIX}${record.chatId}`, now, record.id),
    ]);
    return record;
  }

  async get(id: string): Promise<BrokeredAction | null> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as BrokeredAction;
      return value?.id ? value : null;
    } catch {
      return null;
    }
  }

  async listForChat(chatId: number, limit = 20): Promise<BrokeredAction[]> {
    const ids = await this.redis.zrangeAll(`${CHAT_INDEX_PREFIX}${chatId}`, limit);
    const records = (await this.redis.getMany(ids.map(id => this.key(id))))
      .map(raw => {
        if (!raw) return null;
        try { return JSON.parse(raw) as BrokeredAction; } catch { return null; }
      })
      .filter((value): value is BrokeredAction => !!value && value.chatId === chatId);
    return records.sort((left, right) => right.createdAt - left.createdAt);
  }

  /**
   * Consumes one matching approval.
   *
   * Under a lock and status-checked, so a replayed `/action approve` cannot
   * execute the same write twice, and an expired request cannot be revived.
   */
  async approve(input: {
    id: string;
    nonce: string;
    ownerUserId: string;
    now?: number;
  }): Promise<BrokeredAction> {
    const now = input.now ?? Date.now();
    const suppliedHash = await hashToken(input.nonce, {
      label: 'action approval nonce',
      minLength: 8,
    });
    return await this.redis.withLock(`box-action:${input.id}`, async () => {
      const record = await this.require(input.id);
      if (record.status !== 'pending') {
        throw new Error(`This action is already ${record.status}.`);
      }
      if (now > record.expiresAt) {
        await this.save({ ...record, status: 'expired' });
        throw new Error('This action approval window has expired.');
      }
      if (!constantTimeEqual(record.approvalNonceHash, suppliedHash)) {
        throw new Error('Approval nonce does not match this action.');
      }
      const approved: BrokeredAction = { ...record, status: 'approved', approvedAt: now };
      await this.save(approved);
      return approved;
    });
  }

  async deny(id: string, now = Date.now()): Promise<BrokeredAction> {
    return await this.redis.withLock(`box-action:${id}`, async () => {
      const record = await this.require(id);
      if (record.status !== 'pending') throw new Error(`This action is already ${record.status}.`);
      const denied: BrokeredAction = { ...record, status: 'denied', executedAt: now };
      await this.save(denied);
      return denied;
    });
  }

  async markExecuted(id: string, result: string, now = Date.now()): Promise<BrokeredAction> {
    return await this.redis.withLock(`box-action:${id}`, async () => {
      const record = await this.require(id);
      const executed: BrokeredAction = {
        ...record,
        status: 'executed',
        result: result.slice(0, 2_000),
        executedAt: now,
      };
      await this.save(executed);
      return executed;
    });
  }

  async markFailed(id: string, error: string, now = Date.now()): Promise<BrokeredAction> {
    return await this.redis.withLock(`box-action:${id}`, async () => {
      const record = await this.require(id);
      const failed: BrokeredAction = {
        ...record,
        status: 'failed',
        error: error.slice(0, 1_000),
        executedAt: now,
      };
      await this.save(failed);
      return failed;
    });
  }

  /** Marks an unapproved request expired so status views stop showing it as open. */
  async expireIfElapsed(id: string, now = Date.now()): Promise<BrokeredAction | null> {
    const record = await this.get(id);
    if (!record || record.status !== 'pending' || now <= record.expiresAt) return null;
    const expired: BrokeredAction = { ...record, status: 'expired' };
    await this.save(expired);
    return expired;
  }

  private async require(id: string): Promise<BrokeredAction> {
    const record = await this.get(id);
    if (!record) throw new Error(`Action not found: ${id}`);
    return record;
  }

  private async save(record: BrokeredAction): Promise<void> {
    await this.redis.set(this.key(record.id), JSON.stringify(record), RECORD_TTL_SECONDS);
  }

  private key(id: string): string {
    const normalized = id.trim().toLowerCase();
    if (!/^bx_[a-f0-9]{12}$/.test(normalized)) throw new Error('Invalid action ID.');
    return `${RECORD_PREFIX}${normalized}`;
  }
}
