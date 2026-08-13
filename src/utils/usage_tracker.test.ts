import { describe, expect, it, vi } from 'vitest';
import { RedisClient } from './redis';
import { UsageTracker } from './usage_tracker';

describe('UsageTracker', () => {
  it('writes bounded daily and monthly aggregate increments', async () => {
    const incrementHashWithTTL = vi.fn().mockResolvedValue(undefined);
    const tracker = new UsageTracker({ incrementHashWithTTL } as unknown as RedisClient);

    await tracker.recordModelCall({
      provider: 'openai_compatible',
      model: 'deepseek-v4-flash',
      mode: 'chat',
      latencyMs: 750,
      success: true,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
      },
    });

    expect(incrementHashWithTTL).toHaveBeenCalledTimes(2);
    const dailyIncrements = incrementHashWithTTL.mock.calls[0][1] as Record<string, number>;
    expect(dailyIncrements).toMatchObject({
      calls: 1,
      successes: 1,
      prompt_tokens: 100,
      cache_hit_tokens: 80,
      cache_miss_tokens: 20,
      'model.deepseek-v4-flash.calls': 1,
      'provider.openai_compatible.successes': 1,
      'mode.chat.calls': 1,
      'latency_bucket.1000': 1,
    });
    expect(incrementHashWithTTL.mock.calls[0][2]).toBe(35 * 24 * 60 * 60);
    expect(incrementHashWithTTL.mock.calls[1][2]).toBe(400 * 24 * 60 * 60);
  });

  it('derives recent provider health from daily call aggregates', async () => {
    const getHash = vi.fn().mockResolvedValue({
      'provider.openai.calls': 10,
      'provider.openai.successes': 9,
      'provider.openai.errors': 1,
      'provider.openai.error.timeout': 1,
      'search_provider.exa.calls': 4,
      'search_provider.exa.errors': 2,
      'search_provider.exa.successes': 2,
      'search_provider.exa.error.quota': 2,
    });
    const tracker = new UsageTracker({ getHash } as unknown as RedisClient);

    await expect(tracker.getProviderHealth('model', ['openai'], new Date('2026-08-12T00:00:00Z')))
      .resolves.toEqual([{ provider: 'openai', calls: 10, successes: 9, errors: 1, status: 'healthy', errorCategories: { timeout: 1 } }]);
    await expect(tracker.getProviderHealth('search', ['exa'], new Date('2026-08-12T00:00:00Z')))
      .resolves.toEqual([{ provider: 'exa', calls: 4, successes: 2, errors: 2, status: 'degraded', errorCategories: { quota: 2 } }]);
  });

  it('records model and search failure categories per provider', async () => {
    const incrementHashWithTTL = vi.fn().mockResolvedValue(undefined);
    const tracker = new UsageTracker({ incrementHashWithTTL } as unknown as RedisClient);

    await tracker.recordModelCall({
      provider: 'openai_compatible', model: 'deepseek-test', mode: 'chat_tools',
      latencyMs: 200, success: false, errorCategory: 'auth',
    });
    await tracker.recordSearchCall('exa', false, { category: 'timeout' });

    expect(incrementHashWithTTL.mock.calls[0][1]).toMatchObject({
      'provider.openai_compatible.error.auth': 1,
    });
    expect(incrementHashWithTTL.mock.calls[2][1]).toMatchObject({
      'search_provider.exa.error.timeout': 1,
    });
  });

  it('calculates aggregate and model cache reports', async () => {
    const values = {
      calls: 10,
      successes: 9,
      errors: 1,
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      cache_hit_tokens: 700,
      cache_miss_tokens: 300,
      latency_ms: 12000,
      'latency_bucket.500': 2,
      'latency_bucket.1000': 5,
      'latency_bucket.2000': 3,
      'model.deepseek-v4-flash.calls': 8,
      'model.deepseek-v4-flash.prompt_tokens': 900,
      'model.deepseek-v4-flash.cache_hit_tokens': 650,
      'model.deepseek-v4-flash.cache_miss_tokens': 250,
    };
    const getHash = vi.fn().mockResolvedValue(values);
    const tracker = new UsageTracker({ getHash } as unknown as RedisClient);

    const report = await tracker.getReport('day', new Date('2026-08-12T00:00:00.000Z'));
    expect(report).toMatchObject({ period: '2026-08-12', calls: 10, p95LatencyMs: 2000 });

    const cache = await tracker.getModelCacheReport('month', 'deepseek-v4-flash', new Date('2026-08-12T00:00:00.000Z'));
    expect(cache).toMatchObject({
      period: '2026-08',
      calls: 8,
      promptTokens: 900,
      cacheHitTokens: 650,
      cacheMissTokens: 250,
    });
  });
});
