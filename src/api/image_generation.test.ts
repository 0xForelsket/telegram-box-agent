import { describe, expect, it, vi } from 'vitest';
import { ImageGenerationAPI, type ImageGenerationConfig } from './image_generation';

const CONFIG: ImageGenerationConfig = {
  apiKey: 'openai-key',
  baseUrl: 'https://openai.example/v1',
  model: 'dall-e-3',
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

describe('ImageGenerationAPI', () => {
  it('is constructible from an explicit config without an Env', () => {
    expect(new ImageGenerationAPI(undefined, { config: CONFIG }).getDefaultModel()).toBe('dall-e-3');
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new ImageGenerationAPI()).toThrow('requires an Env or an explicit config');
  });

  it('posts the prompt and size to the generations endpoint', async () => {
    const fetchImpl = jsonFetch({ data: [{ url: 'https://cdn.example/a.png' }] });
    const api = new ImageGenerationAPI(undefined, { config: CONFIG, fetchImpl });

    const url = await api.generateImage('a red bicycle', '1024x1024');

    expect(url).toBe('https://cdn.example/a.png');
    const [endpoint, init] = calls(fetchImpl)[0];
    expect(endpoint).toBe('https://openai.example/v1/images/generations');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer openai-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'dall-e-3', prompt: 'a red bicycle', n: 1, size: '1024x1024',
    });
  });

  it('trims the prompt before sending it', async () => {
    const fetchImpl = jsonFetch({ data: [{ url: 'https://cdn.example/a.png' }] });
    const api = new ImageGenerationAPI(undefined, { config: CONFIG, fetchImpl });

    await api.generateImage('  spaced prompt  ', '1024x1024');

    expect(JSON.parse(calls(fetchImpl)[0][1].body as string).prompt).toBe('spaced prompt');
  });

  it('rejects an empty prompt without calling the provider', async () => {
    const fetchImpl = jsonFetch({});
    const api = new ImageGenerationAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateImage('   ', '1024x1024')).rejects.toThrow('Image prompt is empty');
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it('rejects an unsupported size without calling the provider', async () => {
    const fetchImpl = jsonFetch({});
    const api = new ImageGenerationAPI(undefined, { config: CONFIG, fetchImpl });

    await expect(api.generateImage('a cat', '999x999')).rejects.toThrow('Unsupported image size');
    expect(calls(fetchImpl)).toHaveLength(0);
  });

  it('reports a missing URL as a message rather than a TypeError', async () => {
    // The previous implementation indexed data[0].url blindly.
    const api = new ImageGenerationAPI(undefined, { config: CONFIG, fetchImpl: jsonFetch({ data: [] }) });

    await expect(api.generateImage('a cat', '1024x1024')).rejects.toThrow('returned no image URL');
  });

  it('surfaces an HTTP failure with its status', async () => {
    const failing = vi.fn(async () => new Response('content policy', { status: 400 })) as unknown as typeof fetch;
    const api = new ImageGenerationAPI(undefined, { config: CONFIG, fetchImpl: failing });

    await expect(api.generateImage('a cat', '1024x1024')).rejects.toThrow(/Image generation API error: 400/);
  });

  it('exposes its supported sizes and rejects chat use', async () => {
    const api = new ImageGenerationAPI(undefined, { config: CONFIG });

    expect(api.getValidSizes()).toEqual(['1024x1024', '1024x1792', '1792x1024']);
    expect(api.isValidModel('dall-e-3')).toBe(true);
    expect(api.isValidModel('gpt-4')).toBe(false);
    await expect(api.generateResponse([])).rejects.toThrow('not implemented');
  });
});
