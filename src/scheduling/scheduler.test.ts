import { describe, expect, it, vi } from 'vitest';
import { RedisClient } from '../utils/redis';
import { parseDigestInput, parseReminderInput, ScheduledJob, SharedScheduler } from './scheduler';

describe('SharedScheduler', () => {
  it('parses relative and Malaysia-local reminder times', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    expect(parseReminderInput('in 20m stretch', now)).toEqual({ dueAt: now.getTime() + 20 * 60_000, text: 'stretch' });
    expect(new Date(parseReminderInput('tomorrow 09:00 standup', now).dueAt).toISOString()).toBe('2026-08-13T01:00:00.000Z');
    expect(parseReminderInput('daily 09:00 standup', now)).toMatchObject({ recurrence: 'daily', text: 'standup' });
    expect(parseReminderInput('weekly mon 09:00 review', now)).toMatchObject({ recurrence: 'weekly', text: 'review' });
  });

  it('parses bounded recurring digest schedules', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    expect(parseDigestInput('daily 08:30 search chip news', now)).toMatchObject({ recurrence: 'daily', mode: 'search', query: 'chip news' });
    expect(parseDigestInput('weekly fri 18:00 feeds', now)).toMatchObject({ recurrence: 'weekly', mode: 'feeds' });
  });

  it('claims a due job once and reschedules recurring work', async () => {
    const job: ScheduledJob = { id: 'abc', type: 'reminder', chatId: 1, sessionKey: 'private:1', nextAt: 100, createdAt: 0, recurrence: 'daily', payload: { text: 'hello' } };
    const zadd = vi.fn().mockResolvedValue(undefined);
    const redis = {
      zrangeByScore: vi.fn().mockResolvedValue([JSON.stringify(job)]),
      zrem: vi.fn().mockResolvedValue(true),
      zadd,
    } as unknown as RedisClient;
    const handler = vi.fn().mockResolvedValue(undefined);

    await expect(new SharedScheduler(redis).drainDue(handler, 200)).resolves.toBe(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(zadd).toHaveBeenCalledWith('schedule:v1:due', 100 + 24 * 60 * 60_000, expect.any(String));
  });

  it('requeues a failed job with a bounded retry count', async () => {
    const job: ScheduledJob = { id: 'abc', type: 'reminder', chatId: 1, sessionKey: 'private:1', nextAt: 100, createdAt: 0, payload: { text: 'hello' } };
    const zadd = vi.fn().mockResolvedValue(undefined);
    const redis = { zrangeByScore: vi.fn().mockResolvedValue([JSON.stringify(job)]), zrem: vi.fn().mockResolvedValue(true), zadd } as unknown as RedisClient;
    await new SharedScheduler(redis).drainDue(vi.fn().mockRejectedValue(new Error('send failed')), 200);
    expect(zadd).toHaveBeenCalledOnce();
    expect(JSON.parse(zadd.mock.calls[0][2])).toMatchObject({ attempts: 1 });
  });

  it('is idempotent when two Worker isolates see the same due member', async () => {
    const member = JSON.stringify({ id: 'same', type: 'reminder', chatId: 1, sessionKey: '1', nextAt: 100, createdAt: 0, payload: { text: 'once' } } satisfies ScheduledJob);
    let claimed = false;
    const redis = {
      zrangeByScore: vi.fn().mockResolvedValue([member]),
      zrem: vi.fn().mockImplementation(async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      }),
      zadd: vi.fn(),
    } as unknown as RedisClient;
    const handler = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      new SharedScheduler(redis).drainDue(handler, 200),
      new SharedScheduler(redis).drainDue(handler, 200),
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('limits each cron drain to three due jobs', async () => {
    const members = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      id: `job-${index}`,
      type: 'reminder',
      chatId: 1,
      sessionKey: 'private:1',
      nextAt: 100 + index,
      createdAt: 0,
      payload: { text: `Reminder ${index}` },
    } satisfies ScheduledJob));
    const zrangeByScore = vi.fn().mockImplementation(async (_key, _min, _max, limit) => members.slice(0, limit));
    const redis = {
      zrangeByScore,
      zrem: vi.fn().mockResolvedValue(true),
      zadd: vi.fn(),
    } as unknown as RedisClient;
    const handler = vi.fn().mockResolvedValue(undefined);

    await expect(new SharedScheduler(redis).drainDue(handler, 200)).resolves.toBe(3);
    expect(zrangeByScore).toHaveBeenCalledWith('schedule:v1:due', 0, 200, 3);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
