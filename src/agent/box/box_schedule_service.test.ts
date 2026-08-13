import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import type { createPiBoxSchedule } from './box_launcher';
import { BoxScheduleService } from './box_schedule_service';

class FakeRedis {
  values = new Map<string, string>();
  sorted = new Map<string, string[]>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async getMany(keys: string[]) { return keys.map(key => this.values.get(key) ?? null); }
  async set(key: string, value: string) { this.values.set(key, value); }
  async zadd(key: string, _score: number, member: string) { this.sorted.set(key, [...(this.sorted.get(key) ?? []), member]); }
  async zrangeAll(key: string, limit = 200) { return (this.sorted.get(key) ?? []).slice(0, limit); }
  async withLock<T>(_scope: string, action: () => Promise<T>) { return await action(); }
}

const env = {
  OPENAI_API_KEY: 'ordinary-chat-key',
  OWNER_USER_ID: 'owner', BOX_AGENT_ENABLED: 'true', UPSTASH_BOX_API_KEY: 'box-key',
  BOX_SNAPSHOT_ID: 'snapshot-1', BOX_CALLBACK_URL: 'https://worker.example/box/callback',
  BOX_CALLBACK_SECRET: 'box-callback-secret-that-is-definitely-long-enough',
  DEEPSEEK_API_KEY: 'deepseek-key', ZAI_CODING_PLAN_API_KEY: 'zai-key',
  QSTASH_CURRENT_SIGNING_KEY: 'qstash-current-signing-key',
  QSTASH_NEXT_SIGNING_KEY: 'qstash-next-signing-key',
} as Env;

describe('BoxScheduleService', () => {
  it('enforces owner management and retries each recurring result exactly once', async () => {
    const redis = new FakeRedis();
    let launchInput: Parameters<typeof createPiBoxSchedule>[0] | undefined;
    const createSchedule = vi.fn(async (input: Parameters<typeof createPiBoxSchedule>[0]) => {
      launchInput = input;
      return { boxId: 'box-schedule-1', scheduleId: 'upstream-schedule-1' };
    });
    const pause = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const deleteBox = vi.fn(async () => undefined);
    const get = vi.fn(async () => ({
      id: 'upstream-schedule-1', box_id: 'box-schedule-1', status: 'active' as const,
      last_run_id: 'scheduled-run-1', last_run_status: 'completed' as const,
      qstash_schedule_id: 'qstash-schedule-1',
    }));
    const getBox = vi.fn(async () => ({ schedule: { get, pause, resume, delete: remove }, delete: deleteBox }));
    const sendMessage = vi.fn(async () => undefined);
    const service = new BoxScheduleService(env, redis as unknown as RedisClient, sendMessage, {
      createSchedule, getBox, now: () => 1_000_000,
      verifyScheduleSignature: async () => true,
    });

    await expect(service.create({ chatId: -100, ownerUserId: 'member', cron: '0 9 * * *', prompt: 'daily code report' }))
      .rejects.toThrow('bot owner');
    const schedule = await service.create({ chatId: -100, ownerUserId: 'owner', cron: '0 9 * * *', prompt: 'daily code report' });
    expect(schedule).toMatchObject({ status: 'active', boxId: 'box-schedule-1', upstreamScheduleId: 'upstream-schedule-1' });
    expect(await service.list(-100, 'owner')).toHaveLength(1);

    sendMessage.mockRejectedValueOnce(new Error('Telegram unavailable'));
    const callback = () => new Request(launchInput!.webhook.url, {
      method: 'POST', headers: launchInput!.webhook.headers,
      body: JSON.stringify({ run_id: 'scheduled-run-1', status: 'completed', output: 'report ready' }),
    });
    await expect(service.handleCallback(callback())).rejects.toThrow('Telegram unavailable');
    expect((await service.handleCallback(callback())).status).toBe(200);
    expect((await service.handleCallback(callback())).status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    await service.change(-100, 'owner', schedule.id, 'pause');
    await service.change(-100, 'owner', schedule.id, 'resume');
    await service.change(-100, 'owner', schedule.id, 'delete');
    expect(pause).toHaveBeenCalledWith('upstream-schedule-1');
    expect(resume).toHaveBeenCalledWith('upstream-schedule-1');
    expect(remove).toHaveBeenCalledWith('upstream-schedule-1');
    expect(deleteBox).toHaveBeenCalledTimes(1);
  });

  it('requires a body-bound QStash signature, an active record, and a live upstream run', async () => {
    const redis = new FakeRedis();
    let launchInput: Parameters<typeof createPiBoxSchedule>[0] | undefined;
    const createSchedule = vi.fn(async (input: Parameters<typeof createPiBoxSchedule>[0]) => {
      launchInput = input;
      return { boxId: 'box-schedule-2', scheduleId: 'upstream-schedule-2' };
    });
    let signatureValid = false;
    let lastRunId = 'different-run';
    const upstream = () => ({
      id: 'upstream-schedule-2', box_id: 'box-schedule-2', status: 'active' as const,
      last_run_id: lastRunId, last_run_status: 'completed' as const,
    });
    const pause = vi.fn(async () => undefined);
    const service = new BoxScheduleService(env, redis as unknown as RedisClient, async () => undefined, {
      createSchedule,
      getBox: async () => ({
        schedule: { get: async () => upstream(), pause, resume: async () => undefined, delete: async () => undefined },
        delete: async () => undefined,
      }),
      verifyScheduleSignature: async () => signatureValid,
    });
    const schedule = await service.create({ chatId: -100, ownerUserId: 'owner', cron: '0 9 * * *', prompt: 'daily report' });
    const callback = () => new Request(launchInput!.webhook.url, {
      method: 'POST', headers: launchInput!.webhook.headers,
      body: JSON.stringify({ run_id: 'scheduled-run-2', status: 'completed', output: 'report ready' }),
    });

    expect((await service.handleCallback(callback())).status).toBe(401);
    signatureValid = true;
    expect((await service.handleCallback(callback())).status).toBe(409);
    lastRunId = 'scheduled-run-2';
    expect((await service.handleCallback(callback())).status).toBe(200);

    await service.change(-100, 'owner', schedule.id, 'pause');
    expect((await service.handleCallback(callback())).status).toBe(409);
  });
});
