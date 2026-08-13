import { ModelUsage } from '../api/model_api_interface';
import { RedisClient } from './redis';

export type ModelRequestMode =
  | 'chat'
  | 'chat_tools'
  | 'research'
  | 'compare'
  | 'utility'
  | 'transcription'
  | 'tts'
  | 'memory_extract'
  | 'summary'
  | 'agent_plan'
  | 'agent_step'
  | 'vision'
  | 'image';

export interface ModelCallRecord {
  provider: string;
  model: string;
  mode: ModelRequestMode;
  latencyMs: number;
  success: boolean;
  usage?: ModelUsage;
  errorCategory?: string;
}

export interface UsageReport {
  period: string;
  calls: number;
  successes: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalLatencyMs: number;
  p95LatencyMs: number | null;
  searchCalls: number;
}

export interface ModelCacheReport {
  period: string;
  model: string;
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ProviderHealth {
  provider: string;
  calls: number;
  successes: number;
  errors: number;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  errorCategories: Record<string, number>;
}

const ERROR_CATEGORIES = ['auth', 'quota', 'timeout', 'invalid_request', 'upstream', 'request', 'empty', 'other', 'unknown'];

const DAILY_TTL_SECONDS = 35 * 24 * 60 * 60;
const MONTHLY_TTL_SECONDS = 400 * 24 * 60 * 60;

export class UsageTracker {
  constructor(private readonly redis: RedisClient) {}

  async recordModelCall(record: ModelCallRecord): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const increments = this.buildIncrements(record);

    await Promise.all([
      this.redis.incrementHashWithTTL(this.getDayKey(day), increments, DAILY_TTL_SECONDS),
      this.redis.incrementHashWithTTL(this.getMonthKey(month), increments, MONTHLY_TTL_SECONDS),
    ]);
  }

  async getReport(scope: 'day' | 'month', date = new Date()): Promise<UsageReport> {
    const day = date.toISOString().slice(0, 10);
    const period = scope === 'day' ? day : day.slice(0, 7);
    const values = await this.redis.getHash(scope === 'day' ? this.getDayKey(period) : this.getMonthKey(period));

    return {
      period,
      calls: values.calls || 0,
      successes: values.successes || 0,
      errors: values.errors || 0,
      promptTokens: values.prompt_tokens || 0,
      completionTokens: values.completion_tokens || 0,
      totalTokens: values.total_tokens || 0,
      cacheHitTokens: values.cache_hit_tokens || 0,
      cacheMissTokens: values.cache_miss_tokens || 0,
      totalLatencyMs: values.latency_ms || 0,
      p95LatencyMs: this.estimateP95Latency(values),
      searchCalls: values.search_calls || 0,
    };
  }

  async recordSearchCall(
    provider: string,
    success: boolean,
    details: { latencyMs?: number; fallback?: boolean; category?: string } = {},
  ): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const providerKey = this.safeDimension(provider);
    const increments = {
      search_calls: 1,
      [success ? 'search_successes' : 'search_errors']: 1,
      [`search_provider.${providerKey}.calls`]: 1,
      [`search_provider.${providerKey}.${success ? 'successes' : 'errors'}`]: 1,
      search_latency_ms: Math.max(0, Math.round(details.latencyMs || 0)),
      search_fallback_attempts: details.fallback ? 1 : 0,
      ...(details.category ? {
        [`search_error.${this.safeDimension(details.category)}`]: 1,
        [`search_provider.${providerKey}.error.${this.safeDimension(details.category)}`]: 1,
      } : {}),
    };

    await Promise.all([
      this.redis.incrementHashWithTTL(this.getDayKey(day), increments, DAILY_TTL_SECONDS),
      this.redis.incrementHashWithTTL(this.getMonthKey(month), increments, MONTHLY_TTL_SECONDS),
    ]);
  }

  async getModelCacheReport(
    scope: 'day' | 'month',
    model: string,
    date = new Date(),
  ): Promise<ModelCacheReport> {
    const day = date.toISOString().slice(0, 10);
    const period = scope === 'day' ? day : day.slice(0, 7);
    const values = await this.redis.getHash(scope === 'day' ? this.getDayKey(period) : this.getMonthKey(period));
    const modelKey = `model.${this.safeDimension(model)}`;
    return {
      period,
      model,
      calls: values[`${modelKey}.calls`] || 0,
      promptTokens: values[`${modelKey}.prompt_tokens`] || 0,
      cacheHitTokens: values[`${modelKey}.cache_hit_tokens`] || 0,
      cacheMissTokens: values[`${modelKey}.cache_miss_tokens`] || 0,
    };
  }

  async getProviderHealth(
    kind: 'model' | 'search',
    providers: string[],
    date = new Date(),
  ): Promise<ProviderHealth[]> {
    const day = date.toISOString().slice(0, 10);
    const values = await this.redis.getHash(this.getDayKey(day));
    return providers.map(provider => {
      const safeProvider = this.safeDimension(provider);
      const prefix = kind === 'search' ? `search_provider.${safeProvider}` : `provider.${safeProvider}`;
      const calls = values[`${prefix}.calls`] || 0;
      const successes = values[`${prefix}.successes`] || 0;
      const errors = values[`${prefix}.errors`] || 0;
      const errorRate = calls > 0 ? errors / calls : 0;
      const errorCategories = Object.fromEntries(
        ERROR_CATEGORIES
          .map(category => [category, values[`${prefix}.error.${category}`] || 0] as const)
          .filter(([, count]) => count > 0),
      );
      return {
        provider,
        calls,
        successes,
        errors,
        status: calls === 0
          ? 'unknown'
          : successes === 0 && errors >= 2
            ? 'down'
            : errorRate >= 0.35
              ? 'degraded'
              : 'healthy',
        errorCategories,
      };
    });
  }

  private buildIncrements(record: ModelCallRecord): Record<string, number> {
    const provider = this.safeDimension(record.provider);
    const model = this.safeDimension(record.model);
    const mode = this.safeDimension(record.mode);
    const usage = record.usage || {};
    const increments: Record<string, number> = {
      calls: 1,
      [record.success ? 'successes' : 'errors']: 1,
      latency_ms: Math.max(0, Math.round(record.latencyMs)),
      prompt_tokens: usage.promptTokens || 0,
      completion_tokens: usage.completionTokens || 0,
      total_tokens: usage.totalTokens || 0,
      cache_hit_tokens: usage.cacheHitTokens || 0,
      cache_miss_tokens: usage.cacheMissTokens || 0,
      [`provider.${provider}.calls`]: 1,
      [`provider.${provider}.${record.success ? 'successes' : 'errors'}`]: 1,
      [`model.${model}.calls`]: 1,
      [`mode.${mode}.calls`]: 1,
      [`latency_bucket.${this.getLatencyBucket(record.latencyMs)}`]: 1,
      [`model.${model}.prompt_tokens`]: usage.promptTokens || 0,
      [`model.${model}.cache_hit_tokens`]: usage.cacheHitTokens || 0,
      [`model.${model}.cache_miss_tokens`]: usage.cacheMissTokens || 0,
    };

    if (!record.success && record.errorCategory) {
      const errorCategory = this.safeDimension(record.errorCategory);
      increments[`error.${errorCategory}`] = 1;
      increments[`provider.${provider}.error.${errorCategory}`] = 1;
    }

    return increments;
  }

  private getLatencyBucket(latencyMs: number): string {
    const upperBounds = [250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
    return String(upperBounds.find(bound => latencyMs <= bound) || 'over_60000');
  }

  private estimateP95Latency(values: Record<string, number>): number | null {
    const buckets: Array<[string, number]> = [
      ['250', 250],
      ['500', 500],
      ['1000', 1000],
      ['2000', 2000],
      ['5000', 5000],
      ['10000', 10000],
      ['30000', 30000],
      ['60000', 60000],
      ['over_60000', 60001],
    ];
    const calls = values.calls || 0;
    if (calls === 0) {
      return null;
    }

    const target = Math.ceil(calls * 0.95);
    let cumulative = 0;
    for (const [field, upperBound] of buckets) {
      cumulative += values[`latency_bucket.${field}`] || 0;
      if (cumulative >= target) {
        return upperBound;
      }
    }
    return null;
  }

  private getDayKey(day: string): string {
    return `usage:v1:day:${day}`;
  }

  private getMonthKey(month: string): string {
    return `usage:v1:month:${month}`;
  }

  private safeDimension(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80) || 'unknown';
  }
}
