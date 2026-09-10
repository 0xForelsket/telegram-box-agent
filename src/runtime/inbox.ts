import type { TelegramTypes } from '../../types/telegram';
import { RedisClient } from '../utils/redis';
import { splitMessage } from '../utils/helpers';
import { runExecution } from './execution';
import { TelegramRateLimitError } from '../telegram/transport';

const DUE = 'inbox:v1:due';
const PREFIX = 'inbox:v1:update:';
const SESSION = 'inbox:v1:session:';
const LEASE_MS = 150_000;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

export interface InboxRecord {
  id: number;
  session: string;
  update: TelegramTypes.Update;
  state: 'queued' | 'running' | 'delivering' | 'completed' | 'failed';
  createdAt: number;
  lease?: string;
  leaseUntil?: number;
  reply?: { chatId: number; parts: string[]; cursor: number };
  deliveryAttempts: number;
}

// Acceptance and both indexes commit together. Pending records never expire.
export const ACCEPT_UPDATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local old = redis.call('GET', KEYS[4])
if old == 'completed' or old == '1' then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[3])
return 1`;

export const CLAIM_UPDATE = `
local raw = redis.call('GET', KEYS[1])
if not raw then redis.call('ZREM', KEYS[2], ARGV[1]); return nil end
local r = cjson.decode(raw)
local head = redis.call('ZRANGE', KEYS[3], 0, 0)
if head[1] ~= ARGV[1] then
  redis.call('ZADD', KEYS[2], tonumber(ARGV[2]) + 60000, ARGV[1])
  return nil
end
if r.state == 'completed' or r.state == 'failed' then return nil end
if r.leaseUntil and r.leaseUntil > tonumber(ARGV[2]) then return nil end
if r.state == 'running' then
  r.state = 'delivering'
  if not r.reply then
    local message = r.update.message or (r.update.callback_query and r.update.callback_query.message)
    if message then r.reply = {chatId=message.chat.id, parts={'The previous request was interrupted. Please send it again; I have not automatically repeated any actions.'}, cursor=0} end
  end
end
if r.state == 'queued' then r.state = 'running' end
r.lease = ARGV[3]; r.leaseUntil = tonumber(ARGV[2]) + tonumber(ARGV[4])
local value = cjson.encode(r)
redis.call('SET', KEYS[1], value)
redis.call('ZADD', KEYS[2], r.leaseUntil, ARGV[1])
return value`;

export const SAVE_UPDATE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local old = cjson.decode(raw)
if old.state == 'completed' or old.state == 'failed' then return 0 end
if old.lease ~= ARGV[1] or old.leaseUntil <= tonumber(ARGV[3]) then return 0 end
local r = cjson.decode(ARGV[2])
redis.call('SET', KEYS[1], ARGV[2])
if r.state == 'completed' or r.state == 'failed' then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  redis.call('ZREM', KEYS[2], string.format('%.0f', r.id))
  redis.call('ZREM', KEYS[3], string.format('%.0f', r.id))
  local next = redis.call('ZRANGE', KEYS[3], 0, 0)
  if next[1] then redis.call('ZADD', KEYS[2], ARGV[3], next[1]) end
else
  redis.call('ZADD', KEYS[2], r.leaseUntil, string.format('%.0f', r.id))
end
return 1`;

export class Inbox {
  constructor(private readonly redis: RedisClient, private readonly now = Date.now) {}

  async accept(update: TelegramTypes.Update): Promise<boolean> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid update ID.');
    const message = update.message ?? update.callback_query?.message;
    const session = message ? `chat:${message.chat.id}` : `user:${update.callback_query?.from.id ?? update.update_id}`;
    const record: InboxRecord = { id: update.update_id, session, update, state: 'queued', createdAt: this.now(), deliveryAttempts: 0 };
    return (await this.redis.eval<number>(ACCEPT_UPDATE,
      [PREFIX + record.id, DUE, SESSION + session, `processed_update:${record.id}`],
      [JSON.stringify(record), record.createdAt, record.id])) === 1;
  }

  async drain(handle: (update: TelegramTypes.Update) => Promise<void>, send: (chatId: number, text: string) => Promise<unknown>, limit = 3): Promise<number> {
    const ids = await this.redis.zrangeByScore(DUE, 0, this.now(), 6);
    let processed = 0;
    for (const id of ids) {
      if (processed >= limit) break;
      const raw = await this.redis.get(PREFIX + id);
      if (!raw) { await this.redis.zrem(DUE, id); continue; }
      const candidate = JSON.parse(raw) as InboxRecord;
      const claimed = await this.redis.eval<string | null>(CLAIM_UPDATE,
        [PREFIX + id, DUE, SESSION + candidate.session], [id, this.now(), crypto.randomUUID(), LEASE_MS]);
      if (!claimed) continue;
      const record = JSON.parse(claimed) as InboxRecord;
      const save = async () => {
        const saved = await this.redis.eval<number>(SAVE_UPDATE,
          [PREFIX + id, DUE, SESSION + record.session], [record.lease!, JSON.stringify(record), this.now(), RETENTION_SECONDS]);
        if (!saved) throw new Error('Inbox execution lease expired.');
      };
      processed++;
      try {
        if (record.state === 'running') {
          try {
            await runExecution(90_000, () => handle(record.update), async (chatId, text) => {
              record.reply = { chatId, parts: splitMessage(text, 4000), cursor: 0 };
              await save();
            });
          } catch (error) {
            console.error('inbox execution failed', { updateId: record.id, error: String(error) });
            const message = record.update.message ?? record.update.callback_query?.message;
            if (!record.reply && message) record.reply = {
              chatId: message.chat.id, parts: ['I could not finish this request. Please try again.'], cursor: 0,
            };
          }
          record.state = 'delivering';
          await save();
        }
        if (record.reply) {
          let delivered = 0;
          while (record.reply.cursor < record.reply.parts.length && delivered < 3) {
            // Renew before each bounded send. A consumer must never start a
            // Telegram side effect after another consumer can acquire its lease.
            record.leaseUntil = this.now() + 30_000;
            await save();
            await runExecution(20_000, () => send(record.reply!.chatId, record.reply!.parts[record.reply!.cursor]));
            record.reply.cursor++;
            delivered++;
            await save();
          }
          if (record.reply.cursor < record.reply.parts.length) {
            record.leaseUntil = this.now();
            await save();
            continue;
          }
        }
        record.state = 'completed';
        await save();
        console.log('inbox completed', { updateId: record.id, elapsedMs: this.now() - record.createdAt });
      } catch (error) {
        record.deliveryAttempts++;
        if (record.deliveryAttempts >= 5) record.state = 'failed';
        record.leaseUntil = this.now() + Math.max(60_000, error instanceof TelegramRateLimitError ? error.retryAfterMs : 0);
        await save().catch(() => undefined);
        console.error('inbox recovery required', { updateId: record.id, state: record.state, error: String(error) });
      }
    }
    return processed;
  }
}
