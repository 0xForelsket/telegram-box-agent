import { describe, expect, it, vi } from 'vitest';
import { RedisClient } from '../utils/redis';
import { AgentRunStore } from './agent_run_store';

function createRedis(): RedisClient {
  const values = new Map<string, string>();
  const sortedSets = new Map<string, Map<string, number>>();
  const setFor = (key: string) => {
    let set = sortedSets.get(key);
    if (!set) {
      set = new Map();
      sortedSets.set(key, set);
    }
    return set;
  };
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    getMany: vi.fn(async (keys: string[]) => keys.map(key => values.get(key) ?? null)),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    zadd: vi.fn(async (key: string, score: number, member: string) => { setFor(key).set(member, score); }),
    zrem: vi.fn(async (key: string, member: string) => setFor(key).delete(member)),
    zrangeAll: vi.fn(async (key: string, limit = 200) => [...setFor(key).entries()]
      .sort((left, right) => left[1] - right[1]).slice(0, limit).map(([member]) => member)),
    zrangeByScore: vi.fn(async (key: string, min: number, max: number, limit = 50) => [...setFor(key).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((left, right) => left[1] - right[1]).slice(0, limit).map(([member]) => member)),
    withLock: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => await fn()),
  } as unknown as RedisClient;
}

describe('AgentRunStore', () => {
  it('creates and lists a versioned Redis-backed run', async () => {
    const redis = createRedis();
    const store = new AgentRunStore(redis);

    const run = await store.create({ chatId: 42, sessionKey: '42', goal: '  Research   this company  ', now: 100 });
    const listed = await store.list('42');

    expect(run).toMatchObject({
      status: 'queued', phase: 'planning', goal: 'Research this company', nextAt: 100,
      wakeCount: 0, maxWakes: 12, currentStep: 0, plan: [], observations: [], journal: [],
    });
    expect(listed).toEqual([run]);
    expect(redis.set).toHaveBeenCalledWith(`agent_run:v1:${run.id}`, expect.any(String), 7 * 24 * 60 * 60);
    expect(redis.zadd).toHaveBeenCalledWith('agent_runs:v1:due', 100, run.id);
  });

  it('persists a plan and compact observations across several cron wakes', async () => {
    const redis = createRedis();
    const store = new AgentRunStore(redis);
    const run = await store.create({ chatId: 42, sessionKey: '42', goal: 'Prepare a brief', now: 100 });
    const handler = vi.fn()
      .mockResolvedValueOnce({ type: 'planned', plan: ['Gather evidence', 'Analyze evidence'] })
      .mockResolvedValueOnce({ type: 'advanced', observation: 'Found source A and source B.' })
      .mockResolvedValueOnce({ type: 'advanced', observation: 'Evidence supports conclusion C.' })
      .mockResolvedValueOnce({ type: 'completed', result: 'Finished brief' });

    await expect(store.drainDue(handler, 100)).resolves.toBe(1);
    let latest = (await store.getForSession('42', run.id))!;
    expect(latest).toMatchObject({ status: 'waiting', phase: 'executing', currentStep: 0, wakeCount: 1 });
    expect(latest.plan.map(step => step.title)).toEqual(['Gather evidence', 'Analyze evidence']);

    await store.drainDue(handler, latest.nextAt);
    latest = (await store.getForSession('42', run.id))!;
    expect(latest).toMatchObject({ status: 'waiting', phase: 'executing', currentStep: 1, wakeCount: 2 });
    expect(latest.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'step-1', summary: 'Found source A and source B.' }),
    ]));

    await store.drainDue(handler, latest.nextAt);
    latest = (await store.getForSession('42', run.id))!;
    expect(latest).toMatchObject({ status: 'waiting', phase: 'finalizing', currentStep: 2, wakeCount: 3 });

    await store.drainDue(handler, latest.nextAt);

    expect(handler).toHaveBeenCalledTimes(4);
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: run.id, status: 'running', phase: 'executing', currentStep: 0, activeWakeId: expect.any(String),
    }));
    await expect(store.getForSession('42', run.id)).resolves.toMatchObject({
      status: 'completed', phase: 'finalizing', result: 'Finished brief', wakeCount: 4, nextAt: 0,
    });
    expect(await redis.zrangeAll('agent_runs:v1:due')).toEqual([]);
  });

  it('requeues failures with bounded backoff and fails after the third attempt', async () => {
    const redis = createRedis();
    const store = new AgentRunStore(redis);
    const run = await store.create({ chatId: 42, sessionKey: '42', goal: 'Try a flaky task', now: 100 });
    const handler = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    await store.drainDue(handler, 100);
    const firstRetry = await store.getForSession('42', run.id);
    expect(firstRetry).toMatchObject({ status: 'waiting', wakeCount: 1, retryCount: 1 });
    expect(firstRetry!.nextAt).toBeGreaterThan(100);

    await store.drainDue(handler, firstRetry!.nextAt);
    const secondRetry = await store.getForSession('42', run.id);
    expect(secondRetry).toMatchObject({ status: 'waiting', wakeCount: 2, retryCount: 2 });

    await store.drainDue(handler, secondRetry!.nextAt);
    await expect(store.getForSession('42', run.id)).resolves.toMatchObject({
      status: 'failed', wakeCount: 3, retryCount: 3, lastError: 'provider unavailable', nextAt: 0,
    });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('cancels queued work and removes its due wake', async () => {
    const redis = createRedis();
    const store = new AgentRunStore(redis);
    const run = await store.create({ chatId: 42, sessionKey: '42', goal: 'Do later', now: 100 });

    await expect(store.cancel('42', run.id, 200)).resolves.toMatchObject({ status: 'cancelled', updatedAt: 200 });
    await expect(store.drainDue(vi.fn(), 1_000)).resolves.toBe(0);
  });

  it('terminalizes the legacy due queue during Box cutover and never executes it', async () => {
    const redis = createRedis();
    const store = new AgentRunStore(redis);
    const run = await store.create({ chatId: 42, sessionKey: '42', goal: 'Old cron work', now: 100 });
    await expect(store.retirePending(200)).resolves.toBe(1);
    await expect(store.getForSession('42', run.id)).resolves.toMatchObject({
      status: 'failed', nextAt: 0, lastError: expect.stringContaining('Upstash Box cutover'),
    });
    const handler = vi.fn();
    await expect(store.drainDue(handler, 1_000)).resolves.toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a stale wake result after a crashed lease is reclaimed', async () => {
    const redis = createRedis();
    const store = new AgentRunStore(redis);
    const run = await store.create({ chatId: 42, sessionKey: '42', goal: 'Lease test', now: 100 });
    let resolveOld!: (value: { type: 'planned'; plan: string[] }) => void;
    const oldHandler = vi.fn(() => new Promise<{ type: 'planned'; plan: string[] }>(resolve => { resolveOld = resolve; }));
    const oldDrain = store.drainDue(oldHandler, 100);
    await vi.waitFor(() => expect(oldHandler).toHaveBeenCalledOnce());

    const reclaimed = await store.drainDue(
      vi.fn().mockResolvedValue({ type: 'completed', result: 'New lease won' }),
      100 + 10 * 60_000,
    );
    resolveOld({ type: 'planned', plan: ['Stale plan'] });

    await expect(oldDrain).resolves.toBe(0);
    expect(reclaimed).toBe(1);
    await expect(store.getForSession('42', run.id)).resolves.toMatchObject({
      status: 'completed', result: 'New lease won', wakeCount: 2,
    });
  });
});
