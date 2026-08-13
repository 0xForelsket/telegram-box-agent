import { describe, expect, it } from 'vitest';
import { BoxJobStore } from './box_job_store';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly sorted = new Map<string, Array<{ score: number; member: string }>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async getMany(keys: string[]): Promise<Array<string | null>> {
    return keys.map(key => this.values.get(key) ?? null);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const entries = this.sorted.get(key) ?? [];
    entries.push({ score, member });
    entries.sort((left, right) => left.score - right.score);
    this.sorted.set(key, entries);
  }

  async zrangeAll(key: string, limit = 200): Promise<string[]> {
    return (this.sorted.get(key) ?? []).slice(0, limit).map(entry => entry.member);
  }

  async withLock<T>(_scope: string, action: () => Promise<T>): Promise<T> {
    return await action();
  }
}

async function createJob(store: BoxJobStore) {
  return await store.create({
    chatId: -100123,
    userId: 'member_1',
    sessionKey: '-100123:member_1',
    request: 'Generate a PDF report',
    route: 'deepseek',
    model: 'deepseek/deepseek-v4-flash',
    callbackNonce: 'nonce_123456',
    artifactSessionToken: 'artifact_session_123456',
    approvalNonce: 'approval_nonce_123456',
    now: 1_000,
  });
}

describe('BoxJobStore', () => {
  it('writes new jobs under box_job:v1 and follows the normal lifecycle', async () => {
    const redis = new FakeRedis();
    const store = new BoxJobStore(redis);
    const queued = await createJob(store);

    expect([...redis.values.keys()]).toContain(`box_job:v1:${queued.id}`);
    expect(JSON.stringify(queued)).not.toContain('nonce_123456');
    expect(JSON.stringify(queued)).not.toContain('artifact_session_123456');
    expect(queued.callbackNonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(queued.status).toBe('queued');
    expect((await store.markProvisioning(queued.id, 2_000)).status).toBe('provisioning');
    expect((await store.markRunning(queued.id, 'box-1', 'run-1', 3_000)).status).toBe('running');

    const completion = await store.applyCompletion({
      jobId: queued.id,
      nonce: 'nonce_123456',
      now: 4_000,
      payload: {
        box_id: 'box-1',
        run_id: 'run-1',
        status: 'completed',
        output: 'PDF ready',
        metadata: { input_tokens: 100, output_tokens: 20, total_cost_usd: 0.01 },
      },
    });

    expect(completion).toMatchObject({ duplicate: false, late: false });
    expect(completion.job).toMatchObject({ status: 'succeeded', result: 'PDF ready' });
    expect(completion.job.cost).toMatchObject({ inputTokens: 100, outputTokens: 20, totalUsd: 0.01 });
  });

  it('authenticates a hashed job-scoped artifact session token', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await expect(store.verifyArtifactSession(job.id, 'artifact_session_123456')).resolves.toMatchObject({ id: job.id });
    await expect(store.verifyArtifactSession(job.id, 'artifact_session_forged')).resolves.toBeNull();
  });

  it('makes duplicate completion callbacks idempotent', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    const payload = { box_id: 'box-1', run_id: 'run-1', status: 'completed' as const, output: 'done' };

    const first = await store.applyCompletion({ jobId: job.id, nonce: 'nonce_123456', payload });
    const second = await store.applyCompletion({ jobId: job.id, nonce: 'nonce_123456', payload });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.late).toBe(false);
    expect(second.job.status).toBe('succeeded');
  });

  it('preserves a terminal callback that races ahead of markRunning', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    await store.applyCompletion({
      jobId: job.id,
      nonce: 'nonce_123456',
      payload: { box_id: 'box-1', run_id: 'run-1', status: 'completed', output: 'fast' },
    });

    const afterLateRunningWrite = await store.markRunning(job.id, 'box-1', 'run-1');
    expect(afterLateRunningWrite.status).toBe('succeeded');
    expect(afterLateRunningWrite.result).toBe('fast');
  });

  it('attaches runtime identity without reviving a cancellation that races provisioning', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    await store.cancel(job.id);
    const afterLaunch = await store.markRunning(job.id, 'box-1', 'run-1');
    expect(afterLaunch).toMatchObject({ status: 'canceled', boxId: 'box-1', runId: 'run-1' });
  });

  it('rejects forged nonces and mismatched Box identities', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    await store.markRunning(job.id, 'box-1', 'run-1');

    await expect(store.applyCompletion({
      jobId: job.id,
      nonce: 'forged_nonce',
      payload: { box_id: 'box-1', run_id: 'run-1', status: 'completed' },
    })).rejects.toThrow('nonce mismatch');
    await expect(store.applyCompletion({
      jobId: job.id,
      nonce: 'nonce_123456',
      payload: { box_id: 'box-2', run_id: 'run-1', status: 'completed' },
    })).rejects.toThrow('box ID mismatch');
  });

  it('consumes a late callback without reviving a canceled job', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    await store.cancel(job.id);

    const result = await store.applyCompletion({
      jobId: job.id,
      nonce: 'nonce_123456',
      payload: { box_id: 'box-1', run_id: 'run-1', status: 'completed', output: 'too late' },
    });

    expect(result).toMatchObject({ duplicate: false, late: true });
    expect(result.job.status).toBe('canceled');
    expect(result.job.result).toBeUndefined();
  });

  it('records provisioning failures and timeouts as explicit terminal reasons', async () => {
    const failedStore = new BoxJobStore(new FakeRedis());
    const failedJob = await createJob(failedStore);
    await failedStore.markProvisioning(failedJob.id);
    const failed = await failedStore.markFailed(failedJob.id, 'Box provisioning failed.');
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Box provisioning failed.',
      terminalReason: 'Box provisioning failed.',
    });

    const timedOutStore = new BoxJobStore(new FakeRedis());
    const timedOutJob = await createJob(timedOutStore);
    const timedOut = await timedOutStore.markTimedOut(timedOutJob.id);
    expect(timedOut.status).toBe('timed_out');
    expect(timedOut.terminalReason).toContain('time limit');
  });

  it('leases terminal delivery and permits a retry after a failed send', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    await store.markFailed(job.id, 'boom', 2_000);

    const first = await store.claimCompletionDelivery(job.id, 3_000);
    expect(first).not.toBeNull();
    await expect(store.claimCompletionDelivery(job.id, 3_100)).resolves.toBeNull();
    await store.releaseCompletionDelivery(job.id, first!.leaseId, 3_200);

    const retry = await store.claimCompletionDelivery(job.id, 3_300);
    expect(retry?.leaseId).not.toBe(first?.leaseId);
    await store.markCompletionDelivered(job.id, retry!.leaseId, 3_400);
    await expect(store.claimCompletionDelivery(job.id, 100_000)).resolves.toBeNull();
  });

  it('pauses for a nonce-bound protected action and resumes exactly once', async () => {
    const store = new BoxJobStore(new FakeRedis());
    const job = await createJob(store);
    await store.markProvisioning(job.id);
    await store.markRunning(job.id, 'box-1', 'run-1');
    const pending = {
      nonce: 'approval_nonce_123456', category: 'deployment', action: 'wrangler deploy',
      actionHash: 'a'.repeat(64), requestedAt: 3_000,
    };
    const marker = `BOX_APPROVAL_REQUIRED:${base64Url(JSON.stringify(pending))}`;
    const result = await store.applyCompletion({
      jobId: job.id, nonce: 'nonce_123456', now: 4_000,
      payload: { box_id: 'box-1', run_id: 'run-1', status: 'failed', error: marker },
    });
    expect(result.job).toMatchObject({ status: 'awaiting_approval', pendingApproval: { category: 'deployment', actionHash: 'a'.repeat(64) } });
    expect(result.approvalNonce).toBe('approval_nonce_123456');
    const delivery = await store.claimApprovalDelivery(job.id, 4_100);
    expect(delivery?.job.pendingApproval?.nonce).toBe('approval_nonce_123456');
    await expect(store.claimApprovalDelivery(job.id, 4_200)).resolves.toBeNull();
    await store.releaseApprovalDelivery(job.id, delivery!.leaseId, 4_300);
    const retry = await store.claimApprovalDelivery(job.id, 4_400);
    await store.markApprovalDelivered(job.id, retry!.leaseId, 4_500);
    await expect(store.claimApprovalDelivery(job.id, 4_600)).resolves.toBeNull();
    const resumed = await store.prepareApprovalResume({
      id: job.id, nonce: 'approval_nonce_123456', nextCallbackNonce: 'next_callback_123456', nextApprovalNonce: 'next_approval_123456', now: 5_000,
    });
    expect(resumed).toMatchObject({ status: 'running', approvalCount: 1, pendingApproval: undefined });
    await expect(store.prepareApprovalResume({
      id: job.id, nonce: 'nonce_123456', nextCallbackNonce: 'another_callback_123456', nextApprovalNonce: 'another_approval_123456', now: 5_100,
    })).rejects.toThrow('not awaiting');
  });
});

function base64Url(value: string): string {
  const binary = [...new TextEncoder().encode(value)].map(byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
