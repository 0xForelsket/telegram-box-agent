import { describe, expect, it, vi } from 'vitest';
import { Webhook } from './webhook';
import type { Inbox } from './inbox';
import type { Env } from '../env';

function request(body = '{"update_id":1}') {
  return new Request('https://bot/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' }, body });
}

describe('webhook acceptance', () => {
  it('rejects invalid authentication and methods before accepting any data', async () => {
    const accept = vi.fn();
    const inbox = { accept } as unknown as Inbox;
    const webhook = new Webhook({ TELEGRAM_WEBHOOK_SECRET: 'secret' } as Env, inbox);
    expect((await webhook.accept(new Request('https://bot', { method: 'POST', body: '{}' }))).status).toBe(403);
    expect((await webhook.accept(new Request('https://bot', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, body: '{}' }))).status).toBe(403);
    expect((await webhook.accept(new Request('https://bot'))).status).toBe(405);
    expect((await new Webhook({} as Env, inbox).accept(request())).status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });
  it('acknowledges durable acceptance without waiting for execution', async () => {
    const accept = vi.fn().mockResolvedValue(true);
    const dispatch = vi.fn().mockReturnValue(new Promise(() => {}));
    const waitUntil = vi.fn();
    const env = { TELEGRAM_WEBHOOK_SECRET: 'secret', INBOX_WORKER: { fetch: dispatch } } as unknown as Env;
    const webhook = new Webhook(env, { accept } as unknown as Inbox, { waitUntil } as unknown as ExecutionContext);
    expect((await webhook.accept(request())).status).toBe(200);
    expect(accept).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce(); expect(waitUntil).toHaveBeenCalledOnce();
  });
  it('returns success for an already accepted update without dispatching duplicate work', async () => {
    const dispatch = vi.fn();
    const webhook = new Webhook({ TELEGRAM_WEBHOOK_SECRET: 'secret', INBOX_WORKER: { fetch: dispatch } } as unknown as Env,
      { accept: vi.fn().mockResolvedValue(false) } as unknown as Inbox);
    expect((await webhook.accept(request())).status).toBe(200); expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not acknowledge an update that storage could not accept', async () => {
    const webhook = new Webhook({ TELEGRAM_WEBHOOK_SECRET: 'secret' } as Env,
      { accept: vi.fn().mockRejectedValue(new Error('Redis down')) } as unknown as Inbox);
    expect((await webhook.accept(request())).status).toBe(503);
    expect((await webhook.accept(request('{}'))).status).toBe(400);
  });
});
