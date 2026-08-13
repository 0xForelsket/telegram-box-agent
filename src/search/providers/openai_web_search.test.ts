import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../../env';
import { parseSearchQuery } from '../query_parser';
import { OpenAIWebSearchProvider } from './openai_web_search';

function createEnv(): Env {
  return {
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODELS: '',
    OPENAI_SEARCH_API_KEY: 'search-key',
    OPENAI_SEARCH_MODEL: 'gpt-5-mini',
    TELEGRAM_BOT_TOKEN: 'token',
    WHITELISTED_USERS: '42',
    SYSTEM_INIT_MESSAGE: 'system',
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

describe('OpenAIWebSearchProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extracts answer text and sources from Responses API output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      output: [
        {
          type: 'web_search_call',
          action: { sources: [{ title: 'Primary source', url: 'https://example.com/source' }] },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Grounded answer',
            annotations: [{ type: 'url_citation', title: 'Second source', url: 'https://example.org/article' }],
          }],
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIWebSearchProvider(createEnv());
    const result = await provider.search(parseSearchQuery('latest chips'), new AbortController().signal);

    expect(result.answer).toBe('Grounded answer');
    expect(result.sources).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('marks authentication failures as non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));
    const provider = new OpenAIWebSearchProvider(createEnv());
    await expect(provider.search(parseSearchQuery('topic'), new AbortController().signal))
      .rejects.toMatchObject({ retryable: false, category: 'auth' });
  });
});
