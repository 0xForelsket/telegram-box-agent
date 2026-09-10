import type { Env } from '../env';
import type { TelegramTypes } from '../../types/telegram';
import { constantTimeEqual } from '../utils/helpers';
import { Inbox } from './inbox';

export class Webhook {
  constructor(private readonly env: Env, private readonly inbox: Inbox, private readonly ctx?: ExecutionContext) {}

  async accept(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const secret = this.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!secret || !constantTimeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', secret)) {
      return new Response('Forbidden', { status: 403 });
    }
    let update: TelegramTypes.Update;
    try {
      if (Number(request.headers.get('Content-Length') ?? 0) > 1_000_000) return new Response('Too large', { status: 413 });
      const body = await request.text();
      if (body.length > 1_000_000) return new Response('Too large', { status: 413 });
      update = JSON.parse(body);
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid update');
    } catch {
      return new Response('Invalid update', { status: 400 });
    }
    try {
      const accepted = await this.inbox.accept(update);
      if (accepted && this.env.INBOX_WORKER && this.ctx) {
        // A separate invocation handles execution; the Redis inbox remains the
        // source of truth if dispatch, the caller, or the consumer disappears.
        this.ctx.waitUntil(this.env.INBOX_WORKER.fetch('https://inbox.internal/internal/inbox', {
          method: 'POST', headers: { 'X-Inbox-Secret': secret },
        }).then(async response => {
          await response.text();
          if (!response.ok) console.error('Inbox dispatch failed', { status: response.status });
        }).catch(error => console.error('Inbox dispatch interrupted; cron will recover', String(error))));
      }
      return new Response('OK');
    } catch (error) {
      console.error('Inbox acceptance failed', String(error));
      return new Response('Storage unavailable', { status: 503, headers: { 'Retry-After': '5' } });
    }
  }
}
