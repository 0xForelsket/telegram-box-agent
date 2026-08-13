import { describe, expect, it, vi } from 'vitest';
import GeminiAPI, { type GeminiApiConfig } from './gemini';

const CONFIG: GeminiApiConfig = {
  apiKey: 'google-key',
  baseUrl: 'https://gemini.example/v1beta',
  models: ['gemini-primary', 'gemini-backup'],
  defaultModel: 'gemini-primary',
};

function reply(text: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    ...extra,
  };
}

function jsonFetch(...payloads: Array<{ body: unknown; status?: number }>) {
  let index = 0;
  return vi.fn(async () => {
    const next = payloads[Math.min(index++, payloads.length - 1)];
    return new Response(
      typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
      { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

describe('GeminiAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    const api = new GeminiAPI(undefined, { config: CONFIG });

    expect(api.getDefaultModel()).toBe('gemini-primary');
    expect(api.getAvailableModels()).toEqual(['gemini-primary', 'gemini-backup']);
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new GeminiAPI()).toThrow('requires an Env or an explicit config');
  });

  it('calls generateContent on the default model with the api-key header', async () => {
    const fetchImpl = jsonFetch({ body: reply('hello') });
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([{ role: 'user', content: 'hi' }]);

    const [url, init] = calls(fetchImpl)[0];
    expect(url).toBe('https://gemini.example/v1beta/models/gemini-primary:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('google-key');
  });

  it('lifts system messages into systemInstruction rather than contents', async () => {
    const fetchImpl = jsonFetch({ body: reply('hello') });
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);

    const body = JSON.parse(calls(fetchImpl)[0][1].body as string);
    expect(body.systemInstruction.parts[0].text).toContain('be brief');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('joins multi-part candidate text', async () => {
    const api = new GeminiAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({
        body: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }, { text: 'lo' }] } }] },
      }),
    });

    expect(await api.generateResponse([{ role: 'user', content: 'hi' }])).toBe('Hello');
  });

  it('reports the model version the provider actually served', async () => {
    const api = new GeminiAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({ body: reply('hello', { modelVersion: 'gemini-primary-002' }) }),
    });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).resolvedModel)
      .toBe('gemini-primary-002');
  });

  it('derives cache-miss tokens from the prompt/cached split', async () => {
    const api = new GeminiAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({
        body: reply('hello', {
          usageMetadata: {
            promptTokenCount: 30, candidatesTokenCount: 10,
            totalTokenCount: 40, cachedContentTokenCount: 12,
          },
        }),
      }),
    });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage)
      .toMatchObject({ promptTokens: 30, completionTokens: 10, totalTokens: 40, cacheHitTokens: 12, cacheMissTokens: 18 });
  });

  it('omits usage when the provider reports none', async () => {
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ body: reply('hello') }) });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage).toBeUndefined();
  });

  it('throws when the response carries no text', async () => {
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ body: { candidates: [] } }) });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Gemini API did not return any choices');
  });

  it('falls back to the next configured model when the first is rate limited', async () => {
    const fetchImpl = jsonFetch(
      { body: 'too many requests', status: 429 },
      { body: reply('from backup') },
    );
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    expect(await api.generateResponse([{ role: 'user', content: 'hi' }])).toBe('from backup');
    expect(calls(fetchImpl)).toHaveLength(2);
    expect(calls(fetchImpl)[1][0]).toContain('gemini-backup');
  });

  it('falls back when the first model reports itself unavailable', async () => {
    const fetchImpl = jsonFetch(
      { body: 'service unavailable', status: 503 },
      { body: reply('from backup') },
    );
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    expect(await api.generateResponse([{ role: 'user', content: 'hi' }])).toBe('from backup');
  });

  it('gives up once every configured model is exhausted', async () => {
    const fetchImpl = jsonFetch({ body: 'quota exceeded', status: 429 });
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Gemini API error/);
    expect(calls(fetchImpl)).toHaveLength(2);
  });

  // Fallback is deliberately scoped to capacity errors. A bad key or a missing
  // model will fail identically on every candidate, so retrying just multiplies
  // the latency and the spend.
  it('does not retry a different model on an auth failure', async () => {
    const fetchImpl = jsonFetch({ body: 'bad key', status: 401 });
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/401/);
    expect(calls(fetchImpl)).toHaveLength(1);
  });

  it('does not retry a different model when the model itself is unknown', async () => {
    const fetchImpl = jsonFetch({ body: 'model not found', status: 404 });
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/404/);
    expect(calls(fetchImpl)).toHaveLength(1);
  });

  it('streams deltas through the SSE endpoint when a delta handler is supplied', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}',
      '',
    ].join('\n\n');
    const fetchImpl = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;
    const api = new GeminiAPI(undefined, { config: CONFIG, fetchImpl });

    const deltas: string[] = [];
    const result = await api.generateResponseWithToolsAndMetadata(
      [{ role: 'user', content: 'hi' }],
      [],
      async () => ({ role: 'tool', content: '' }),
      undefined,
      async delta => { deltas.push(delta); },
    );

    expect(calls(fetchImpl)[0][0]).toContain(':streamGenerateContent?alt=sse');
    expect(deltas.join('')).toBe('Hello');
    expect(result.content).toBe('Hello');
  });
});
