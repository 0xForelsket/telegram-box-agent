import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../../env';
import { parseSearchQuery } from '../query_parser';
import { GeminiGroundingProvider } from './gemini_grounding';

function createEnv(): Env {
  return {
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'token', WHITELISTED_USERS: '42',
    SYSTEM_INIT_MESSAGE: 'system', SYSTEM_INIT_MESSAGE_ROLE: 'system',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'token',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4',
    GOOGLE_MODEL_KEY: 'gemini-key', GOOGLE_MODELS: 'gemini-2.5-flash-lite',
    GEMINI_SEARCH_MODEL: 'gemini-2.5-flash-lite',
    GROQ_API_KEY: '', GROQ_MODELS: '', CLAUDE_API_KEY: '', CLAUDE_MODELS: '',
    AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
  };
}

describe('GeminiGroundingProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extracts grounded answer text and URL citations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      steps: [{
        type: 'model_output',
        content: [{
          type: 'text',
          text: 'Grounded Gemini answer',
          annotations: [{ type: 'url_citation', title: 'Official source', url: 'https://example.com/official' }],
        }],
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiGroundingProvider(createEnv())
      .search(parseSearchQuery('latest official announcement'), new AbortController().signal);

    expect(result.answer).toBe('Grounded Gemini answer');
    expect(result.sources).toEqual([{ title: 'Official source', url: 'https://example.com/official' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('classifies quota responses as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota', { status: 429 })));
    await expect(new GeminiGroundingProvider(createEnv())
      .search(parseSearchQuery('topic'), new AbortController().signal))
      .rejects.toMatchObject({ retryable: true, category: 'quota' });
  });
});
