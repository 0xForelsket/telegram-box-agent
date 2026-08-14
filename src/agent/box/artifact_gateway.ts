import type { Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import { ARTIFACT_RETENTION_DAYS, ArtifactStore, type BoxArtifact } from './artifact_store';
import { BoxJobStore } from './box_job_store';

export const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACTS_PER_JOB = 10;
const MAX_TOTAL_ARTIFACT_BYTES = 100 * 1024 * 1024;
const UPLOAD_AUTH_TTL_MS = 20 * 60_000;
const UPLOAD_LOCK_TTL_SECONDS = 5 * 60;
const DOWNLOAD_LINK_TTL_MS = 24 * 60 * 60_000;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'provisioning', 'running', 'awaiting_approval']);

export interface ArtifactGatewayDependencies {
  store?: ArtifactStore;
  jobs?: BoxJobStore;
  now?: () => number;
}

export class ArtifactGateway {
  readonly store: ArtifactStore;
  private readonly jobs: BoxJobStore;
  private readonly now: () => number;

  constructor(
    private readonly env: Env,
    private readonly redis: RedisClient,
    dependencies: ArtifactGatewayDependencies = {},
  ) {
    this.store = dependencies.store ?? new ArtifactStore(redis);
    this.jobs = dependencies.jobs ?? new BoxJobStore(redis);
    this.now = dependencies.now ?? Date.now;
  }

  async authorizeUpload(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!this.env.ARTIFACT_BUCKET) return json({ error: 'Artifact storage is not configured.' }, 503);
    const jobId = request.headers.get('X-Box-Job-Id')?.trim().toLowerCase() ?? '';
    const sessionToken = bearer(request.headers);
    if (!jobId || !sessionToken) return json({ error: 'Missing artifact session credentials.' }, 401);

    let job;
    try {
      job = await this.jobs.verifyArtifactSession(jobId, sessionToken);
    } catch {
      return json({ error: 'Invalid artifact session credentials.' }, 401);
    }
    if (!job) return json({ error: 'Invalid artifact session credentials.' }, 401);
    if (!ACTIVE_JOB_STATUSES.has(job.status)) return json({ error: `Box job is ${job.status}.` }, 409);
    let input: { filename: string; contentType: string; size: number };
    const idempotencyKey = request.headers.get('X-Artifact-Idempotency-Key')?.trim().toLowerCase() ?? '';
    if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) return json({ error: 'Missing or invalid artifact idempotency key.' }, 400);
    try {
      const body = await request.json() as Record<string, unknown>;
      input = {
        filename: requireString(body.filename, 'filename'),
        contentType: typeof body.contentType === 'string' ? body.contentType : 'application/octet-stream',
        size: requireSize(body.size),
      };
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid artifact request.' }, 400);
    }

    return await this.redis.withLock(`box-artifact-admission:${job.id}`, async () => {
      const prior = await this.store.getByIdempotencyKey(job.id, idempotencyKey);
      if (prior) return json(prior.status === 'uploaded'
        ? { artifactId: prior.id, alreadyUploaded: true }
        : {
            artifactId: prior.id,
            uploadUrl: `${new URL(request.url).origin}/box/artifacts/upload/${prior.id}`,
            headers: {
              Authorization: `Bearer ${prior.uploadTokenValue}`,
              'Content-Type': prior.contentType,
              'Content-Length': String(prior.declaredSize),
            },
            expiresAt: prior.uploadExpiresAt,
          });
      const existing = await this.store.listForJob(job.id, MAX_ARTIFACTS_PER_JOB + 1);
      if (existing.length >= MAX_ARTIFACTS_PER_JOB) return json({ error: 'Artifact count limit reached.' }, 409);
      const total = existing.reduce((sum, artifact) => sum + artifact.declaredSize, 0);
      if (total + input.size > MAX_TOTAL_ARTIFACT_BYTES) return json({ error: 'Artifact size limit reached.' }, 413);

      const uploadToken = crypto.randomUUID().replace(/-/g, '');
      const artifact = await this.store.create({
        jobId: job.id,
        chatId: job.chatId,
        userId: job.userId,
        filename: input.filename,
        contentType: input.contentType,
        declaredSize: input.size,
        uploadToken,
        idempotencyKey,
        uploadExpiresAt: this.now() + UPLOAD_AUTH_TTL_MS,
        now: this.now(),
      });
      return json({
        artifactId: artifact.id,
        uploadUrl: `${new URL(request.url).origin}/box/artifacts/upload/${artifact.id}`,
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          'Content-Type': artifact.contentType,
          'Content-Length': String(artifact.declaredSize),
        },
        expiresAt: artifact.uploadExpiresAt,
      });
    });
  }

  async upload(request: Request, artifactId: string): Promise<Response> {
    if (request.method !== 'PUT') return json({ error: 'Method not allowed.' }, 405);
    const bucket = this.env.ARTIFACT_BUCKET;
    if (!bucket) return json({ error: 'Artifact storage is not configured.' }, 503);
    const uploadToken = bearer(request.headers);
    if (!uploadToken) return json({ error: 'Missing upload authorization.' }, 401);
    // This lock is held across a streaming R2 put of up to MAX_ARTIFACT_BYTES.
    // The 5s default would expire mid-transfer and stop excluding anyone, so
    // the TTL has to cover the slowest upload we accept rather than the fastest.
    return await this.redis.withLock(`box-artifact-upload:${artifactId}`, async () => {
      let artifact: BoxArtifact | null;
      try {
        artifact = await this.store.verifyUploadToken(artifactId, uploadToken);
      } catch {
        artifact = null;
      }
      if (!artifact) return json({ error: 'Invalid upload authorization.' }, 401);
      if (artifact.status === 'uploaded') return json({ ok: true, artifactId: artifact.id, duplicate: true });
      if (this.now() > artifact.uploadExpiresAt) return json({ error: 'Upload authorization expired.' }, 401);
      const contentLength = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
      if (!Number.isFinite(contentLength) || contentLength !== artifact.declaredSize) {
        return json({ error: 'Content-Length does not match the authorized artifact size.' }, 400);
      }
      if (!request.body) return json({ error: 'Artifact body is required.' }, 400);

      const object = await bucket.put(artifact.key, request.body, {
        httpMetadata: { contentType: artifact.contentType },
        customMetadata: { artifactId: artifact.id, jobId: artifact.jobId, filename: artifact.filename },
      });
      if (object.size !== artifact.declaredSize) {
        await bucket.delete(artifact.key);
        return json({ error: 'Uploaded artifact size does not match the authorization.' }, 400);
      }
      const uploaded = await this.store.markUploaded(artifact.id, {
        actualSize: object.size,
        etag: object.etag,
        now: this.now(),
      });
      return json({ ok: true, artifactId: uploaded.id, duplicate: false });
    }, { ttlSeconds: UPLOAD_LOCK_TTL_SECONDS });
  }

  async download(request: Request, artifactId: string): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
    const bucket = this.env.ARTIFACT_BUCKET;
    if (!bucket) return json({ error: 'Artifact storage is not configured.' }, 503);
    const url = new URL(request.url);
    const expiresAt = Number.parseInt(url.searchParams.get('expires') ?? '', 10);
    const signature = url.searchParams.get('signature') ?? '';
    if (!Number.isFinite(expiresAt) || expiresAt < this.now()) return json({ error: 'Artifact link expired.' }, 401);
    if (expiresAt > this.now() + DOWNLOAD_LINK_TTL_MS + 60_000) return json({ error: 'Invalid artifact expiry.' }, 401);
    if (!await this.verifyDownloadSignature(artifactId, expiresAt, signature)) {
      return json({ error: 'Invalid artifact signature.' }, 401);
    }
    const artifact = await this.store.get(artifactId);
    if (!artifact || artifact.status !== 'uploaded') return json({ error: 'Artifact not found.' }, 404);
    const object = request.method === 'HEAD'
      ? await bucket.head(artifact.key)
      : await bucket.get(artifact.key);
    if (!object) return json({ error: 'Artifact no longer exists.' }, 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', artifact.contentType);
    headers.set('Content-Length', String(object.size));
    headers.set('Content-Disposition', `attachment; filename="${artifact.filename.replace(/["\r\n]/g, '_')}"`);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { status: 200, headers });
  }

  async createDownloadUrl(artifact: BoxArtifact, baseUrl?: string, now = this.now()): Promise<string> {
    const origin = new URL(baseUrl || this.env.BOX_CALLBACK_URL || 'https://invalid.local').origin;
    const expiresAt = now + DOWNLOAD_LINK_TTL_MS;
    const signature = await this.signDownload(artifact.id, expiresAt);
    return `${origin}/artifacts/${artifact.id}?expires=${expiresAt}&signature=${signature}`;
  }

  async getDownloadForUser(input: {
    artifactId: string;
    chatId: number;
    userId: string;
    owner: boolean;
  }): Promise<{ artifact: BoxArtifact; url: string }> {
    const artifact = await this.store.get(input.artifactId);
    if (!artifact || artifact.status !== 'uploaded' || artifact.chatId !== input.chatId) {
      throw new Error('Artifact not found in this chat.');
    }
    if (!input.owner && artifact.userId !== input.userId) throw new Error('You can only access your own artifacts.');
    if (!this.env.ARTIFACT_BUCKET || !await this.env.ARTIFACT_BUCKET.head(artifact.key)) {
      throw new Error('Artifact no longer exists.');
    }
    return { artifact, url: await this.createDownloadUrl(artifact) };
  }

  /**
   * Uploaded artifacts visible to a caller, with the days each has left before
   * the R2 lifecycle rule removes it. Presence in Redis is not proof the object
   * still exists, so the caller is told this is the record's view.
   */
  async listForUser(input: {
    chatId: number;
    userId: string;
    owner: boolean;
    limit?: number;
  }): Promise<Array<{ artifact: BoxArtifact; retentionDaysLeft: number }>> {
    const artifacts = await this.store.listForChat(input.chatId, input.limit ?? 25);
    const now = this.now();
    return artifacts
      .filter(artifact => artifact.status === 'uploaded')
      .filter(artifact => input.owner || artifact.userId === input.userId)
      .map(artifact => {
        const storedAt = artifact.uploadedAt ?? artifact.createdAt;
        const elapsedDays = (now - storedAt) / (24 * 60 * 60_000);
        return {
          artifact,
          retentionDaysLeft: Math.max(0, Math.ceil(ARTIFACT_RETENTION_DAYS - elapsedDays)),
        };
      });
  }

  private async signDownload(artifactId: string, expiresAt: number): Promise<string> {
    const secret = this.env.BOX_CALLBACK_SECRET?.trim() ?? '';
    if (secret.length < 32) throw new Error('Artifact signing secret is not configured.');
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`artifact-download-v1\n${artifactId}\n${expiresAt}`));
    return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private async verifyDownloadSignature(artifactId: string, expiresAt: number, supplied: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
    let expected: string;
    try { expected = await this.signDownload(artifactId, expiresAt); } catch { return false; }
    let mismatch = 0;
    for (let index = 0; index < expected.length; index++) mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
    return mismatch === 0;
  }
}

function bearer(headers: Headers): string {
  const value = headers.get('Authorization') ?? '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Artifact ${label} is required.`);
  return value;
}

function requireSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Artifact size must be a positive integer.');
  if (value > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte limit.`);
  return value;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
