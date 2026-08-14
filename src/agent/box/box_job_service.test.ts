import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import { createBoxCallbackAuthorization } from './callback_auth';
import type { LaunchPiBoxJobInput } from './box_launcher';
import { BoxJobService } from './box_job_service';
import { BoxJobStore } from './box_job_store';
import { ArtifactStore } from './artifact_store';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly sorted = new Map<string, Array<{ score: number; member: string }>>();

  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async getMany(keys: string[]): Promise<Array<string | null>> { return keys.map(key => this.values.get(key) ?? null); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async zadd(key: string, score: number, member: string): Promise<void> {
    const entries = this.sorted.get(key) ?? [];
    entries.push({ score, member });
    entries.sort((left, right) => left.score - right.score);
    this.sorted.set(key, entries);
  }
  async zrangeAll(key: string, limit = 200): Promise<string[]> {
    return (this.sorted.get(key) ?? []).slice(0, limit).map(entry => entry.member);
  }
  async withLock<T>(_scope: string, action: () => Promise<T>): Promise<T> { return await action(); }
}

const callbackSecret = 'box-callback-secret-that-is-definitely-long-enough';
const now = 1_000_000;

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'telegram-token', WHITELISTED_USERS: 'owner,member', OWNER_USER_ID: 'owner',
    SYSTEM_INIT_MESSAGE: 'test', SYSTEM_INIT_MESSAGE_ROLE: 'system', DEFAULT_MODEL: 'gemini-test',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4',
    GOOGLE_MODEL_KEY: 'google-key', GOOGLE_MODELS: 'gemini-test', GROQ_API_KEY: '', GROQ_MODELS: '',
    CLAUDE_API_KEY: '', CLAUDE_MODELS: '', AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
    BOX_AGENT_ENABLED: 'true', BOX_ALLOW_GROUP_MEMBERS: 'true', UPSTASH_BOX_API_KEY: 'box-key',
    BOX_CALLBACK_URL: 'https://worker.example/box/callback', BOX_CALLBACK_SECRET: callbackSecret,
    DEEPSEEK_API_KEY: 'deepseek-key', ZAI_CODING_PLAN_API_KEY: 'zai-key',
    ...overrides,
  };
}

function createHarness(overrides: Partial<Env> = {}) {
  const redis = new FakeRedis();
  const store = new BoxJobStore(redis as unknown as RedisClient);
  const launches: LaunchPiBoxJobInput[] = [];
  const launchJob = vi.fn(async (input: LaunchPiBoxJobInput) => {
    launches.push(input);
    return { boxId: 'box-1', runId: 'run-1', route: input.route.route, model: input.route.model };
  });
  const sendMessage = vi.fn(async () => undefined);
  const editMessage = vi.fn(async () => undefined);
  const sendDocument = vi.fn(async () => undefined);
  const deleteBox = vi.fn(async () => undefined);
  const resumeJob = vi.fn(async () => 'run-2');
  let clock = now;
  const service = new BoxJobService(createEnv(overrides), redis as unknown as RedisClient, {
    store, launchJob, sendMessage, editMessage, sendDocument, deleteBox, resumeJob, now: () => clock,
  });
  return {
    redis, store, launches, launchJob, sendMessage, editMessage, sendDocument,
    deleteBox, resumeJob, service,
    advance: (ms: number) => { clock += ms; },
  };
}

function progressRequest(jobId: string, token: string, step: string): Request {
  return new Request('https://worker.example/box/progress', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Box-Job-Id': jobId,
    },
    body: JSON.stringify({ step }),
  });
}

describe('BoxJobService', () => {
  it('defaults Box execution to the owner unless trusted group access is explicitly enabled', async () => {
    const ownerOnly = createHarness({ BOX_ALLOW_GROUP_MEMBERS: 'false' });
    await ownerOnly.service.bindChat(-100, 'group:-100');
    await expect(ownerOnly.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'make a PDF',
    })).rejects.toThrow('owner-only');
    await expect(ownerOnly.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'owner', request: 'make a PDF',
    })).resolves.toMatchObject({ job: { userId: 'owner' } });
  });

  it('requires the feature flag and owner group binding before queueing', async () => {
    const disabled = createHarness({ BOX_AGENT_ENABLED: 'false' });
    await expect(disabled.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'make a PDF',
    })).rejects.toThrow('disabled');

    const enabled = createHarness();
    await expect(enabled.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'make a PDF',
    })).rejects.toThrow('not bound');
    await enabled.service.bindChat(-100, 'group:-100');
    await expect(enabled.service.queue({
      chatId: -200, sessionKey: 'group:-200', userId: 'member', request: 'make a PDF',
    })).rejects.toThrow('bound Telegram group');
  });

  it('queues, provisions, authenticates completion, delivers once, and cleans up once', async () => {
    const harness = createHarness();
    await harness.service.bindChat(-100, 'group:-100');
    const queued = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'make a PDF',
    });
    expect(queued.job).toMatchObject({ status: 'queued', route: 'deepseek' });
    await queued.provision();
    expect((await harness.store.get(queued.job.id))?.status).toBe('running');

    const webhook = harness.launches[0].webhook;
    const body = JSON.stringify({ box_id: 'box-1', run_id: 'run-1', status: 'completed', output: 'PDF ready' });
    const request = new Request(webhook.url, { method: 'POST', headers: webhook.headers, body });
    const response = await harness.service.handleCompletion(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: false, late: false });
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.deleteBox).toHaveBeenCalledTimes(1);

    const duplicate = await harness.service.handleCompletion(new Request(webhook.url, {
      method: 'POST', headers: webhook.headers, body,
    }));
    expect(duplicate.status).toBe(200);
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.deleteBox).toHaveBeenCalledTimes(1);
  });

  it('rejects forged callbacks and retries delivery after a transient Telegram failure', async () => {
    const harness = createHarness();
    await harness.service.bindChat(-100, 'group:-100');
    const queued = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'run analysis',
    });
    await queued.provision();
    const signedHeaders = new Headers(harness.launches[0].webhook.headers);
    const forged = new Headers(signedHeaders);
    forged.set('X-Box-Callback-Signature', '00'.repeat(32));
    const body = JSON.stringify({ box_id: 'box-1', run_id: 'run-1', status: 'completed', output: 'done' });
    expect((await harness.service.handleCompletion(new Request('https://worker.example/box/callback', {
      method: 'POST', headers: forged, body,
    }))).status).toBe(401);

    harness.sendMessage.mockRejectedValueOnce(new Error('Telegram unavailable'));
    const first = await harness.service.handleCompletion(new Request('https://worker.example/box/callback', {
      method: 'POST', headers: signedHeaders, body,
    }));
    expect(first.status).toBe(409);
    const retry = await harness.service.handleCompletion(new Request('https://worker.example/box/callback', {
      method: 'POST', headers: signedHeaders, body,
    }));
    expect(retry.status).toBe(200);
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('retries an approval notice without duplicates and resumes only for the owner nonce', async () => {
    const harness = createHarness();
    await harness.service.bindChat(-100, 'group:-100');
    const queued = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'deploy the approved build',
    });
    await queued.provision();
    const pending = {
      nonce: harness.launches[0].approvalNonce,
      category: 'deployment',
      action: 'wrangler deploy',
      actionHash: 'a'.repeat(64),
      requestedAt: now,
    };
    const body = JSON.stringify({
      box_id: 'box-1', run_id: 'run-1', status: 'failed',
      error: `BOX_APPROVAL_REQUIRED:${base64Url(JSON.stringify(pending))}`,
    });
    const webhook = harness.launches[0].webhook;
    harness.sendMessage.mockRejectedValueOnce(new Error('Telegram unavailable'));
    expect((await harness.service.handleCompletion(new Request(webhook.url, { method: 'POST', headers: webhook.headers, body }))).status).toBe(409);
    expect((await harness.service.handleCompletion(new Request(webhook.url, { method: 'POST', headers: webhook.headers, body }))).status).toBe(200);
    expect((await harness.service.handleCompletion(new Request(webhook.url, { method: 'POST', headers: webhook.headers, body }))).status).toBe(200);
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    await expect(harness.service.approve(-100, 'member', queued.job.id, pending.nonce)).rejects.toThrow('bot owner');
    await expect(harness.service.approve(-100, 'owner', queued.job.id, 'wrong_nonce_123456')).rejects.toThrow('Invalid');
    await expect(harness.service.approve(-100, 'owner', queued.job.id, pending.nonce)).resolves.toMatchObject({ status: 'running', runId: 'run-2' });
    expect(harness.resumeJob).toHaveBeenCalledTimes(1);
  });

  it('restricts GLM to the owner and allows members to cancel only their own jobs', async () => {
    const harness = createHarness();
    await harness.service.bindChat(-100, 'group:-100');
    await expect(harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'code', requestedRoute: 'glm',
    })).rejects.toThrow('restricted to the bot owner');

    const queued = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'owner', request: 'code', requestedRoute: 'glm',
    });
    await expect(harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'owner', request: 'prepare a travel itinerary', requestedRoute: 'glm',
    })).rejects.toThrow('coding-agent tasks');
    await expect(harness.service.cancel(-100, 'member', false, queued.job.id)).rejects.toThrow('your own');
    await expect(harness.service.cancel(-100, 'owner', true, queued.job.id)).resolves.toMatchObject({ status: 'canceled' });
  });

  it('limits members to their own status while the owner can inspect all group jobs', async () => {
    const harness = createHarness();
    await harness.service.bindChat(-100, 'group:-100');
    const memberJob = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'member task',
    });
    const ownerJob = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'owner', request: 'owner task',
    });
    await expect(harness.service.getStatus(-100, 'member', false, ownerJob.job.id))
      .rejects.toThrow('your own');
    await expect(harness.service.getStatus(-100, 'member', false)).resolves.toEqual([memberJob.job]);
    await expect(harness.service.getStatus(-100, 'owner', true)).resolves.toHaveLength(2);
  });

  it('enforces two active group jobs and five starts per user per Kuala Lumpur day', async () => {
    const concurrency = createHarness();
    await concurrency.service.bindChat(-100, 'group:-100');
    await concurrency.service.queue({ chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'one' });
    await concurrency.service.queue({ chatId: -100, sessionKey: 'group:-100', userId: 'owner', request: 'two' });
    await expect(concurrency.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'three',
    })).rejects.toThrow('2 active');

    const quota = createHarness();
    await quota.service.bindChat(-100, 'group:-100');
    for (let index = 0; index < 5; index++) {
      const queued = await quota.service.queue({
        chatId: -100, sessionKey: 'group:-100', userId: 'member', request: `task ${index}`,
      });
      await quota.service.cancel(-100, 'member', false, queued.job.id);
    }
    await expect(quota.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'sixth',
    })).rejects.toThrow('daily limit of 5');
  });

  it('rejects a correctly signed callback for an unknown job', async () => {
    const harness = createHarness();
    const authorization = await createBoxCallbackAuthorization({
      url: 'https://worker.example/box/callback', secret: callbackSecret,
      jobId: 'bj_unknown123', nonce: 'nonce_123456', now,
    });
    const response = await harness.service.handleCompletion(new Request(authorization.url, {
      method: 'POST', headers: authorization.headers,
      body: JSON.stringify({ box_id: 'box-1', status: 'completed' }),
    }));
    expect(response.status).toBe(404);
  });

  it('delivers small artifacts through Telegram and large artifacts by link only', async () => {
    const harness = createHarness({ ARTIFACT_BUCKET: {} as R2Bucket });
    const artifacts = new ArtifactStore(harness.redis as unknown as RedisClient);
    await harness.service.bindChat(-100, 'group:-100');
    const queued = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'member', request: 'make reports',
    });
    await queued.provision();
    expect(harness.launches[0].artifactSession).toMatchObject({
      authorizeUrl: 'https://worker.example/box/artifacts/authorize',
    });
    const small = await artifacts.create({
      jobId: queued.job.id, chatId: -100, userId: 'member', filename: 'small.pdf', contentType: 'application/pdf',
      declaredSize: 1024, uploadToken: 'small_upload_token_123456', uploadExpiresAt: now + 1000, now,
    });
    await artifacts.markUploaded(small.id, { actualSize: 1024, now });
    const large = await artifacts.create({
      jobId: queued.job.id, chatId: -100, userId: 'member', filename: 'large.zip', contentType: 'application/zip',
      declaredSize: 50 * 1024 * 1024 + 1, uploadToken: 'large_upload_token_123456', uploadExpiresAt: now + 1000, now,
    });
    await artifacts.markUploaded(large.id, { actualSize: 50 * 1024 * 1024 + 1, now });

    const webhook = harness.launches[0].webhook;
    const response = await harness.service.handleCompletion(new Request(webhook.url, {
      method: 'POST', headers: webhook.headers,
      body: JSON.stringify({ box_id: 'box-1', run_id: 'run-1', status: 'completed', output: 'reports ready' }),
    }));
    expect(response.status).toBe(200);
    expect(harness.sendDocument).toHaveBeenCalledTimes(1);
    expect(harness.sendDocument).toHaveBeenCalledWith(-100, expect.stringContaining(`/artifacts/${small.id}?`), 'small.pdf', expect.any(String));
    expect(harness.sendMessage.mock.calls.some(call => String((call as unknown[])[1]).includes(large.id))).toBe(true);
    expect((await harness.store.get(queued.job.id))?.artifactIds).toEqual([small.id, large.id]);

    await harness.service.handleCompletion(new Request(webhook.url, {
      method: 'POST', headers: webhook.headers,
      body: JSON.stringify({ box_id: 'box-1', run_id: 'run-1', status: 'completed', output: 'reports ready' }),
    }));
    expect(harness.sendDocument).toHaveBeenCalledTimes(1);
  });
});

function base64Url(value: string): string {
  const binary = [...new TextEncoder().encode(value)].map(byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('BoxJobService progress', () => {
  async function runningJob() {
    const harness = createHarness();
    await harness.service.bindChat(-100, 'group:-100');
    const queued = await harness.service.queue({
      chatId: -100, sessionKey: 'group:-100', userId: 'owner', request: 'Build a PDF report',
    });
    await queued.provision();
    const token = harness.launches[0].progressSession!.token;
    await harness.service.attachProgressMessage(queued.job.id, 4242, 'Queued Box job.');
    return { harness, jobId: queued.job.id, token };
  }

  it('gives the Box a progress endpoint scoped to its own job', async () => {
    const { harness, jobId } = await runningJob();

    expect(harness.launches[0].progressSession).toMatchObject({
      url: 'https://worker.example/box/progress',
    });
    expect(await harness.store.verifyArtifactSession(jobId, harness.launches[0].progressSession!.token))
      .not.toBeNull();
  });

  it('edits the acknowledgement message rather than sending a new one', async () => {
    const { harness, jobId, token } = await runningJob();
    harness.sendMessage.mockClear();

    const response = await harness.service.handleProgress(progressRequest(jobId, token, 'step 1 · bash'));

    expect(response.status).toBe(200);
    expect(harness.editMessage).toHaveBeenCalledWith(-100, 4242, expect.stringContaining('step 1 · bash'));
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  // An agent in a tight tool loop must not translate into one Telegram edit per
  // tool call; the Worker, not the Box, decides how often an edit happens.
  it('throttles updates that arrive too close together', async () => {
    const { harness, jobId, token } = await runningJob();

    await harness.service.handleProgress(progressRequest(jobId, token, 'step 1 · bash'));
    const throttled = await harness.service.handleProgress(progressRequest(jobId, token, 'step 2 · read'));

    expect(await throttled.json()).toMatchObject({ throttled: true });
    expect(harness.editMessage).toHaveBeenCalledOnce();

    harness.advance(10_000);
    await harness.service.handleProgress(progressRequest(jobId, token, 'step 3 · write'));

    expect(harness.editMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects progress signed with another job\'s session token', async () => {
    const { harness, jobId } = await runningJob();

    const response = await harness.service.handleProgress(
      progressRequest(jobId, 'a'.repeat(32), 'step 1 · bash'),
    );

    expect(response.status).toBe(401);
    expect(harness.editMessage).not.toHaveBeenCalled();
  });

  it('rejects a malformed progress payload', async () => {
    const { harness, jobId, token } = await runningJob();

    const response = await harness.service.handleProgress(
      new Request('https://worker.example/box/progress', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Box-Job-Id': jobId },
        body: JSON.stringify({ step: '' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('ignores progress for a job that already reached a terminal state', async () => {
    const { harness, jobId, token } = await runningJob();
    await harness.service.cancel(-100, 'owner', true, jobId);
    harness.editMessage.mockClear();

    const response = await harness.service.handleProgress(progressRequest(jobId, token, 'step 1 · bash'));

    expect(await response.json()).toMatchObject({ throttled: true });
    expect(harness.editMessage).not.toHaveBeenCalled();
  });
});
