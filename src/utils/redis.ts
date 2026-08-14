import { Env, getConfig } from '../env';
import { globalFetch } from './helpers';

type AppConfig = ReturnType<typeof getConfig>;

type RedisCommand = (string | number)[];
type RedisValue = string | number | boolean | null | RedisValue[] | { [key: string]: RedisValue };

interface RedisResponse<T> {
  result: T;
  error?: string;
}

interface RedisPipelineResponseItem {
  result: RedisValue;
  error?: string;
}

/**
 * Thrown when `withLock` exhausts its retry budget. Callers and HTTP handlers
 * can treat this as "retry later" rather than a generic server fault.
 */
export class LockContentionError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(`Failed to acquire lock: ${scope}`);
    this.name = 'LockContentionError';
    this.scope = scope;
  }
}

export interface RedisClientDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// Compare-and-delete. Releasing without this is a read-then-delete race: an
// expired holder can delete the lock a different holder now owns.
const RELEASE_LOCK_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

export class RedisClient {
  private url: string;
  private token: string;
  private config: AppConfig;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(env: Env, dependencies: RedisClientDependencies = {}) {
    this.config = getConfig(env);
    this.url = this.config.upstashRedisRestUrl;
    this.token = this.config.upstashRedisRestToken;
    this.fetchImpl = dependencies.fetchImpl ?? globalFetch;
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  private async command<T>(args: RedisCommand): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      throw new Error(`Upstash HTTP ${response.status}: ${await response.text()}`);
    }

    const data: RedisResponse<T> = await response.json();
    if (data.error) {
      throw new Error(`Upstash error: ${data.error}`);
    }
    return data.result;
  }

  private async pipeline(commands: RedisCommand[]): Promise<RedisValue[]> {
    const response = await this.fetchImpl(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });

    if (!response.ok) {
      throw new Error(`Upstash pipeline HTTP ${response.status}: ${await response.text()}`);
    }

    const data: RedisPipelineResponseItem[] = await response.json();
    return data.map(item => {
      if (item.error) {
        throw new Error(`Upstash pipeline error: ${item.error}`);
      }
      return item.result;
    });
  }

  async get(key: string): Promise<string | null> {
    return (await this.command<string | null>(['GET', key])) ?? null;
  }

  async getMany(keys: string[]): Promise<Array<string | null>> {
    if (keys.length === 0) {
      return [];
    }

    const results = await this.pipeline(keys.map(key => ['GET', key]));
    return results.map((result): string | null => {
      if (typeof result !== 'string' && result !== null) {
        throw new Error('Unexpected Upstash pipeline result for GET');
      }
      return result as string | null;
    });
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const args: RedisCommand = ttl ? ['SET', key, value, 'EX', ttl] : ['SET', key, value];
    await this.command<string>(args);
  }

  async del(key: string): Promise<void> {
    await this.command<number>(['DEL', key]);
  }

  async incr(key: string): Promise<number> {
    return await this.command<number>(['INCR', key]);
  }

  async decr(key: string): Promise<number> {
    return await this.command<number>(['DECR', key]);
  }

  async incrWithTTL(key: string, ttlSeconds: number): Promise<number> {
    const [newValue] = await this.pipeline([
      ['INCR', key],
      ['EXPIRE', key, ttlSeconds, 'NX'],
    ]);
    if (typeof newValue !== 'number') {
      throw new Error('Unexpected Upstash pipeline result for INCR');
    }
    return newValue;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.command<number>(['ZADD', key, Math.trunc(score), member]);
  }

  async zrem(key: string, member: string): Promise<boolean> {
    return (await this.command<number>(['ZREM', key, member])) > 0;
  }

  async zrangeByScore(key: string, min: number, max: number, limit = 50): Promise<string[]> {
    return await this.command<string[]>(['ZRANGEBYSCORE', key, Math.trunc(min), Math.trunc(max), 'LIMIT', 0, limit]);
  }

  async zrangeAll(key: string, limit = 200): Promise<string[]> {
    return await this.command<string[]>(['ZRANGE', key, 0, Math.max(0, limit - 1)]);
  }

  async incrementHashWithTTL(
    key: string,
    increments: Record<string, number>,
    ttlSeconds: number,
  ): Promise<void> {
    const entries = Object.entries(increments).filter(([, value]) => Number.isFinite(value) && value !== 0);
    if (entries.length === 0) {
      return;
    }

    await this.pipeline([
      ...entries.map(([field, value]): RedisCommand => ['HINCRBY', key, field, Math.trunc(value)]),
      ['EXPIRE', key, ttlSeconds],
    ]);
  }

  async getHash(key: string): Promise<Record<string, number>> {
    const result = await this.command<string[] | Record<string, string> | null>(['HGETALL', key]);
    if (!result) {
      return {};
    }

    const output: Record<string, number> = {};
    if (!Array.isArray(result)) {
      for (const [field, rawValue] of Object.entries(result)) {
        const value = Number(rawValue);
        if (Number.isFinite(value)) {
          output[field] = value;
        }
      }
      return output;
    }

    for (let index = 0; index + 1 < result.length; index += 2) {
      const value = Number(result[index + 1]);
      if (Number.isFinite(value)) {
        output[result[index]] = value;
      }
    }
    return output;
  }

  private async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.command<string | null>(['SET', key, value, 'EX', ttlSeconds, 'NX']);
    return result === 'OK';
  }

  async setIfNotExists(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return await this.setNX(key, value, ttlSeconds);
  }

  /**
   * Run `fn` while holding a distributed lock.
   *
   * `ttlSeconds` must exceed the worst-case duration of `fn`, or the lock
   * expires mid-flight and stops excluding anyone. Pass an explicit value at
   * any call site that performs network I/O inside the lock.
   *
   * Throws {@link LockContentionError} when the retry budget is exhausted.
   */
  async withLock<T>(
    scope: string,
    fn: () => Promise<T>,
    options: { ttlSeconds?: number; retries?: number; backoffMs?: number } = {},
  ): Promise<T> {
    const ttl = options.ttlSeconds ?? 5;
    const retries = options.retries ?? 25;
    const backoffMs = options.backoffMs ?? 40;
    const lockKey = `lock:${scope}`;
    const token = crypto.randomUUID();

    for (let attempt = 0; attempt < retries; attempt++) {
      if (await this.setNX(lockKey, token, ttl)) {
        try {
          return await fn();
        } finally {
          // A failed release must never mask the outcome of `fn`; the lock
          // expires on its own TTL regardless.
          await this.releaseLock(lockKey, token).catch(error => {
            console.error(`Failed to release lock ${scope}:`, error);
          });
        }
      }
      await this.sleep(backoffMs + Math.random() * backoffMs);
    }

    throw new LockContentionError(scope);
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    await this.command<number>(['EVAL', RELEASE_LOCK_SCRIPT, 1, lockKey, token]);
  }

  async appendContext(userId: string, newContext: string): Promise<void> {
    const key = `context:${userId}`;
    const existingContext = await this.get(key);
    const updatedContext = existingContext
      ? `${existingContext}\n${newContext}`
      : newContext;
    await this.set(key, updatedContext, this.config.contextTTL);
  }
}
