import { describe, expect, it, vi } from 'vitest';
import { RedisClient } from '../utils/redis';
import { parseDigestInput, parseReminderInput, ScheduledJob, SharedScheduler } from './scheduler';

describe('SharedScheduler', () => {
  it('parses relative and wall-clock reminder times', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    expect(parseReminderInput('in 20m stretch', now)).toEqual({ dueAt: now.getTime() + 20 * 60_000, text: 'stretch' });
    expect(new Date(parseReminderInput('tomorrow 09:00 standup', now).dueAt).toISOString()).toBe('2026-08-13T09:00:00.000Z');
    expect(parseReminderInput('daily 09:00 standup', now)).toMatchObject({ recurrence: 'daily', text: 'standup' });
    expect(parseReminderInput('weekly mon 09:00 review', now)).toMatchObject({ recurrence: 'weekly', text: 'review' });
  });

  // The offset used to be hardcoded to +08:00, so every deployment's "09:00"
  // silently meant 09:00 in Malaysia.
  it('interprets wall-clock times in the supplied timezone', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');

    expect(new Date(parseReminderInput('tomorrow 09:00 standup', now, 'Asia/Kuala_Lumpur').dueAt).toISOString())
      .toBe('2026-08-13T01:00:00.000Z');
    // The same instant is still 2026-08-11 in New York, so "tomorrow" there is
    // 2026-08-12 — "today" has to be read in the target zone, not in UTC.
    expect(new Date(parseReminderInput('tomorrow 09:00 standup', now, 'America/New_York').dueAt).toISOString())
      .toBe('2026-08-12T13:00:00.000Z');
    // December is EST (-5), August is EDT (-4): a fixed offset cannot do this.
    expect(new Date(parseReminderInput('at 2026-12-25 09:00 gifts', now, 'America/New_York').dueAt).toISOString())
      .toBe('2026-12-25T14:00:00.000Z');
  });

  it('picks the weekday as seen in the supplied timezone', () => {
    // 2026-08-12T18:00Z is still Wednesday in UTC but already Thursday in
    // Auckland, so "weekly thu" resolves to a different instant in each zone.
    const now = new Date('2026-08-12T18:00:00.000Z');
    const utc = parseReminderInput('weekly thu 09:00 review', now, 'UTC').dueAt;
    const auckland = parseReminderInput('weekly thu 09:00 review', now, 'Pacific/Auckland').dueAt;

    expect(new Date(utc).toISOString()).toBe('2026-08-13T09:00:00.000Z');
    expect(new Date(auckland).toISOString()).toBe('2026-08-12T21:00:00.000Z');
  });

  it('parses bounded recurring digest schedules', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    expect(parseDigestInput('daily 08:30 search chip news', now)).toMatchObject({ recurrence: 'daily', mode: 'search', query: 'chip news' });
    expect(parseDigestInput('weekly fri 18:00 feeds', now)).toMatchObject({ recurrence: 'weekly', mode: 'feeds' });
  });

  it('carries the timezone into digest scheduling', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');

    expect(new Date(parseDigestInput('daily 08:30 feeds', now, 'Asia/Kuala_Lumpur').dueAt).toISOString())
      .toBe('2026-08-12T00:30:00.000Z');
    expect(new Date(parseDigestInput('daily 08:30 feeds', now, 'UTC').dueAt).toISOString())
      .toBe('2026-08-12T08:30:00.000Z');
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

  // The retry rewrote `nextAt`, and the next occurrence was computed from it,
  // so one transient failure moved a 09:00 daily reminder to 09:05 forever.
  it('anchors a recurrence to its original slot across a retry', async () => {
    const slot = 24 * 60 * 60_000;
    const day = 24 * 60 * 60_000;
    const job: ScheduledJob = {
      id: 'abc', type: 'reminder', chatId: 1, sessionKey: 'private:1',
      nextAt: slot, createdAt: 0, recurrence: 'daily', payload: { text: 'standup' },
    };
    const scheduled: ScheduledJob[] = [];
    const redis = {
      zrangeByScore: vi.fn().mockResolvedValue([JSON.stringify(job)]),
      zrem: vi.fn().mockResolvedValue(true),
      zadd: vi.fn(async (_key: string, _score: number, member: string) => {
        scheduled.push(JSON.parse(member));
      }),
    } as unknown as RedisClient;

    // First run fails and is retried five minutes later.
    await new SharedScheduler(redis).drainDue(vi.fn().mockRejectedValue(new Error('telegram down')), slot);
    const retry = scheduled[0];
    expect(retry).toMatchObject({ attempts: 1, slotAt: slot });
    expect(retry.nextAt).toBe(slot + 5 * 60_000);

    // The retry succeeds; the next occurrence must be one day after the slot,
    // not one day after the retry.
    const afterRetry = { ...retry };
    (redis.zrangeByScore as ReturnType<typeof vi.fn>).mockResolvedValue([JSON.stringify(afterRetry)]);
    await new SharedScheduler(redis).drainDue(vi.fn().mockResolvedValue(undefined), afterRetry.nextAt);

    expect(scheduled[1].nextAt).toBe(slot + day);
    expect(scheduled[1].attempts).toBe(0);
  });

  // Four minutes of upstream trouble should not delete a standing reminder.
  it('keeps a recurring job alive after its retries are exhausted', async () => {
    const slot = 24 * 60 * 60_000;
    const job: ScheduledJob = {
      id: 'abc', type: 'reminder', chatId: 1, sessionKey: 'private:1',
      nextAt: slot + 15 * 60_000, slotAt: slot, attempts: 3, createdAt: 0,
      recurrence: 'daily', payload: { text: 'standup' },
    };
    const zadd = vi.fn().mockResolvedValue(undefined);
    const redis = {
      zrangeByScore: vi.fn().mockResolvedValue([JSON.stringify(job)]),
      zrem: vi.fn().mockResolvedValue(true),
      zadd,
    } as unknown as RedisClient;

    await new SharedScheduler(redis).drainDue(vi.fn().mockRejectedValue(new Error('still down')), job.nextAt);

    expect(zadd).toHaveBeenCalledOnce();
    expect(JSON.parse(zadd.mock.calls[0][2])).toMatchObject({
      nextAt: slot + 24 * 60 * 60_000,
      attempts: 0,
    });
  });

  it('drops a one-off job once its retries are exhausted', async () => {
    const job: ScheduledJob = {
      id: 'abc', type: 'reminder', chatId: 1, sessionKey: 'private:1',
      nextAt: 100, attempts: 3, createdAt: 0, payload: { text: 'once' },
    };
    const zadd = vi.fn().mockResolvedValue(undefined);
    const redis = {
      zrangeByScore: vi.fn().mockResolvedValue([JSON.stringify(job)]),
      zrem: vi.fn().mockResolvedValue(true),
      zadd,
    } as unknown as RedisClient;

    await new SharedScheduler(redis).drainDue(vi.fn().mockRejectedValue(new Error('gone')), 200);

    expect(zadd).not.toHaveBeenCalled();
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
