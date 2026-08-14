import { describe, expect, it, vi } from 'vitest';
import { globalFetch } from './helpers';
import { RedisClient } from './redis';
import type { Env } from '../env';

/**
 * Cloudflare Workers throws `TypeError: Illegal invocation` when the global
 * fetch is called with a receiver other than globalThis. Storing it on an
 * object and invoking it as `this.fetchImpl(...)` does exactly that, which
 * silently broke every scheduled task on the deployed Worker while the local
 * suite stayed green.
 */
describe('globalFetch', () => {
  it('survives being called as a method on another object', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    try {
      const holder = { doFetch: globalFetch };

      await expect(holder.doFetch('https://example.test')).resolves.toBeInstanceOf(Response);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('forwards both arguments', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => new Response('ok'));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const holder = { doFetch: globalFetch };
      await holder.doFetch('https://example.test', { method: 'POST' });

      expect(spy).toHaveBeenCalledWith('https://example.test', { method: 'POST' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('RedisClient transport binding', () => {
  // The scheduled handler reaches Redis through this path; an unbound fetch
  // here took down reminders, digests, and every Box recovery task at once.
  it('calls the global fetch without an illegal receiver', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => new Response(JSON.stringify({ result: 'PONG' })));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'token',
        OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODELS: 'gpt',
        TELEGRAM_BOT_TOKEN: 't', WHITELISTED_USERS: '1',
        SYSTEM_INIT_MESSAGE: 'x', SYSTEM_INIT_MESSAGE_ROLE: 'system',
        CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4',
        GOOGLE_MODEL_KEY: '', GOOGLE_MODELS: '', GROQ_API_KEY: '', GROQ_MODELS: '',
        CLAUDE_API_KEY: '', CLAUDE_MODELS: '', AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
      } as unknown as Env;

      await expect(new RedisClient(env).get('any-key')).resolves.toBe('PONG');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
