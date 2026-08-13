import { describe, expect, it } from 'vitest';
import type { Env } from './env';
import worker from './index';

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'correct-secret',
    WHITELISTED_USERS: 'owner', OWNER_USER_ID: 'owner',
    SYSTEM_INIT_MESSAGE: 'test', SYSTEM_INIT_MESSAGE_ROLE: 'system',
    UPSTASH_REDIS_REST_URL: 'https://redis.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-token',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4',
    GOOGLE_MODEL_KEY: 'test-model-key', GOOGLE_MODELS: 'test-model',
    GROQ_API_KEY: '', GROQ_MODELS: '', CLAUDE_API_KEY: '', CLAUDE_MODELS: '',
    AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
    ...overrides,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

describe('Worker HTTP integration boundary', () => {
  it('serves the health endpoint through the deployed worker entrypoint', async () => {
    const response = await worker.fetch(new Request('https://worker.example/'), env(), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Telegram bot worker');
  });

  it('fails the Telegram webhook closed before parsing an untrusted body', async () => {
    const missing = await worker.fetch(new Request('https://worker.example/webhook', {
      method: 'POST', body: '{not-json', headers: { 'Content-Type': 'application/json' },
    }), env({ TELEGRAM_WEBHOOK_SECRET: '' }), ctx);
    expect(missing.status).toBe(403);

    const forged = await worker.fetch(new Request('https://worker.example/webhook', {
      method: 'POST', body: '{not-json',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
    }), env(), ctx);
    expect(forged.status).toBe(403);
  });

  it('routes callback requests to the Box boundary without exposing an exception', async () => {
    const response = await worker.fetch(new Request('https://worker.example/box/callback', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }), env(), ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing Box job ID.' });
  });
});
