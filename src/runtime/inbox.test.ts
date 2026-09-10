import { describe, expect, it, vi } from 'vitest';
import { Inbox, CLAIM_UPDATE, SAVE_UPDATE } from './inbox';
import { deferReply } from './execution';
import { LuaRedis } from '../test/lua_redis';
import type { RedisClient } from '../utils/redis';
import type { TelegramTypes } from '../../types/telegram';
import { TelegramRateLimitError } from '../telegram/transport';

const update = (id: number, chatId = 1) => ({ update_id: id, message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: 1 }, text: 'hi' } }) as TelegramTypes.Update;
const setup = () => {
  const redis = new LuaRedis();
  return { redis, inbox: new Inbox(redis as unknown as RedisClient, () => redis.now) };
};

describe('durable inbox', () => {
  it('accepts once and honors the previous deployment completed markers', async () => {
    const { redis, inbox } = setup();
    expect(await inbox.accept(update(1))).toBe(true);
    expect(await inbox.accept(update(1))).toBe(false);
    await redis.set('processed_update:2', 'completed');
    expect(await inbox.accept(update(2))).toBe(false);
  });

  it('persists a reply and retries delivery without regenerating it', async () => {
    const { redis, inbox } = setup();
    await inbox.accept(update(1));
    const handle = vi.fn(async () => { await deferReply(1, 'answer'); });
    const send = vi.fn().mockRejectedValueOnce(new Error('Telegram down')).mockResolvedValue(undefined);
    await inbox.drain(handle, send);
    redis.now += 60001;
    await inbox.drain(handle, send);
    expect(handle).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await redis.get('inbox:v1:update:1'))!).state).toBe('completed');
  });

  it('serializes a conversation while another conversation can execute', async () => {
    const { inbox } = setup();
    await inbox.accept(update(1)); await inbox.accept(update(2)); await inbox.accept(update(3, 2));
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const seen: number[] = [];
    const handle = async (u: TelegramTypes.Update) => { seen.push(u.update_id); if (u.update_id === 1) { started(); await blocked; } };
    const first = inbox.drain(handle, async () => {}, 1);
    await ready;
    await inbox.drain(handle, async () => {});
    expect(seen).toEqual([1, 3]);
    finish(); await first;
    await inbox.drain(handle, async () => {});
    expect(seen).toEqual([1, 3, 2]);
  });

  it('waits for Telegram retry_after before retrying saved delivery', async () => {
    const { redis, inbox } = setup();
    await inbox.accept(update(1));
    const handle = vi.fn(async () => { await deferReply(1, 'answer'); });
    const send = vi.fn().mockRejectedValueOnce(new TelegramRateLimitError(120)).mockResolvedValue(undefined);
    await inbox.drain(handle, send);
    redis.now += 60001; await inbox.drain(handle, send);
    expect(send).toHaveBeenCalledOnce();
    redis.now += 60000; await inbox.drain(handle, send);
    expect(send).toHaveBeenCalledTimes(2); expect(handle).toHaveBeenCalledOnce();
  });

  it('resumes long replies from the saved chunk cursor within bounded delivery batches', async () => {
    const { inbox } = setup();
    await inbox.accept(update(1));
    const handle = vi.fn(async () => { await deferReply(1, 'x'.repeat(13000)); });
    const send = vi.fn();
    await inbox.drain(handle, send);
    expect(send).toHaveBeenCalledTimes(3);
    await inbox.drain(handle, send);
    expect(send).toHaveBeenCalledTimes(4);
    expect(handle).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(call => call[1]).join('')).toHaveLength(13000);
  });

  it('does not repeat side effects after an execution lease expires', async () => {
    const { redis, inbox } = setup();
    await inbox.accept(update(1));
    const keys = ['inbox:v1:update:1', 'inbox:v1:due', 'inbox:v1:session:chat:1'];
    const raw = await redis.eval<string>(CLAIM_UPDATE, keys, [1, redis.now, 'lost-worker', 150000]);
    redis.now += 150001;
    const handler = vi.fn(); const send = vi.fn();
    await inbox.drain(handler, send);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(1, expect.stringContaining('interrupted'));
    expect(await redis.eval(SAVE_UPDATE, keys, ['lost-worker', raw, redis.now, 86400])).toBe(0);
  });

  it('recovers a prepared reply when execution disappears before the delivery transition', async () => {
    const { redis, inbox } = setup();
    await inbox.accept(update(1));
    const keys = ['inbox:v1:update:1', 'inbox:v1:due', 'inbox:v1:session:chat:1'];
    const record = JSON.parse(await redis.eval<string>(CLAIM_UPDATE, keys, [1, redis.now, 'worker', 150000]));
    record.reply = { chatId: 1, parts: ['saved answer'], cursor: 0 };
    await redis.eval(SAVE_UPDATE, keys, ['worker', JSON.stringify(record), redis.now, 86400]);
    redis.now += 150001;
    const send = vi.fn(); const handle = vi.fn();
    await inbox.drain(handle, send);
    expect(handle).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(1, 'saved answer');
  });
});
