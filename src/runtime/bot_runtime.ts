import type { Env } from '../env';
import TelegramBot from '../api/telegram';
import { RedisClient } from '../utils/redis';
import { Inbox } from './inbox';
import { Webhook } from './webhook';

// HTTP acceptance, execution, and recovery are composed here. Feature handlers
// do not own the request lifecycle or decide when Telegram is acknowledged.
export class BotRuntime {
  private readonly inbox: Inbox;
  readonly webhook: Webhook;

  constructor(private readonly env: Env, private readonly ctx: ExecutionContext) {
    this.inbox = new Inbox(new RedisClient(env));
    this.webhook = new Webhook(env, this.inbox, ctx);
  }

  async drain(): Promise<number> {
    const bot = new TelegramBot(this.env, this.ctx);
    return this.inbox.drain(update => bot.handleUpdate(update),
      (chatId, text) => bot.sendMessageWithFallback(chatId, text), 1);
  }
}
