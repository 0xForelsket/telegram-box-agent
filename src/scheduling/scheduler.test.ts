import { describe, expect, it, vi } from 'vitest';
import { LuaRedis } from '../test/lua_redis';
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

  function fixture(recurrence?: 'daily') {
    const redis = new LuaRedis();
    const scheduler = new SharedScheduler(redis as unknown as RedisClient);
    const job: ScheduledJob = { id: 'a', type: 'reminder', chatId: 1, sessionKey: 'private:1', nextAt: redis.now, createdAt: 0, recurrence, payload: { text: 'hello' } };
    return { redis, scheduler, job };
  }

  it('claims each occurrence once across concurrent drains', async () => {
    const { redis, scheduler, job } = fixture('daily');
    await scheduler.schedule(job);
    const handler = vi.fn().mockResolvedValue(undefined);
    await Promise.all([scheduler.drainDue(handler, redis.now), scheduler.drainDue(handler, redis.now)]);
    expect(handler).toHaveBeenCalledOnce();
    expect((await scheduler.list(job.sessionKey))[0].nextAt).toBe(job.nextAt + 86400000);
  });

  it('retains the original occurrence when the process loses its finish write', async () => {
    const { redis, scheduler, job } = fixture();
    await scheduler.schedule(job);
    const evaluate = redis.eval.bind(redis);
    let crash = true;
    vi.spyOn(redis, 'eval').mockImplementation(async (script, keys, args) => {
      if (crash && script.includes("'ZREM'")) throw new Error('process died');
      return evaluate(script, keys, args);
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    await expect(scheduler.drainDue(handler, redis.now)).rejects.toThrow('process died');
    expect(await scheduler.list(job.sessionKey)).toHaveLength(1);
    await scheduler.drainDue(handler, redis.now);
    expect(handler).toHaveBeenCalledOnce();
    crash = false;
    redis.now += 150001;
    await scheduler.drainDue(handler, redis.now);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await scheduler.list(job.sessionKey)).toEqual([]);
  });

  it('anchors recurring retries to the original slot and preserves recurring jobs after exhaustion', async () => {
    const { redis, scheduler, job } = fixture('daily');
    await scheduler.schedule(job);
    const fail = vi.fn().mockRejectedValue(new Error('telegram down'));
    for (let i = 0; i < 4; i++) {
      await scheduler.drainDue(fail, redis.now);
      const next = (await scheduler.list(job.sessionKey))[0];
      if (i < 3) expect(next.slotAt).toBe(job.nextAt);
      redis.now = next.nextAt;
    }
    expect(redis.now).toBe(job.nextAt + 86400000);
    expect((await scheduler.list(job.sessionKey))[0].attempts).toBe(0);
  });

  it('does not recreate a canceled recurring job when an in-flight delivery finishes', async () => {
    const { redis, scheduler, job } = fixture('daily');
    await scheduler.schedule(job);
    await scheduler.drainDue(async () => { await scheduler.cancel(job.sessionKey, job.id); }, redis.now);
    expect(await scheduler.list(job.sessionKey)).toEqual([]);
  });

  it('bounds each drain to three occurrences', async () => {
    const { redis, scheduler, job } = fixture();
    for (let i = 0; i < 5; i++) await scheduler.schedule({ ...job, id: String(i) });
    expect(await scheduler.drainDue(async () => {}, redis.now)).toBe(3);
    expect(await scheduler.list(job.sessionKey)).toHaveLength(2);
  });
});
