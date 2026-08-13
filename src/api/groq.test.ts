import { describe, expect, it, vi } from 'vitest';
import GroqAPI, { type GroqApiConfig } from './groq';

const CONFIG: GroqApiConfig = {
  apiKey: 'groq-key',
  baseUrl: 'https://groq.example/openai/v1',
  models: ['llama-fast', 'llama-big'],
  defaultModel: 'llama-fast',
};

function jsonFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

function completion(content: string, usage?: Record<string, number>) {
  return { choices: [{ message: { content } }], ...(usage ? { usage } : {}) };
}

describe('GroqAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    const api = new GroqAPI(undefined, { config: CONFIG });

    expect(api.getDefaultModel()).toBe('llama-fast');
    expect(api.getAvailableModels()).toEqual(['llama-fast', 'llama-big']);
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new GroqAPI()).toThrow('requires an Env or an explicit config');
  });

  it('posts to the chat completions endpoint with bearer auth', async () => {
    const fetchImpl = jsonFetch(completion('hello'));
    const api = new GroqAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([{ role: 'user', content: 'hi' }]);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://groq.example/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer groq-key');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'llama-fast', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('uses the requested model over the default', async () => {
    const fetchImpl = jsonFetch(completion('hello'));
    const api = new GroqAPI(undefined, { config: CONFIG, fetchImpl });

    const result = await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }], 'llama-big');

    expect(result.resolvedModel).toBe('llama-big');
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string).model).toBe('llama-big');
  });

  it('maps token usage onto the shared shape', async () => {
    const fetchImpl = jsonFetch(completion('hello', {
      prompt_tokens: 11, completion_tokens: 5, total_tokens: 16,
    }));
    const api = new GroqAPI(undefined, { config: CONFIG, fetchImpl });

    const result = await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }]);

    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 5, totalTokens: 16 });
  });

  it('omits usage when the provider does not report it', async () => {
    const api = new GroqAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch(completion('hello')) });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage).toBeUndefined();
  });

  it('throws when the provider returns no usable content', async () => {
    const api = new GroqAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ choices: [] }) });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('No response generated from Groq API');
  });

  it('surfaces an HTTP failure with its status', async () => {
    const failing = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const api = new GroqAPI(undefined, { config: CONFIG, fetchImpl: failing });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/Groq API error: 429/);
  });

  it('validates models against the configured list', () => {
    const api = new GroqAPI(undefined, { config: CONFIG });

    expect(api.isValidModel('llama-big')).toBe(true);
    expect(api.isValidModel('gpt-4')).toBe(false);
  });
});
