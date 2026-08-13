import { describe, expect, it, vi } from 'vitest';
import ClaudeAPI, { type ClaudeApiConfig } from './claude';

const CONFIG: ClaudeApiConfig = {
  apiKey: 'claude-key',
  baseUrl: 'https://claude.example/v1',
  models: ['claude-a', 'claude-b'],
  defaultModel: 'claude-a',
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

describe('ClaudeAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    expect(new ClaudeAPI(undefined, { config: CONFIG }).getDefaultModel()).toBe('claude-a');
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new ClaudeAPI()).toThrow('requires an Env or an explicit config');
  });

  it('uses the Anthropic messages endpoint with the versioned api-key headers', async () => {
    const fetchImpl = jsonFetch({ content: [{ text: 'hello' }] });
    const api = new ClaudeAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([{ role: 'user', content: 'hi' }]);

    const [url, init] = calls(fetchImpl)[0];
    expect(url).toBe('https://claude.example/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('claude-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('collapses non-assistant roles to user, as the Messages API requires', async () => {
    const fetchImpl = jsonFetch({ content: [{ text: 'hello' }] });
    const api = new ClaudeAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([
      { role: 'system', content: 'be brief' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'hi' },
    ]);

    expect(JSON.parse(calls(fetchImpl)[0][1].body as string).messages).toEqual([
      { role: 'user', content: 'be brief' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('trims the returned text', async () => {
    const api = new ClaudeAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({ content: [{ text: '  spaced  ' }] }),
    });

    expect(await api.generateResponse([{ role: 'user', content: 'hi' }])).toBe('spaced');
  });

  it('derives total tokens from the input/output split', async () => {
    const api = new ClaudeAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({ content: [{ text: 'hello' }], usage: { input_tokens: 7, output_tokens: 3 } }),
    });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage)
      .toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it('throws when the content block is empty', async () => {
    const api = new ClaudeAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ content: [] }) });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('No response generated from Claude API');
  });

  it('surfaces an HTTP failure with its status', async () => {
    const failing = vi.fn(async () => new Response('overloaded', { status: 529 })) as unknown as typeof fetch;
    const api = new ClaudeAPI(undefined, { config: CONFIG, fetchImpl: failing });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/Claude API error: 529/);
  });
});
