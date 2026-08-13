import { describe, expect, it, vi } from 'vitest';
import { FluxAPI, type FluxApiConfig } from './flux-cf';

const CONFIG: FluxApiConfig = {
  apiToken: 'cf-token',
  accountId: 'acct-1',
  steps: 4,
  promptOptimization: false,
};

const REWRITE_CONFIG: FluxApiConfig = {
  ...CONFIG,
  promptOptimization: true,
  externalApiBase: 'https://rewrite.example',
  externalModel: 'rewriter-1',
  externalApiKey: 'rewrite-key',
};

// "hi" base64-encoded.
const IMAGE_B64 = 'aGk=';

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

function routedFetch(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.keys(routes).find(key => url.includes(key));
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    const body = routes[match];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function fluxOk() {
  return { success: true, result: { image: IMAGE_B64 } };
}

describe('FluxAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    expect(new FluxAPI(undefined, { config: CONFIG }).getDefaultModel())
      .toBe('@cf/black-forest-labs/flux-1-schnell');
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new FluxAPI()).toThrow('requires an Env or an explicit config');
  });

  it('calls the account-scoped Workers AI endpoint and decodes the image', async () => {
    const fetchImpl = routedFetch({ 'api.cloudflare.com': fluxOk() });
    const api = new FluxAPI(undefined, { config: CONFIG, fetchImpl, randomSeed: () => 42 });

    const result = await api.generateImage('a red bicycle', '16:9');

    expect([...result.imageData]).toEqual([104, 105]);
    const [url, init] = calls(fetchImpl)[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/black-forest-labs/flux-1-schnell');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      prompt: 'a red bicycle', num_steps: 4, seed: 42, width: 1024, height: 576,
    });
  });

  it('maps each supported aspect ratio to its dimensions', async () => {
    const expected: Record<string, [number, number]> = {
      '1:1': [1024, 1024], '1:2': [512, 1024], '3:2': [768, 512],
      '3:4': [768, 1024], '16:9': [1024, 576], '9:16': [576, 1024],
    };
    for (const [ratio, [width, height]] of Object.entries(expected)) {
      const fetchImpl = routedFetch({ 'api.cloudflare.com': fluxOk() });
      await new FluxAPI(undefined, { config: CONFIG, fetchImpl }).generateImage('x', ratio);
      expect(JSON.parse(calls(fetchImpl)[0][1].body as string)).toMatchObject({ width, height });
    }
  });

  it('falls back to square for an unknown ratio', async () => {
    const fetchImpl = routedFetch({ 'api.cloudflare.com': fluxOk() });
    await new FluxAPI(undefined, { config: CONFIG, fetchImpl }).generateImage('x', '7:3');

    expect(JSON.parse(calls(fetchImpl)[0][1].body as string)).toMatchObject({ width: 1024, height: 1024 });
  });

  it('rejects an empty prompt without calling the provider', async () => {
    const fetchImpl = routedFetch({ 'api.cloudflare.com': fluxOk() });
    const api = new FluxAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateImage('   ', '1:1')).rejects.toThrow('Image prompt is empty');
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it('treats success:false on a 200 as a failure', async () => {
    // Workers AI reports model-level errors inside an otherwise-ok response.
    const fetchImpl = routedFetch({
      'api.cloudflare.com': { success: false, errors: ['content blocked', 'retry later'] },
    });
    const api = new FluxAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateImage('x', '1:1')).rejects.toThrow('Flux API error: content blocked, retry later');
  });

  it('handles structured error objects as well as strings', async () => {
    const fetchImpl = routedFetch({
      'api.cloudflare.com': { success: false, errors: [{ message: 'quota exceeded' }] },
    });

    await expect(new FluxAPI(undefined, { config: CONFIG, fetchImpl }).generateImage('x', '1:1'))
      .rejects.toThrow('quota exceeded');
  });

  it('reports a successful response that carries no image', async () => {
    const fetchImpl = routedFetch({ 'api.cloudflare.com': { success: true, result: {} } });

    await expect(new FluxAPI(undefined, { config: CONFIG, fetchImpl }).generateImage('x', '1:1'))
      .rejects.toThrow('returned no image');
  });

  it('rewrites the prompt when optimization is enabled', async () => {
    const fetchImpl = routedFetch({
      'rewrite.example': { choices: [{ message: { content: '  a crimson bicycle, studio light  ' } }] },
      'api.cloudflare.com': fluxOk(),
    });
    const api = new FluxAPI(undefined, { config: REWRITE_CONFIG, fetchImpl });

    const result = await api.generateImage('a red bicycle', '1:1');

    expect(result.optimizedPrompt).toBe('a crimson bicycle, studio light');
    const fluxCall = calls(fetchImpl).find(([url]) => String(url).includes('api.cloudflare.com'))!;
    expect(JSON.parse(fluxCall[1].body as string).prompt).toBe('a crimson bicycle, studio light');
  });

  it('still produces an image when the rewrite fails', async () => {
    // A rewrite is an enhancement; losing it must not cost the user the image.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('rewrite.example')) return new Response('upstream down', { status: 500 });
      return new Response(JSON.stringify(fluxOk()), { status: 200 });
    }) as unknown as typeof fetch;
    const api = new FluxAPI(undefined, { config: REWRITE_CONFIG, fetchImpl });

    const result = await api.generateImage('a red bicycle', '1:1');

    expect(result.optimizedPrompt).toBeUndefined();
    const fluxCall = calls(fetchImpl).find(([url]) => String(url).includes('api.cloudflare.com'))!;
    expect(JSON.parse(fluxCall[1].body as string).prompt).toBe('a red bicycle');
  });

  it('skips the rewrite when the external provider is not fully configured', async () => {
    const fetchImpl = routedFetch({ 'api.cloudflare.com': fluxOk() });
    const partial: FluxApiConfig = { ...CONFIG, promptOptimization: true, externalApiBase: 'https://rewrite.example' };

    const result = await new FluxAPI(undefined, { config: partial, fetchImpl }).generateImage('x', '1:1');

    expect(result.optimizedPrompt).toBeUndefined();
    expect(calls(fetchImpl)).toHaveLength(1);
  });

  it('exposes its supported ratios and rejects chat use', async () => {
    const api = new FluxAPI(undefined, { config: CONFIG });

    expect(api.getValidAspectRatios()).toEqual(['1:1', '1:2', '3:2', '3:4', '16:9', '9:16']);
    await expect(api.generateResponse([])).rejects.toThrow('not implemented');
  });
});
