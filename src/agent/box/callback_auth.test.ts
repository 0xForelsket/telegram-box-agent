import { describe, expect, it } from 'vitest';
import { createBoxCallbackAuthorization, verifyBoxCallbackAuthorization } from './callback_auth';

const secret = 'a-secure-callback-secret-with-more-than-32-characters';

describe('Box callback authorization', () => {
  it('signs and verifies a job-scoped callback nonce', async () => {
    const authorization = await createBoxCallbackAuthorization({
      url: 'https://worker.example/box/callback',
      secret,
      jobId: 'job_123456',
      now: 1_000_000,
      nonce: 'nonce_123456',
    });
    const result = await verifyBoxCallbackAuthorization({
      headers: new Headers(authorization.headers),
      secret,
      expectedJobId: 'job_123456',
      now: 1_030_000,
    });

    expect(result).toEqual({ valid: true, nonce: 'nonce_123456', timestamp: 1_000_000 });
  });

  it('rejects a forged signature', async () => {
    const authorization = await createBoxCallbackAuthorization({
      url: 'https://worker.example/box/callback',
      secret,
      jobId: 'job_123456',
      now: 1_000_000,
      nonce: 'nonce_123456',
    });
    const headers = new Headers(authorization.headers);
    headers.set('X-Box-Callback-Signature', '00'.repeat(32));

    await expect(verifyBoxCallbackAuthorization({
      headers,
      secret,
      expectedJobId: 'job_123456',
      now: 1_030_000,
    })).resolves.toEqual({ valid: false, reason: 'invalid callback signature' });
  });

  it('rejects late and cross-job callbacks', async () => {
    const authorization = await createBoxCallbackAuthorization({
      url: 'https://worker.example/box/callback',
      secret,
      jobId: 'job_123456',
      now: 1_000_000,
      nonce: 'nonce_123456',
    });
    const headers = new Headers(authorization.headers);

    await expect(verifyBoxCallbackAuthorization({
      headers,
      secret,
      expectedJobId: 'job_654321',
      now: 1_030_000,
    })).resolves.toEqual({ valid: false, reason: 'job ID mismatch' });
    await expect(verifyBoxCallbackAuthorization({
      headers,
      secret,
      expectedJobId: 'job_123456',
      now: 1_000_000 + 45 * 24 * 60 * 60_000 + 1,
    })).resolves.toEqual({ valid: false, reason: 'expired callback authorization' });
  });
});
