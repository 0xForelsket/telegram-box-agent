import { describe, expect, it, vi } from 'vitest';
import AzureAPI, { type AzureApiConfig } from './azure';

const CONFIG: AzureApiConfig = {
  apiKey: 'azure-key',
  baseUrl: 'https://contoso.openai.azure.com',
  models: ['deployment-a', 'deployment-b'],
  defaultModel: 'deployment-a',
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

describe('AzureAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    expect(new AzureAPI(undefined, { config: CONFIG }).getDefaultModel()).toBe('deployment-a');
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new AzureAPI()).toThrow('requires an Env or an explicit config');
  });

  it('routes through the deployment-scoped URL with a pinned api-version', async () => {
    const fetchImpl = jsonFetch(OK);
    const api = new AzureAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([{ role: 'user', content: 'hi' }]);

    expect(calls(fetchImpl)[0][0]).toBe(
      'https://contoso.openai.azure.com/openai/deployments/deployment-a/chat/completions?api-version=2024-02-01',
    );
  });

  it('puts the deployment name in the path rather than the body', async () => {
    const fetchImpl = jsonFetch(OK);
    const api = new AzureAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }], 'deployment-b');

    expect(calls(fetchImpl)[0][0]).toContain('/deployments/deployment-b/');
    expect(JSON.parse(calls(fetchImpl)[0][1].body as string)).not.toHaveProperty('model');
  });

  it('authenticates with the api-key header, not a bearer token', async () => {
    const fetchImpl = jsonFetch(OK);
    const api = new AzureAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateResponse([{ role: 'user', content: 'hi' }]);

    const headers = calls(fetchImpl)[0][1].headers as Record<string, string>;
    expect(headers['api-key']).toBe('azure-key');
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps token usage onto the shared shape', async () => {
    const api = new AzureAPI(undefined, {
      config: CONFIG,
      fetchImpl: jsonFetch({ ...OK, usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } }),
    });

    expect((await api.generateResponseWithMetadata([{ role: 'user', content: 'hi' }])).usage)
      .toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  });

  it('throws when no choice carries content', async () => {
    const api = new AzureAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ choices: [] }) });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('surfaces an HTTP failure with its status', async () => {
    const failing = vi.fn(async () => new Response('bad deployment', { status: 404 })) as unknown as typeof fetch;
    const api = new AzureAPI(undefined, { config: CONFIG, fetchImpl: failing });

    await expect(api.generateResponse([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/Azure API error: 404/);
  });
});
