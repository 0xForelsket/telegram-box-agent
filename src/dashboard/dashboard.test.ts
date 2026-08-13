import { describe, expect, it, vi } from 'vitest';
import { RedisClient } from '../utils/redis';
import { DashboardAccess, dashboardHtml } from './dashboard';

function memoryRedis(): RedisClient {
  const values = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    get: vi.fn(async (key: string) => values.get(key) || null),
  } as unknown as RedisClient;
}

describe('DashboardAccess', () => {
  it('uses a fragment token and authenticates it without exposing it in the request URL', async () => {
    const access = new DashboardAccess(memoryRedis(), 'https://worker.example/');
    const session = await access.createSession('42', '42');
    const token = new URL(session.url).hash.slice(1);

    expect(session.url).toMatch(/^https:\/\/worker\.example\/dashboard#[A-Za-z0-9_-]+$/);
    expect(session.expiresInMinutes).toBe(15);
    await expect(access.authenticate(new Request('https://worker.example/dashboard/api', {
      headers: { Authorization: `Bearer ${token}` },
    }))).resolves.toMatchObject({ sessionKey: '42', ownerUserId: '42' });
    await expect(access.authenticate(new Request('https://worker.example/dashboard/api'))).resolves.toBeNull();
  });

  it('serves a non-indexable page with a restrictive dashboard policy', async () => {
    const response = dashboardHtml();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const policy = response.headers.get('Content-Security-Policy') || '';
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain("'unsafe-inline'");
    const nonce = policy.match(/script-src 'nonce-([a-f0-9]+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const body = await response.text();
    expect(body).toContain(`script nonce="${nonce}"`);
    expect(body).toContain(`style nonce="${nonce}"`);
    expect(body).toContain('Telegram Box Agent Control Room');
  });
});
