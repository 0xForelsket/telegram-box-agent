import { describe, expect, it } from 'vitest';
import type { Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import { ArtifactGateway, MAX_ARTIFACT_BYTES } from './artifact_gateway';
import { ArtifactStore, type BoxArtifact } from './artifact_store';
import { BoxJobStore } from './box_job_store';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly sorted = new Map<string, Array<{ score: number; member: string }>>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async getMany(keys: string[]): Promise<Array<string | null>> { return keys.map(key => this.values.get(key) ?? null); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async zadd(key: string, score: number, member: string): Promise<void> {
    const values = this.sorted.get(key) ?? [];
    values.push({ score, member });
    values.sort((a, b) => a.score - b.score);
    this.sorted.set(key, values);
  }
  async zrangeAll(key: string, limit = 200): Promise<string[]> {
    return (this.sorted.get(key) ?? []).slice(0, limit).map(value => value.member);
  }
  async withLock<T>(_scope: string, action: () => Promise<T>): Promise<T> { return await action(); }
}

class FakeR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string; etag: string }>();
  puts = 0;

  async put(key: string, value: ReadableStream, options?: R2PutOptions): Promise<R2Object> {
    this.puts += 1;
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const etag = `etag-${this.puts}`;
    this.objects.set(key, { bytes, contentType: options?.httpMetadata && 'contentType' in options.httpMetadata ? options.httpMetadata.contentType : undefined, etag });
    return this.object(key, false)!;
  }

  async get(key: string): Promise<R2ObjectBody | null> { return this.object(key, true) as R2ObjectBody | null; }
  async head(key: string): Promise<R2Object | null> { return this.object(key, false); }
  async delete(key: string): Promise<void> { this.objects.delete(key); }

  private object(key: string, body: boolean): R2ObjectBody | R2Object | null {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key, version: '1', size: stored.bytes.byteLength, etag: stored.etag,
      httpEtag: `"${stored.etag}"`, uploaded: new Date(), checksums: {},
      writeHttpMetadata(headers: Headers) { if (stored.contentType) headers.set('Content-Type', stored.contentType); },
      ...(body ? { body: new Blob([stored.bytes]).stream(), bodyUsed: false, arrayBuffer: async () => stored.bytes.buffer, text: async () => new TextDecoder().decode(stored.bytes), json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)), blob: async () => new Blob([stored.bytes]) } : {}),
    } as unknown as R2ObjectBody | R2Object;
  }
}

const secret = 'artifact-signing-root-secret-that-is-long-enough';
const sessionToken = 'artifact_session_token_1234567890';
const idempotencyKey = 'a'.repeat(64);

async function setup() {
  const redis = new FakeRedis();
  const bucket = new FakeR2();
  const jobs = new BoxJobStore(redis as unknown as RedisClient);
  const artifacts = new ArtifactStore(redis as unknown as RedisClient);
  let now = 1_000_000;
  const env = {
    BOX_CALLBACK_SECRET: secret,
    BOX_CALLBACK_URL: 'https://worker.example/box/callback',
    ARTIFACT_BUCKET: bucket as unknown as R2Bucket,
  } as Env;
  const gateway = new ArtifactGateway(env, redis as unknown as RedisClient, { store: artifacts, jobs, now: () => now });
  const job = await jobs.create({
    chatId: -100, userId: 'member', sessionKey: 'group:-100', request: 'make PDF',
    route: 'deepseek', model: 'deepseek/deepseek-v4-flash', callbackNonce: 'callback_nonce_123456',
    artifactSessionToken: sessionToken, now,
  });
  await jobs.markProvisioning(job.id, now);
  return { redis, bucket, jobs, artifacts, gateway, job, env, setNow: (value: number) => { now = value; } };
}

describe('ArtifactGateway', () => {
  it('authorizes one job-scoped upload, stores it in private R2, and makes retry idempotent', async () => {
    const harness = await setup();
    const pdf = new TextEncoder().encode('%PDF-1.4\nsmoke pdf\n%%EOF');
    const authorization = await harness.gateway.authorizeUpload(new Request('https://worker.example/box/artifacts/authorize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'X-Box-Job-Id': harness.job.id, 'X-Artifact-Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ filename: '../Quarterly Report.pdf', contentType: 'application/pdf', size: pdf.byteLength }),
    }));
    expect(authorization.status).toBe(200);
    const target = await authorization.json() as { artifactId: string; uploadUrl: string; headers: Record<string, string> };
    const retriedAuthorization = await harness.gateway.authorizeUpload(new Request('https://worker.example/box/artifacts/authorize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json', 'X-Box-Job-Id': harness.job.id, 'X-Artifact-Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ filename: '../Quarterly Report.pdf', contentType: 'application/pdf', size: pdf.byteLength }),
    }));
    expect((await retriedAuthorization.json() as { artifactId: string }).artifactId).toBe(target.artifactId);
    const upload = () => harness.gateway.upload(new Request(target.uploadUrl, {
      method: 'PUT', headers: target.headers, body: pdf,
    }), target.artifactId);
    expect((await upload()).status).toBe(200);
    expect((await upload()).status).toBe(200);
    expect(harness.bucket.puts).toBe(1);
    expect(await harness.artifacts.get(target.artifactId)).toMatchObject({
      status: 'uploaded', filename: 'Quarterly Report.pdf', contentType: 'application/pdf', actualSize: pdf.byteLength,
    });
  });

  it('streams a signed private download, rejects forgery/expiry, and reissues links', async () => {
    const harness = await setup();
    const artifact = await harness.artifacts.create({
      jobId: harness.job.id, chatId: -100, userId: 'member', filename: 'report.pdf', contentType: 'application/pdf',
      declaredSize: 4, uploadToken: 'upload_token_1234567890', uploadExpiresAt: 2_000_000, now: 1_000_000,
    });
    harness.bucket.objects.set(artifact.key, { bytes: new TextEncoder().encode('test'), contentType: 'application/pdf', etag: 'etag-1' });
    await harness.artifacts.markUploaded(artifact.id, { actualSize: 4, etag: 'etag-1', now: 1_000_000 });
    const current = (await harness.artifacts.get(artifact.id))!;
    const first = await harness.gateway.createDownloadUrl(current);
    const response = await harness.gateway.download(new Request(first), artifact.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('report.pdf');
    expect(await response.text()).toBe('test');

    const forged = new URL(first); forged.searchParams.set('signature', '00'.repeat(32));
    expect((await harness.gateway.download(new Request(forged), artifact.id)).status).toBe(401);
    harness.setNow(1_000_000 + 24 * 60 * 60_000 + 1);
    expect((await harness.gateway.download(new Request(first), artifact.id)).status).toBe(401);
    const second = await harness.gateway.createDownloadUrl(current);
    expect(second).not.toBe(first);
  });

  it('fails clearly when no public download origin is configured', async () => {
    const harness = await setup();
    const gateway = new ArtifactGateway(
      { ...harness.env, BOX_CALLBACK_URL: undefined },
      harness.redis as unknown as RedisClient,
      { store: harness.artifacts, jobs: harness.jobs },
    );

    await expect(gateway.createDownloadUrl({ id: 'ba_123456789abc' } as BoxArtifact))
      .rejects.toThrow('requires BOX_CALLBACK_URL or an explicit base URL');
  });

  it('rejects forged sessions, invalid lengths, terminal jobs, and oversized artifacts', async () => {
    const harness = await setup();
    const request = (token: string, size: number) => new Request('https://worker.example/box/artifacts/authorize', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Box-Job-Id': harness.job.id, 'X-Artifact-Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ filename: 'x.pdf', contentType: 'application/pdf', size }),
    });
    expect((await harness.gateway.authorizeUpload(request('artifact_session_token_forged', 4))).status).toBe(401);
    expect((await harness.gateway.authorizeUpload(request(sessionToken, MAX_ARTIFACT_BYTES + 1))).status).toBe(400);
    await harness.jobs.cancel(harness.job.id);
    expect((await harness.gateway.authorizeUpload(request(sessionToken, 4))).status).toBe(409);
  });

  it('enforces chat/user ownership when refreshing a link', async () => {
    const harness = await setup();
    const artifact = await harness.artifacts.create({
      jobId: harness.job.id, chatId: -100, userId: 'member', filename: 'report.pdf', contentType: 'application/pdf',
      declaredSize: 4, uploadToken: 'upload_token_1234567890', uploadExpiresAt: 2_000_000, now: 1_000_000,
    });
    harness.bucket.objects.set(artifact.key, { bytes: new Uint8Array(4), contentType: 'application/pdf', etag: 'etag-1' });
    await harness.artifacts.markUploaded(artifact.id, { actualSize: 4 });
    await expect(harness.gateway.getDownloadForUser({ artifactId: artifact.id, chatId: -100, userId: 'other', owner: false }))
      .rejects.toThrow('your own');
    await expect(harness.gateway.getDownloadForUser({ artifactId: artifact.id, chatId: -100, userId: 'owner', owner: true }))
      .resolves.toMatchObject({ artifact: { id: artifact.id } });
  });
});
