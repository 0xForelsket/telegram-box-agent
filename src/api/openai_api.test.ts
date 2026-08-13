import { describe, expect, it, vi } from 'vitest';
import OpenAIAPI, { type OpenAIApiConfig } from './openai_api';

const CONFIG: OpenAIApiConfig = {
  apiKey: 'openai-key',
  baseUrl: 'https://openai.example/v1',
  models: ['gpt-small', 'gpt-large'],
  defaultModel: 'gpt-small',
};

function jsonFetch(payload: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

const OK = { choices: [{ message: { content: 'hello' } }] };

const WEATHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Look up weather',
    parameters: { type: 'object' as const, properties: {}, required: [] },
  },
};

describe('OpenAIAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    expect(new OpenAIAPI(undefined, { config: CONFIG }).getDefaultModel()).toBe('gpt-small');
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new OpenAIAPI()).toThrow('requires an Env or an explicit config');
  });

  it('posts to the chat completions endpoint with bearer auth', async () => {
    const fetchImpl = jsonFetch(OK);
    const api = new OpenAIAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([{ role: 'user', content: 'hi' }]);

    const [url, init] = calls(fetchImpl)[0];
    expect(url).toBe('https://openai.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer openai-key');
  });

  it('omits tools and tool_choice when none are requested', async () => {
    const fetchImpl = jsonFetch(OK);
    const api = new OpenAIAPI(undefined, { config: CONFIG, fetchImpl });

    await api.createChatCompletion([{ role: 'user', content: 'hi' }]);

    const body = JSON.parse(calls(fetchImpl)[0][1].body as string);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('forwards tools and tool_choice when supplied', async () => {
    const fetchImpl = jsonFetch(OK);
    const api = new OpenAIAPI(undefined, { config: CONFIG, fetchImpl });

    await api.createChatCompletion([{ role: 'user', content: 'hi' }], 'gpt-large', {
      tools: [WEATHER_TOOL],
      toolChoice: 'auto',
    });

    const body = JSON.parse(calls(fetchImpl)[0][1].body as string);
    expect(body.model).toBe('gpt-large');
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('maps prompt-cache token counters when the provider reports them', async () => {
    const api = new OpenAIAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({
        ...OK,
        usage: {
          prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
          prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8,
        },
      }),
    });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage).toEqual({
      promptTokens: 20, completionTokens: 8, totalTokens: 28,
      cacheHitTokens: 12, cacheMissTokens: 8,
    });
  });

  it('throws when no choice carries content', async () => {
    const api = new OpenAIAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ choices: [] }) });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('No response generated from OpenAI API');
  });

  it('surfaces an HTTP failure with its status', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const api = new OpenAIAPI(undefined, { config: CONFIG, fetchImpl: failing });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/OpenAI API error: 401/);
  });

  it('streams deltas through the injected fetch and returns the assembled reply', async () => {
    const sse = [
      'data: {"id":"1","model":"gpt-small","choices":[{"index":0,"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchImpl = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;
    const api = new OpenAIAPI(undefined, { config: CONFIG, fetchImpl });

    const deltas: string[] = [];
    const result = await api.createStreamingChatCompletion(
      [{ role: 'user', content: 'hi' }],
      undefined,
      {},
      async delta => { deltas.push(delta); },
    );

    expect(deltas.join('')).toBe('Hello');
    expect(result.choices[0].message.content).toBe('Hello');
    expect(JSON.parse(calls(fetchImpl)[0][1].body as string).stream).toBe(true);
  });
});
