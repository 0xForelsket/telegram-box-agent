import { describe, expect, it } from 'vitest';
import { ArtifactStore, type BoxArtifact } from './artifact_store';

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

const JOB_ID = 'bj_abc123def456';
const UPLOAD_TOKEN = 'upload_token_1234567890';
const IDEMPOTENCY_KEY = 'a'.repeat(64);

function createStore() {
  const redis = new FakeRedis();
  return { redis, store: new ArtifactStore(redis) };
}

async function createArtifact(
  store: ArtifactStore,
  overrides: Partial<Parameters<ArtifactStore['create']>[0]> = {},
): Promise<BoxArtifact> {
  return await store.create({
    jobId: JOB_ID,
    chatId: -100123,
    userId: 'member_1',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    declaredSize: 2048,
    uploadToken: UPLOAD_TOKEN,
    uploadExpiresAt: 1_000 + 20 * 60_000,
    now: 1_000,
    ...overrides,
  });
}

describe('ArtifactStore.create', () => {
  it('stores an authorized artifact under a job-scoped R2 key', async () => {
    const { store } = createStore();

    const artifact = await createArtifact(store);

    expect(artifact.status).toBe('authorized');
    expect(artifact.id).toMatch(/^ba_[a-f0-9]{12}$/);
    expect(artifact.key).toBe(`jobs/${JOB_ID}/${artifact.id}/report.pdf`);
  });

  it('stores a SHA-256 hash of the upload token', async () => {
    const { redis, store } = createStore();

    const artifact = await createArtifact(store);
    const persisted = JSON.parse(redis.values.get(`box_artifact:v1:${artifact.id}`)!) as BoxArtifact;

    expect(persisted.uploadTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.uploadTokenValue).toBe(UPLOAD_TOKEN);
  });

  // Pins current behaviour rather than endorsing it. The raw token is kept at
  // rest so `authorizeUpload` can re-issue the identical token on an idempotent
  // retry (artifact_gateway.ts). The consequence is that `uploadTokenHash`
  // protects nothing while the token is live — only after `markUploaded`
  // clears the raw value, by which point the token is already spent.
  // If the gateway is changed to rotate the token on retry instead, this test
  // should be updated to assert the raw value is never persisted.
  it('also retains the raw token at rest until the upload completes', async () => {
    const { redis, store } = createStore();
    const artifact = await createArtifact(store);

    const authorized = redis.values.get(`box_artifact:v1:${artifact.id}`)!;
    expect(authorized).toContain(UPLOAD_TOKEN);

    await store.markUploaded(artifact.id, { actualSize: 2048, now: 5_000 });

    const uploaded = redis.values.get(`box_artifact:v1:${artifact.id}`)!;
    expect(uploaded).not.toContain(UPLOAD_TOKEN);
  });

  it('strips directory traversal out of the filename before it reaches the R2 key', async () => {
    const { store } = createStore();

    const artifact = await createArtifact(store, { filename: '../../../etc/passwd' });

    expect(artifact.filename).toBe('passwd');
    expect(artifact.key).toBe(`jobs/${JOB_ID}/${artifact.id}/passwd`);
    expect(artifact.key).not.toContain('..');
  });

  it('strips Windows-style separators and leading dots', async () => {
    const { store } = createStore();

    expect((await createArtifact(store, { filename: 'C:\\temp\\evil.exe' })).filename).toBe('evil.exe');
    expect((await createArtifact(store, { filename: '...hidden.txt' })).filename).toBe('hidden.txt');
  });

  it('replaces characters that do not belong in an object key', async () => {
    const { store } = createStore();

    const artifact = await createArtifact(store, { filename: 'a"b;c\nd.txt' });

    expect(artifact.filename).toBe('a_b_c_d.txt');
  });

  it('rejects a filename that sanitizes down to nothing', async () => {
    const { store } = createStore();

    await expect(createArtifact(store, { filename: '../..' })).rejects.toThrow('Invalid artifact filename');
  });

  it('falls back to a safe content type when the supplied one is malformed', async () => {
    const { store } = createStore();

    expect((await createArtifact(store, { contentType: 'not a mime type' })).contentType)
      .toBe('application/octet-stream');
    expect((await createArtifact(store, { contentType: 'TEXT/CSV' })).contentType).toBe('text/csv');
  });

  it('rejects a malformed job ID', async () => {
    const { store } = createStore();

    await expect(createArtifact(store, { jobId: 'no' })).rejects.toThrow('Invalid job ID');
  });

  it('rejects an upload token that is too short to be random', async () => {
    const { store } = createStore();

    await expect(createArtifact(store, { uploadToken: 'short' })).rejects.toThrow('Invalid artifact token');
  });
});

describe('ArtifactStore.verifyUploadToken', () => {
  it('accepts the matching token', async () => {
    const { store } = createStore();
    const artifact = await createArtifact(store);

    await expect(store.verifyUploadToken(artifact.id, UPLOAD_TOKEN)).resolves.toMatchObject({ id: artifact.id });
  });

  it('rejects a non-matching token', async () => {
    const { store } = createStore();
    const artifact = await createArtifact(store);

    await expect(store.verifyUploadToken(artifact.id, 'wrong_token_1234567890')).resolves.toBeNull();
  });

  it('returns null for an unknown artifact rather than throwing', async () => {
    const { store } = createStore();

    await expect(store.verifyUploadToken('ba_000000000000', UPLOAD_TOKEN)).resolves.toBeNull();
  });
});

describe('ArtifactStore idempotency', () => {
  it('resolves a prior artifact by its idempotency key', async () => {
    const { store } = createStore();
    const artifact = await createArtifact(store, { idempotencyKey: IDEMPOTENCY_KEY });

    const found = await store.getByIdempotencyKey(JOB_ID, IDEMPOTENCY_KEY);

    expect(found?.id).toBe(artifact.id);
  });

  it('does not leak an idempotency key across jobs', async () => {
    const { store } = createStore();
    await createArtifact(store, { idempotencyKey: IDEMPOTENCY_KEY });

    await expect(store.getByIdempotencyKey('bj_999999999999', IDEMPOTENCY_KEY)).resolves.toBeNull();
  });

  it('rejects a malformed idempotency key', async () => {
    const { store } = createStore();

    await expect(store.getByIdempotencyKey(JOB_ID, 'nope')).rejects.toThrow('Invalid artifact idempotency key');
  });
});

describe('ArtifactStore.markUploaded', () => {
  it('records the uploaded size and clears the raw token', async () => {
    const { store } = createStore();
    const artifact = await createArtifact(store);

    const uploaded = await store.markUploaded(artifact.id, { actualSize: 2048, etag: 'etag-1', now: 5_000 });

    expect(uploaded.status).toBe('uploaded');
    expect(uploaded.actualSize).toBe(2048);
    expect(uploaded.uploadedAt).toBe(5_000);
    expect(uploaded.uploadTokenValue).toBeUndefined();
  });

  it('is idempotent — a second call keeps the first result', async () => {
    const { store } = createStore();
    const artifact = await createArtifact(store);
    await store.markUploaded(artifact.id, { actualSize: 2048, now: 5_000 });

    const again = await store.markUploaded(artifact.id, { actualSize: 9999, now: 9_000 });

    expect(again.actualSize).toBe(2048);
    expect(again.uploadedAt).toBe(5_000);
  });

  it('throws for an unknown artifact', async () => {
    const { store } = createStore();

    await expect(store.markUploaded('ba_000000000000', { actualSize: 1 })).rejects.toThrow('not found');
  });
});

describe('ArtifactStore Telegram delivery leases', () => {
  async function uploadedArtifact() {
    const { redis, store } = createStore();
    const artifact = await createArtifact(store);
    await store.markUploaded(artifact.id, { actualSize: 2048, now: 5_000 });
    return { redis, store, id: artifact.id };
  }

  it('claims delivery exactly once while the lease is live', async () => {
    const { store, id } = await uploadedArtifact();

    const first = await store.claimTelegramDelivery(id, 10_000);
    const second = await store.claimTelegramDelivery(id, 10_000);

    expect(first?.leaseId).toBeTruthy();
    expect(second).toBeNull();
  });

  it('lets a later caller reclaim once the lease has expired', async () => {
    const { store, id } = await uploadedArtifact();
    await store.claimTelegramDelivery(id, 10_000, 60_000);

    const reclaimed = await store.claimTelegramDelivery(id, 10_000 + 60_001, 60_000);

    expect(reclaimed?.leaseId).toBeTruthy();
  });

  it('refuses to claim an artifact that was never uploaded', async () => {
    const { store } = createStore();
    const artifact = await createArtifact(store);

    await expect(store.claimTelegramDelivery(artifact.id, 10_000)).resolves.toBeNull();
  });

  it('refuses to claim an already-delivered artifact', async () => {
    const { store, id } = await uploadedArtifact();
    const claim = await store.claimTelegramDelivery(id, 10_000);
    await store.markTelegramDelivered(id, claim!.leaseId, 11_000);

    await expect(store.claimTelegramDelivery(id, 12_000)).resolves.toBeNull();
  });

  it('rejects a delivery confirmation carrying the wrong lease', async () => {
    const { store, id } = await uploadedArtifact();
    await store.claimTelegramDelivery(id, 10_000);

    await expect(store.markTelegramDelivered(id, 'not-the-lease', 11_000))
      .rejects.toThrow('delivery lease mismatch');
  });

  it('treats a repeated delivery confirmation as a no-op', async () => {
    const { store, id } = await uploadedArtifact();
    const claim = await store.claimTelegramDelivery(id, 10_000);
    await store.markTelegramDelivered(id, claim!.leaseId, 11_000);

    const again = await store.markTelegramDelivered(id, 'any-lease-now', 12_000);

    expect(again.telegramDeliveredAt).toBe(11_000);
  });

  it('releases a lease so another attempt can claim it', async () => {
    const { store, id } = await uploadedArtifact();
    const claim = await store.claimTelegramDelivery(id, 10_000);

    await store.releaseTelegramDelivery(id, claim!.leaseId);

    await expect(store.claimTelegramDelivery(id, 10_500)).resolves.not.toBeNull();
  });

  it('ignores a release carrying a stale lease id', async () => {
    const { store, id } = await uploadedArtifact();
    await store.claimTelegramDelivery(id, 10_000);

    await store.releaseTelegramDelivery(id, 'stale-lease');

    await expect(store.claimTelegramDelivery(id, 10_500)).resolves.toBeNull();
  });
});

describe('ArtifactStore.listForJob', () => {
  it('returns a job\'s artifacts oldest first', async () => {
    const { store } = createStore();
    const second = await createArtifact(store, { filename: 'b.pdf', now: 2_000 });
    const first = await createArtifact(store, { filename: 'a.pdf', now: 1_000 });

    const listed = await store.listForJob(JOB_ID);

    expect(listed.map(artifact => artifact.id)).toEqual([first.id, second.id]);
  });

  it('honours the requested limit', async () => {
    const { store } = createStore();
    await createArtifact(store, { now: 1_000 });
    await createArtifact(store, { now: 2_000 });

    expect(await store.listForJob(JOB_ID, 1)).toHaveLength(1);
  });

  it('returns nothing for a job with no artifacts', async () => {
    const { store } = createStore();

    await expect(store.listForJob('bj_111111111111')).resolves.toEqual([]);
  });

  it('skips records that fail to parse', async () => {
    const { redis, store } = createStore();
    const artifact = await createArtifact(store);
    redis.values.set(`box_artifact:v1:${artifact.id}`, 'not json');

    await expect(store.listForJob(JOB_ID)).resolves.toEqual([]);
  });
});

describe('ArtifactStore.get', () => {
  it('returns null for corrupt JSON instead of throwing', async () => {
    const { redis, store } = createStore();
    const artifact = await createArtifact(store);
    redis.values.set(`box_artifact:v1:${artifact.id}`, '{oops');

    await expect(store.get(artifact.id)).resolves.toBeNull();
  });

  it('returns null for a record with an unrecognised status', async () => {
    const { redis, store } = createStore();
    const artifact = await createArtifact(store);
    redis.values.set(`box_artifact:v1:${artifact.id}`, JSON.stringify({ ...artifact, status: 'bogus' }));

    await expect(store.get(artifact.id)).resolves.toBeNull();
  });

  it('rejects a malformed artifact ID', async () => {
    const { store } = createStore();

    await expect(store.get('../../etc/passwd')).rejects.toThrow('Invalid artifact ID');
  });
});
