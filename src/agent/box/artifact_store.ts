import type { RedisClient } from '../../utils/redis';

const RECORD_PREFIX = 'box_artifact:v1:';
const JOB_INDEX_PREFIX = 'box_artifacts:v1:job:';
const IDEMPOTENCY_PREFIX = 'box_artifact_idempotency:v1:';
const RECORD_TTL_SECONDS = 45 * 24 * 60 * 60;

export type ArtifactStatus = 'authorized' | 'uploaded';

export interface BoxArtifact {
  id: string;
  jobId: string;
  chatId: number;
  userId: string;
  key: string;
  filename: string;
  contentType: string;
  declaredSize: number;
  actualSize?: number;
  etag?: string;
  status: ArtifactStatus;
  uploadTokenHash: string;
  uploadTokenValue?: string;
  idempotencyKey?: string;
  uploadExpiresAt: number;
  createdAt: number;
  uploadedAt?: number;
  telegramDeliveredAt?: number;
  deliveryLeaseId?: string;
  deliveryLeaseExpiresAt?: number;
}

type ArtifactRedis = Pick<RedisClient, 'get' | 'getMany' | 'set' | 'zadd' | 'zrangeAll' | 'withLock'>;

export class ArtifactStore {
  constructor(private readonly redis: ArtifactRedis) {}

  async create(input: {
    jobId: string;
    chatId: number;
    userId: string;
    filename: string;
    contentType: string;
    declaredSize: number;
    uploadToken: string;
    idempotencyKey?: string;
    uploadExpiresAt: number;
    now?: number;
  }): Promise<BoxArtifact> {
    const now = input.now ?? Date.now();
    const id = `ba_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const filename = sanitizeFilename(input.filename);
    const artifact: BoxArtifact = {
      id,
      jobId: normalizeId(input.jobId, 'job ID'),
      chatId: input.chatId,
      userId: input.userId.trim(),
      key: `jobs/${normalizeId(input.jobId, 'job ID')}/${id}/${filename}`,
      filename,
      contentType: sanitizeContentType(input.contentType),
      declaredSize: input.declaredSize,
      status: 'authorized',
      uploadTokenHash: await hashToken(input.uploadToken),
      uploadTokenValue: input.uploadToken,
      idempotencyKey: input.idempotencyKey,
      uploadExpiresAt: input.uploadExpiresAt,
      createdAt: now,
    };
    await Promise.all([
      this.save(artifact),
      this.redis.zadd(`${JOB_INDEX_PREFIX}${artifact.jobId}`, now, artifact.id),
      ...(input.idempotencyKey
        ? [this.redis.set(`${IDEMPOTENCY_PREFIX}${artifact.jobId}:${input.idempotencyKey}`, artifact.id, RECORD_TTL_SECONDS)]
        : []),
    ]);
    return artifact;
  }

  async get(id: string): Promise<BoxArtifact | null> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as BoxArtifact;
      return value?.id && (value.status === 'authorized' || value.status === 'uploaded') ? value : null;
    } catch {
      return null;
    }
  }

  async listForJob(jobId: string, limit = 10): Promise<BoxArtifact[]> {
    const normalized = normalizeId(jobId, 'job ID');
    const ids = await this.redis.zrangeAll(`${JOB_INDEX_PREFIX}${normalized}`, limit);
    const artifacts = (await this.redis.getMany(ids.map(id => this.key(id))))
      .map(raw => {
        if (!raw) return null;
        try { return JSON.parse(raw) as BoxArtifact; } catch { return null; }
      })
      .filter((value): value is BoxArtifact => !!value && value.jobId === normalized);
    return artifacts.sort((left, right) => left.createdAt - right.createdAt);
  }

  async verifyUploadToken(id: string, token: string): Promise<BoxArtifact | null> {
    const artifact = await this.get(id);
    if (!artifact) return null;
    return constantTimeEqual(artifact.uploadTokenHash, await hashToken(token)) ? artifact : null;
  }

  async getByIdempotencyKey(jobId: string, idempotencyKey: string): Promise<BoxArtifact | null> {
    const id = await this.redis.get(`${IDEMPOTENCY_PREFIX}${normalizeId(jobId, 'job ID')}:${normalizeIdempotencyKey(idempotencyKey)}`);
    return id ? await this.get(id) : null;
  }

  async markUploaded(
    id: string,
    input: { actualSize: number; etag?: string; now?: number },
  ): Promise<BoxArtifact> {
    return await this.redis.withLock(`box-artifact:${id}`, async () => {
      const artifact = await this.require(id);
      if (artifact.status === 'uploaded') return artifact;
      const updated: BoxArtifact = {
        ...artifact,
        status: 'uploaded',
        actualSize: input.actualSize,
        etag: input.etag,
        uploadTokenValue: undefined,
        uploadedAt: input.now ?? Date.now(),
      };
      await this.save(updated);
      return updated;
    });
  }

  async markTelegramDelivered(id: string, leaseId: string, now = Date.now()): Promise<BoxArtifact> {
    return await this.redis.withLock(`box-artifact:${id}`, async () => {
      const artifact = await this.require(id);
      if (artifact.telegramDeliveredAt) return artifact;
      if (artifact.deliveryLeaseId !== leaseId) throw new Error('Box artifact delivery lease mismatch.');
      const updated = { ...artifact, telegramDeliveredAt: now, deliveryLeaseId: undefined, deliveryLeaseExpiresAt: undefined };
      await this.save(updated);
      return updated;
    });
  }

  async claimTelegramDelivery(id: string, now = Date.now(), leaseMs = 60_000): Promise<{ artifact: BoxArtifact; leaseId: string } | null> {
    return await this.redis.withLock(`box-artifact:${id}`, async () => {
      const artifact = await this.require(id);
      if (artifact.status !== 'uploaded' || artifact.telegramDeliveredAt) return null;
      if (artifact.deliveryLeaseId && (artifact.deliveryLeaseExpiresAt ?? 0) > now) return null;
      const leaseId = crypto.randomUUID();
      const updated = { ...artifact, deliveryLeaseId: leaseId, deliveryLeaseExpiresAt: now + leaseMs };
      await this.save(updated);
      return { artifact: updated, leaseId };
    });
  }

  async releaseTelegramDelivery(id: string, leaseId: string): Promise<void> {
    await this.redis.withLock(`box-artifact:${id}`, async () => {
      const artifact = await this.require(id);
      if (artifact.telegramDeliveredAt || artifact.deliveryLeaseId !== leaseId) return;
      await this.save({ ...artifact, deliveryLeaseId: undefined, deliveryLeaseExpiresAt: undefined });
    });
  }

  private async require(id: string): Promise<BoxArtifact> {
    const artifact = await this.get(id);
    if (!artifact) throw new Error(`Box artifact not found: ${id}`);
    return artifact;
  }

  private async save(artifact: BoxArtifact): Promise<void> {
    await this.redis.set(this.key(artifact.id), JSON.stringify(artifact), RECORD_TTL_SECONDS);
  }

  private key(id: string): string {
    return `${RECORD_PREFIX}${normalizeId(id, 'artifact ID')}`;
  }
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('Invalid artifact idempotency key.');
  return normalized;
}

function sanitizeFilename(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').split('/').pop() || '';
  const safe = normalized
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 160);
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid artifact filename.');
  return safe;
}

function sanitizeContentType(value: string): string {
  const normalized = value.trim().toLowerCase().slice(0, 120);
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{5,39}$/.test(normalized)) throw new Error(`Invalid ${label}.`);
  return normalized;
}

async function hashToken(value: string): Promise<string> {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(normalized)) throw new Error('Invalid artifact token.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
