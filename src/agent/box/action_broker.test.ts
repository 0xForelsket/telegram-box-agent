import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import { ActionBroker } from './action_broker';
import { ActionStore } from './action_store';
import { BoxJobStore } from './box_job_store';
import { hashAction, parseActionRequest } from './action_catalog';

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

const now = 1_000_000;
const SESSION_TOKEN = 'artifact_session_token_abcdef';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'telegram-token', WHITELISTED_USERS: 'owner', OWNER_USER_ID: 'owner',
    SYSTEM_INIT_MESSAGE: 'test', SYSTEM_INIT_MESSAGE_ROLE: 'system',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4',
    GOOGLE_MODEL_KEY: 'google-key', GOOGLE_MODELS: 'gemini-test', GROQ_API_KEY: '', GROQ_MODELS: '',
    CLAUDE_API_KEY: '', CLAUDE_MODELS: '', AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
    ACTION_BROKER_ENABLED: 'true', ACTION_BROKER_GITHUB_REPOS: 'acme/widgets',
    GITHUB_TOKEN: 'github-pat-secret',
    ...overrides,
  };
}

async function createHarness(overrides: Partial<Env> = {}) {
  const redis = new FakeRedis() as unknown as RedisClient;
  const jobs = new BoxJobStore(redis);
  const job = await jobs.create({
    chatId: -100, userId: 'member', sessionKey: 'group:-100', request: 'file a bug',
    route: 'deepseek', model: 'deepseek/deepseek-v4-flash',
    callbackNonce: 'callback-nonce-value', artifactSessionToken: SESSION_TOKEN, now,
  });
  await jobs.markProvisioning(job.id, now);
  await jobs.markRunning(job.id, 'box-1', 'run-1', now);

  const sendMessage = vi.fn(async (_chatId: number, _text: string) => undefined);
  const fetchImpl = vi.fn(async () => new Response(
    JSON.stringify({ html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }),
    { status: 201 },
  )) as unknown as typeof fetch;
  const broker = new ActionBroker(createEnv(overrides), redis, {
    store: new ActionStore(redis), jobs, sendMessage, fetchImpl, now: () => now,
  });
  return { redis, jobs, job, broker, sendMessage, fetchImpl };
}

function requestFor(jobId: string, body: unknown, token = SESSION_TOKEN): Request {
  return new Request('https://worker.example/box/actions/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Box-Job-Id': jobId },
    body: JSON.stringify(body),
  });
}

const COMMENT = {
  action: 'github.issue_comment',
  params: { owner: 'acme', repo: 'widgets', issue_number: 7, body: 'Reproduced on main.' },
};

/** Pulls the approval nonce out of the Telegram message the owner receives. */
function nonceFrom(sendMessage: ReturnType<typeof vi.fn>): string {
  const text = String(sendMessage.mock.calls.at(-1)?.[1] ?? '');
  return text.match(/\/action approve \S+ (\S+)/)?.[1] ?? '';
}

describe('ActionBroker request', () => {
  it('records a pending action and asks the owner to approve it', async () => {
    const { broker, job, sendMessage, fetchImpl } = await createHarness();

    const response = await broker.handleRequest(requestFor(job.id, COMMENT));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'pending' });
    expect(sendMessage).toHaveBeenCalledOnce();
    // Nothing reaches GitHub before the owner has said yes.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shows the owner the exact effect, not just the action name', async () => {
    const { broker, job, sendMessage } = await createHarness();

    await broker.handleRequest(requestFor(job.id, COMMENT));

    const text = String(sendMessage.mock.calls[0][1]);
    expect(text).toContain('acme/widgets#7');
    expect(text).toContain('Reproduced on main.');
  });

  it('refuses a repository outside the configured allowlist', async () => {
    const { broker, job, sendMessage } = await createHarness();

    const response = await broker.handleRequest(requestFor(job.id, {
      ...COMMENT,
      params: { ...COMMENT.params, owner: 'attacker', repo: 'elsewhere' },
    }));

    expect(response.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // An unset allowlist that permitted everything would be worse than no broker,
  // because it would look like a boundary while being none.
  it('permits nothing when no allowlist is configured', async () => {
    const { broker, job } = await createHarness({ ACTION_BROKER_GITHUB_REPOS: '' });

    expect((await broker.handleRequest(requestFor(job.id, COMMENT))).status).toBe(403);
  });

  it('rejects an unknown action name', async () => {
    const { broker, job } = await createHarness();

    const response = await broker.handleRequest(requestFor(job.id, { action: 'shell.exec', params: { cmd: 'rm -rf /' } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Unknown') });
  });

  it('rejects a request authenticated with the wrong session token', async () => {
    const { broker, job } = await createHarness();

    expect((await broker.handleRequest(requestFor(job.id, COMMENT, 'wrong_token_value_here'))).status).toBe(401);
  });

  it('is unavailable while the broker is disabled', async () => {
    const { broker, job } = await createHarness({ ACTION_BROKER_ENABLED: 'false' });

    expect((await broker.handleRequest(requestFor(job.id, COMMENT))).status).toBe(503);
  });

  it('caps the number of approvals one job can have outstanding', async () => {
    const { broker, job } = await createHarness();
    for (let index = 0; index < 3; index++) {
      await broker.handleRequest(requestFor(job.id, {
        ...COMMENT,
        params: { ...COMMENT.params, body: `Note ${index}` },
      }));
    }

    expect((await broker.handleRequest(requestFor(job.id, COMMENT))).status).toBe(429);
  });
});

describe('ActionBroker approval', () => {
  async function pending() {
    const harness = await createHarness();
    const response = await harness.broker.handleRequest(requestFor(harness.job.id, COMMENT));
    const { actionId } = await response.json() as { actionId: string };
    return { ...harness, actionId, nonce: nonceFrom(harness.sendMessage) };
  }

  it('executes the approved write with the Worker\'s own credential', async () => {
    const { broker, actionId, nonce, fetchImpl } = await pending();

    const record = await broker.approve({ chatId: -100, ownerUserId: 'owner', actionId, nonce });

    expect(record.status).toBe('executed');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.github.com/repos/acme/widgets/issues/7/comments');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: 'Reproduced on main.' });
  });

  // The whole point of the broker: the sandbox is not in the execution path, so
  // it has no opportunity to substitute different parameters after approval.
  it('executes the stored parameters, which the Box cannot influence after approval', async () => {
    const { broker, actionId, nonce, fetchImpl } = await pending();
    const tampered = parseActionRequest({ ...COMMENT, params: { ...COMMENT.params, body: 'Something else entirely' } });

    await broker.approve({ chatId: -100, ownerUserId: 'owner', actionId, nonce });

    const body = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body.body).toBe('Reproduced on main.');
    expect(await hashAction(tampered)).not.toBe(await hashAction(parseActionRequest(COMMENT)));
  });

  it('never lets the credential reach the Box result endpoint', async () => {
    const { broker, job, actionId, nonce } = await pending();
    await broker.approve({ chatId: -100, ownerUserId: 'owner', actionId, nonce });

    const result = await broker.handleResult(new Request(
      `https://worker.example/box/actions/result?id=${actionId}`,
      { headers: { Authorization: `Bearer ${SESSION_TOKEN}`, 'X-Box-Job-Id': job.id } },
    ));

    expect(JSON.stringify(await result.json())).not.toContain('github-pat-secret');
  });

  it('refuses approval from anyone but the owner', async () => {
    const { broker, actionId, nonce, fetchImpl } = await pending();

    await expect(broker.approve({ chatId: -100, ownerUserId: 'member', actionId, nonce }))
      .rejects.toThrow('Only the bot owner');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a mismatched approval nonce', async () => {
    const { broker, actionId, fetchImpl } = await pending();

    await expect(broker.approve({ chatId: -100, ownerUserId: 'owner', actionId, nonce: 'b'.repeat(32) }))
      .rejects.toThrow('does not match');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('executes an approved action exactly once', async () => {
    const { broker, actionId, nonce, fetchImpl } = await pending();

    await broker.approve({ chatId: -100, ownerUserId: 'owner', actionId, nonce });
    await expect(broker.approve({ chatId: -100, ownerUserId: 'owner', actionId, nonce }))
      .rejects.toThrow('already executed');

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refuses approval from a different chat', async () => {
    const { broker, actionId, nonce } = await pending();

    await expect(broker.approve({ chatId: -999, ownerUserId: 'owner', actionId, nonce }))
      .rejects.toThrow('not found in this chat');
  });

  it('records a denial without executing anything', async () => {
    const { broker, actionId, fetchImpl } = await pending();

    const record = await broker.deny({ chatId: -100, ownerUserId: 'owner', actionId });

    expect(record.status).toBe('denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces an upstream failure without marking the write as done', async () => {
    const harness = await createHarness();
    const response = await harness.broker.handleRequest(requestFor(harness.job.id, COMMENT));
    const { actionId } = await response.json() as { actionId: string };
    (harness.fetchImpl as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));

    const record = await harness.broker.approve({
      chatId: -100, ownerUserId: 'owner', actionId, nonce: nonceFrom(harness.sendMessage),
    });

    expect(record.status).toBe('failed');
    expect(record.error).toContain('404');
  });
});

describe('ActionBroker result polling', () => {
  it('refuses to reveal an action belonging to another job', async () => {
    const { broker, job, redis, jobs } = await createHarness();
    const response = await broker.handleRequest(requestFor(job.id, COMMENT));
    const { actionId } = await response.json() as { actionId: string };
    const other = await jobs.create({
      chatId: -100, userId: 'member', sessionKey: 'group:-100', request: 'other',
      route: 'deepseek', model: 'deepseek/deepseek-v4-flash',
      callbackNonce: 'other-callback-nonce', artifactSessionToken: 'other_session_token_abcdef', now,
    });
    void redis;

    const result = await broker.handleResult(new Request(
      `https://worker.example/box/actions/result?id=${actionId}`,
      { headers: { Authorization: 'Bearer other_session_token_abcdef', 'X-Box-Job-Id': other.id } },
    ));

    expect(result.status).toBe(404);
  });
});

describe('action catalog validation', () => {
  it('strips unexpected keys rather than passing them through', () => {
    const parsed = parseActionRequest({
      action: 'github.create_issue',
      params: { owner: 'acme', repo: 'widgets', title: 'Bug', body: 'Details', labels: ['urgent'] },
    });

    expect(Object.keys(parsed.params).sort()).toEqual(['body', 'owner', 'repo', 'title']);
  });

  // A slug that could carry a path segment would let the executor's URL be
  // redirected to an endpoint the owner never saw.
  it('rejects a repository name that would escape the API path', () => {
    expect(() => parseActionRequest({
      action: 'github.create_issue',
      params: { owner: 'acme', repo: '../../orgs/evil', title: 'x', body: 'y' },
    })).toThrow('not a valid GitHub name');
  });

  it('produces a stable fingerprint regardless of key order', async () => {
    const left = await hashAction(parseActionRequest(COMMENT));
    const right = await hashAction(parseActionRequest({
      action: 'github.issue_comment',
      params: { body: 'Reproduced on main.', issue_number: 7, repo: 'widgets', owner: 'acme' },
    }));

    expect(left).toBe(right);
  });

  it('changes the fingerprint when any parameter changes', async () => {
    const left = await hashAction(parseActionRequest(COMMENT));
    const right = await hashAction(parseActionRequest({
      ...COMMENT,
      params: { ...COMMENT.params, issue_number: 8 },
    }));

    expect(left).not.toBe(right);
  });
});
