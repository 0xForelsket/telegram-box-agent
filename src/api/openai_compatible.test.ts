import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAICompatibleAPI, { normalizeOpenAICompatibleBaseUrl } from './openai_compatible';
import { Env } from '../env';

function createEnv(overrides: Partial<Env> = {}): Env {
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
    GOOGLE_MODEL_KEY: '',
    GOOGLE_MODELS: '',
    GROQ_API_KEY: '',
    GROQ_MODELS: '',
    CLAUDE_API_KEY: '',
    CLAUDE_MODELS: '',
    AZURE_API_KEY: '',
    AZURE_MODELS: '',
    AZURE_ENDPOINT: '',
    OPENAI_COMPATIBLE_KEY: 'compatible-key',
    OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com/v1',
    OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-pro',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeOpenAICompatibleBaseUrl', () => {
  it('accepts base URLs with or without a trailing /v1', () => {
    expect(normalizeOpenAICompatibleBaseUrl('https://provider.example')).toBe('https://provider.example');
    expect(normalizeOpenAICompatibleBaseUrl('https://provider.example/')).toBe('https://provider.example');
    expect(normalizeOpenAICompatibleBaseUrl('https://provider.example/v1')).toBe('https://provider.example');
    expect(normalizeOpenAICompatibleBaseUrl('https://provider.example/v1/')).toBe('https://provider.example');
  });

  it('passes tool definitions through chat completions', async () => {
    const requestBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === 'https://api.deepseek.com/v1/models') {
        return Response.json({ data: [{ id: 'deepseek-v4-pro' }] });
      }
      if (url === 'https://api.deepseek.com/v1/chat/completions') {
        requestBodies.push(JSON.parse(init?.body as string));
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-pro',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const api = new OpenAICompatibleAPI(createEnv());
    await api.createChatCompletion(
      [{ role: 'user', content: 'look up this thing' }],
      'deepseek-v4-pro',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        }],
        toolChoice: 'auto',
      },
    );

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      tools: [{ function: { name: 'web_search' } }],
      tool_choice: 'auto',
    });
  });
});

const CONFIG = {
  apiKey: 'compatible-key',
  baseUrl: 'https://provider.example',
  models: ['configured-model'],
};

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

const CHAT_OK = { choices: [{ message: { content: 'ok' } }] };

describe('OpenAICompatibleAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    expect(new OpenAICompatibleAPI(undefined, { config: CONFIG }).getDefaultModel()).toBe('configured-model');
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new OpenAICompatibleAPI()).toThrow('requires an Env or an explicit config');
  });

  it('refuses to call an unconfigured provider', async () => {
    const api = new OpenAICompatibleAPI(undefined, { config: { ...CONFIG, apiKey: '' } });

    await expect(api.createChatCompletion([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('OpenAI Compatible API is not configured');
  });

  it('merges discovered models with the configured ones', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: 'discovered-model' }] })) as unknown as typeof fetch;
    const api = new OpenAICompatibleAPI(undefined, { config: CONFIG, fetchImpl });

    expect(await api.getModels()).toEqual(['configured-model', 'discovered-model']);
    expect(calls(fetchImpl)[0][0]).toBe('https://provider.example/v1/models');
  });

  it('ignores malformed entries in the discovery payload', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      data: [{ id: 'good' }, {}, { id: '' }, null],
    })) as unknown as typeof fetch;
    const api = new OpenAICompatibleAPI(undefined, { config: CONFIG, fetchImpl });

    expect(await api.getModels()).toEqual(['configured-model', 'good']);
  });

  it('keeps serving configured models when discovery fails', async () => {
    // Discovery is an optimisation. A provider whose /models endpoint is down
    // must not take the whole chat path with it.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response('unavailable', { status: 503 });
      return Response.json(CHAT_OK);
    }) as unknown as typeof fetch;
    const api = new OpenAICompatibleAPI(undefined, { config: CONFIG, fetchImpl });

    expect(await api.getModels()).toEqual(['configured-model']);
    await expect(api.generateResponse([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
  });

  it('surfaces the discovery failure when nothing is configured to fall back to', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    const api = new OpenAICompatibleAPI(undefined, { config: { ...CONFIG, models: [] }, fetchImpl });

    await expect(api.getModels()).rejects.toThrow('Failed to fetch models');
  });

  it('discovers models only once', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: 'discovered' }] })) as unknown as typeof fetch;
    const api = new OpenAICompatibleAPI(undefined, { config: CONFIG, fetchImpl });

    await api.getModels();
    await api.getModels();

    expect(calls(fetchImpl).filter(([url]) => String(url).endsWith('/models'))).toHaveLength(1);
  });

  it('maps prompt-cache counters onto the shared usage shape', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [] });
      return Response.json({
        ...CHAT_OK,
        usage: {
          prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
          prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4,
        },
      });
    }) as unknown as typeof fetch;
    const api = new OpenAICompatibleAPI(undefined, { config: CONFIG, fetchImpl });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage).toEqual({
      promptTokens: 10, completionTokens: 4, totalTokens: 14,
      cacheHitTokens: 6, cacheMissTokens: 4,
    });
  });
});
