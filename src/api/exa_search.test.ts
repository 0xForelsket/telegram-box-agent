import { afterEach, describe, expect, it, vi } from 'vitest';
import ExaSearchAPI from './exa_search';
import { Env } from '../env';
import { parseSearchQuery } from '../search/query_parser';

function env(): Env {
  return {
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODELS: '', TELEGRAM_BOT_TOKEN: 't', WHITELISTED_USERS: '1',
    SYSTEM_INIT_MESSAGE: 'test', SYSTEM_INIT_MESSAGE_ROLE: 'system', DEFAULT_MODEL: 'gemini',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'r',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4', GOOGLE_MODEL_KEY: 'g', GOOGLE_MODELS: 'gemini',
    GROQ_API_KEY: '', GROQ_MODELS: '', CLAUDE_API_KEY: '', CLAUDE_MODELS: '', AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
    EXA_API_KEY: 'exa-key',
  };
}

describe('ExaSearchAPI contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps mocked Exa results into the normalized provider contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      requestId: 'request-1',
      results: [{
        title: ' Result ', url: 'https://example.com/a', publishedDate: '2026-08-01', author: 'Author',
        highlights: [' useful   snippet '],
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const result = await new ExaSearchAPI(env()).search(parseSearchQuery('chips site:example.com', 3), signal);

    expect(result).toMatchObject({ provider: 'exa', query: 'chips site:example.com' });
    expect(result.sources).toEqual([{
      title: 'Result', url: 'https://example.com/a', publishedAt: '2026-08-01', author: 'Author', snippet: 'useful snippet',
    }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ query: 'chips site:example.com', numResults: 3 });
    // fetchJson combines the caller's signal with its own timeout backstop, so
    // the forwarded signal is no longer identity-equal to the one passed in.
    // What matters is that caller cancellation still reaches fetch.
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it('forwards caller cancellation through the timeout-combined signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ requestId: 'request-1', results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await new ExaSearchAPI(env()).search(parseSearchQuery('chips'), controller.signal);
    const forwarded = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(forwarded.aborted).toBe(false);

    controller.abort();
    expect(forwarded.aborted).toBe(true);
  });

  it('classifies authentication failures as non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));
    await expect(new ExaSearchAPI(env()).search(parseSearchQuery('chips'), new AbortController().signal))
      .rejects.toMatchObject({ provider: 'exa', retryable: false, category: 'auth' });
  });
});
