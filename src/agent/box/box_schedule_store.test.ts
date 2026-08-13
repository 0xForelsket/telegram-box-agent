import { describe, expect, it } from 'vitest';
import type { RedisClient } from '../../utils/redis';
import { BoxScheduleStore } from './box_schedule_store';

class FakeRedis {
  values = new Map<string, string>();
  sorted = new Map<string, string[]>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async getMany(keys: string[]) { return keys.map(key => this.values.get(key) ?? null); }
  async set(key: string, value: string) { this.values.set(key, value); }
  async zadd(key: string, _score: number, member: string) { this.sorted.set(key, [...(this.sorted.get(key) ?? []), member]); }
  async zrangeAll(key: string, limit = 200) { return (this.sorted.get(key) ?? []).slice(0, limit); }
  async withLock<T>(_scope: string, action: () => Promise<T>) { return await action(); }
}

describe('BoxScheduleStore', () => {
  it('persists schedule state and deduplicates recurring callbacks by run ID', async () => {
    const store = new BoxScheduleStore(new FakeRedis() as unknown as RedisClient);
    const record = await store.create({
      chatId: -100, ownerUserId: 'owner', cron: '0 1 * * *', prompt: 'Generate a daily report',
      route: 'deepseek', model: 'deepseek/deepseek-v4-flash', callbackNonce: 'schedule_nonce_123456', now: 100,
    });
    await store.update(record.id, { status: 'active', boxId: 'box-1', upstreamScheduleId: 'upstream-1' }, 200);
    const first = await store.applyRun(record.id, 'schedule_nonce_123456', { run_id: 'run-1', status: 'completed', output: 'done' }, 300);
    const duplicate = await store.applyRun(record.id, 'schedule_nonce_123456', { run_id: 'run-1', status: 'completed', output: 'done' }, 400);
    expect(first.record).toMatchObject({ totalRuns: 1, totalFailures: 0, lastOutput: 'done' });
    expect(first.run).toMatchObject({ upstreamRunId: 'run-1', status: 'completed', output: 'done' });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.totalRuns).toBe(1);
    const delivery = await store.claimRunDelivery(first.run.id, 500);
    expect(delivery).not.toBeNull();
    await expect(store.claimRunDelivery(first.run.id, 600)).resolves.toBeNull();
    await store.releaseRunDelivery(first.run.id, delivery!.leaseId);
    const retry = await store.claimRunDelivery(first.run.id, 700);
    await store.markRunDelivered(first.run.id, retry!.leaseId, 800);
    await expect(store.listPendingRuns(record.id)).resolves.toEqual([]);
    await expect(store.applyRun(record.id, 'forged_nonce_123456', { run_id: 'run-2', status: 'failed' })).rejects.toThrow('nonce mismatch');
    await expect(store.applyRun(record.id, 'schedule_nonce_123456', { run_id: '', status: 'failed' })).rejects.toThrow('run ID is invalid');
  });
});
