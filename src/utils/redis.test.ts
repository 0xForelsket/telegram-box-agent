import { describe, expect, it, vi } from 'vitest';
import { Env } from '../env';
import { LockContentionError, RedisClient } from './redis';

function createEnv(): Env {
  return {
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    WHITELISTED_USERS: '',
    SYSTEM_INIT_MESSAGE: 'test',
    SYSTEM_INIT_MESSAGE_ROLE: 'system',
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    CLOUDFLARE_API_TOKEN: '',
    CLOUDFLARE_ACCOUNT_ID: '',
    FLUX_STEPS: '4',
    GOOGLE_MODEL_KEY: 'google-key',
    GOOGLE_MODELS: 'gemini-test',
    GROQ_API_KEY: '',
    GROQ_MODELS: '',
    CLAUDE_API_KEY: '',
    CLAUDE_MODELS: '',
    AZURE_API_KEY: '',
    AZURE_MODELS: '',
    AZURE_ENDPOINT: '',
  };
}

interface RecordedCall {
  url: string;
  command: (string | number)[];
}

/**
 * Minimal in-memory stand-in for the Upstash REST endpoint. It understands the
 * handful of commands `withLock` depends on, including the EVAL
 * compare-and-delete, so lock semantics are exercised end to end.
 */
class FakeUpstash {
  readonly store = new Map<string, string>();
  readonly calls: RecordedCall[] = [];
  failNextEval = false;

  readonly fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '[]')) as (string | number)[] | (string | number)[][];

    if (url.endsWith('/pipeline')) {
      const commands = body as (string | number)[][];
      return this.json(commands.map(command => ({ result: this.run(command) })));
    }

    const command = body as (string | number)[];
    this.calls.push({ url, command });
    if (command[0] === 'EVAL' && this.failNextEval) {
      this.failNextEval = false;
      return this.json({ result: null, error: 'NOSCRIPT' });
    }
    return this.json({ result: this.run(command) });
  }) as typeof fetch;

  private run(command: (string | number)[]): unknown {
    const [name, ...args] = command.map(String);
    switch (name) {
      case 'GET':
        return this.store.get(args[0]) ?? null;
      case 'DEL': {
        const existed = this.store.delete(args[0]);
        return existed ? 1 : 0;
      }
      case 'SET': {
        const [key, value, ...rest] = args;
        if (rest.includes('NX') && this.store.has(key)) return null;
        this.store.set(key, value);
        return 'OK';
      }
      case 'EVAL': {
        // ['EVAL', script, numkeys, key, arg]
        const key = args[2];
        const token = args[3];
        if (this.store.get(key) === token) {
          this.store.delete(key);
          return 1;
        }
        return 0;
      }
      default:
        return null;
    }
  }

  private json(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  evalCalls(): RecordedCall[] {
    return this.calls.filter(call => call.command[0] === 'EVAL');
  }
}

function createClient(fake: FakeUpstash, sleep = async () => {}) {
  return new RedisClient(createEnv(), { fetchImpl: fake.fetchImpl, sleep });
}

describe('RedisClient.withLock', () => {
  it('runs the callback and releases the lock afterwards', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    const result = await redis.withLock('scope-a', async () => 'done');

    expect(result).toBe('done');
    expect(fake.store.has('lock:scope-a')).toBe(false);
  });

  it('releases with a compare-and-delete rather than a bare DEL', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    await redis.withLock('scope-a', async () => 'done');

    // A read-then-delete release would show up as GET + DEL. The whole point of
    // the Lua script is that the check and the delete are one operation.
    expect(fake.evalCalls()).toHaveLength(1);
    expect(fake.calls.some(call => call.command[0] === 'DEL')).toBe(false);
  });

  it('does not delete a lock that another holder now owns', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    // Simulate the original TOCTOU hazard: our lock expires mid-callback and a
    // different holder takes the same key before we release.
    const result = await redis.withLock('scope-a', async () => {
      fake.store.set('lock:scope-a', 'other-holder-token');
      return 'done';
    });

    expect(result).toBe('done');
    expect(fake.store.get('lock:scope-a')).toBe('other-holder-token');
  });

  it('excludes a second caller while the lock is held', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = redis.withLock('scope-a', async () => { await held; return 'first'; });

    await expect(
      redis.withLock('scope-a', async () => 'second', { retries: 2 }),
    ).rejects.toBeInstanceOf(LockContentionError);

    release!();
    await expect(first).resolves.toBe('first');
  });

  it('acquires once a competing holder releases', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);
    fake.store.set('lock:scope-a', 'someone-else');

    const sleep = vi.fn(async () => { fake.store.delete('lock:scope-a'); });
    const contended = new RedisClient(createEnv(), { fetchImpl: fake.fetchImpl, sleep });

    await expect(contended.withLock('scope-a', async () => 'acquired')).resolves.toBe('acquired');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws LockContentionError, not a generic Error, when contended', async () => {
    const fake = new FakeUpstash();
    fake.store.set('lock:scope-a', 'someone-else');
    const redis = createClient(fake);

    const error = await redis.withLock('scope-a', async () => 'never', { retries: 1 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LockContentionError);
    expect((error as LockContentionError).scope).toBe('scope-a');
  });

  it('propagates callback failures and still releases the lock', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    await expect(
      redis.withLock('scope-a', async () => { throw new Error('callback exploded'); }),
    ).rejects.toThrow('callback exploded');
    expect(fake.store.has('lock:scope-a')).toBe(false);
  });

  it('does not let a release failure mask the callback result', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);
    fake.failNextEval = true;

    await expect(redis.withLock('scope-a', async () => 'done')).resolves.toBe('done');
  });

  it('does not let a release failure mask a callback error', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);
    fake.failNextEval = true;

    await expect(
      redis.withLock('scope-a', async () => { throw new Error('callback exploded'); }),
    ).rejects.toThrow('callback exploded');
  });

  it('honours an explicit ttl for long-running work', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    await redis.withLock('scope-a', async () => 'done', { ttlSeconds: 120 });

    const set = fake.calls.find(call => call.command[0] === 'SET');
    expect(set?.command).toContain(120);
  });
});

describe('RedisClient basics', () => {
  it('round-trips values and reports missing keys as null', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    await redis.set('greeting', 'hello');

    expect(await redis.get('greeting')).toBe('hello');
    expect(await redis.get('absent')).toBeNull();
  });

  it('reads many keys in a single pipeline round trip', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);
    await redis.set('a', '1');
    await redis.set('b', '2');

    const before = fake.calls.length;
    expect(await redis.getMany(['a', 'missing', 'b'])).toEqual(['1', null, '2']);
    // Pipeline requests are not recorded in `calls`, so a single batched call
    // means no additional per-key commands were issued.
    expect(fake.calls.length).toBe(before);
  });

  it('returns an empty array without calling Redis for no keys', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    expect(await redis.getMany([])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('surfaces Upstash errors', async () => {
    const fake = new FakeUpstash();
    const failing: typeof fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const redis = new RedisClient(createEnv(), { fetchImpl: failing, sleep: async () => {} });

    await expect(redis.get('anything')).rejects.toThrow('Upstash HTTP 500');
    expect(fake.calls).toHaveLength(0);
  });

  it('sets a lock key only when absent', async () => {
    const fake = new FakeUpstash();
    const redis = createClient(fake);

    expect(await redis.setIfNotExists('once', 'first', 30)).toBe(true);
    expect(await redis.setIfNotExists('once', 'second', 30)).toBe(false);
    expect(fake.store.get('once')).toBe('first');
  });
});
