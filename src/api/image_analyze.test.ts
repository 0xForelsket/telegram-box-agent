import { describe, expect, it, vi } from 'vitest';
import ImageAnalysisAPI, { type ImageAnalysisConfig } from './image_analyze';
import OpenAICompatibleAPI from './openai_compatible';

const CONFIG: ImageAnalysisConfig = {
  openaiApiKey: 'openai-key',
  openaiBaseUrl: 'https://openai.example/v1',
  openaiModels: ['gpt-vision'],
  googleApiKey: 'google-key',
  googleBaseUrl: 'https://gemini.example/v1beta',
  googleModels: ['gemini-vision'],
};

const IMAGE_URL = 'https://files.example/photo.jpg';

function compatible(models: string[] = []) {
  return new OpenAICompatibleAPI(undefined, {
    config: { apiKey: 'k', baseUrl: 'https://compat.example', models },
    fetchImpl: vi.fn(async () => Response.json({
      data: models.map(id => ({ id })),
    })) as unknown as typeof fetch,
  });
}

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

/** Serves the image bytes plus whichever model endpoint is asked for. */
function visionFetch(payload: unknown, imageBytes = new Uint8Array([1, 2, 3]), contentType = 'image/jpeg') {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === IMAGE_URL) {
      return new Response(imageBytes, { status: 200, headers: { 'Content-Type': contentType } });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const OPENAI_OK = { choices: [{ message: { content: 'a bicycle' } }] };
const GEMINI_OK = { candidates: [{ content: { parts: [{ text: '  a bicycle  ' }] } }] };

describe('ImageAnalysisAPI routing', () => {
  it('is constructible from an explicit config without an Env', () => {
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, openaiCompatible: compatible() });

    expect(api.getDefaultModel()).toBe('gpt-vision');
    expect(api.getAvailableModels()).toEqual(['gpt-vision', 'gemini-vision']);
  });

  it('explains itself when given neither an Env nor a config', () => {
    expect(() => new ImageAnalysisAPI()).toThrow('requires an Env or an explicit config');
  });

  it('routes an OpenAI model to the chat completions endpoint', async () => {
    const fetchImpl = visionFetch(OPENAI_OK);
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    expect(await api.analyzeImage(IMAGE_URL, 'what is this?', 'gpt-vision')).toBe('a bicycle');
    expect(calls(fetchImpl).map(([url]) => String(url)))
      .toEqual([IMAGE_URL, 'https://openai.example/v1/chat/completions']);
  });

  it('inlines the image for OpenAI instead of sending the source URL', async () => {
    const fetchImpl = visionFetch(OPENAI_OK, new Uint8Array([104, 105]));
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await api.analyzeImage(IMAGE_URL, 'what is this?', 'gpt-vision');

    const openaiCall = calls(fetchImpl).find(([url]) => String(url).includes('openai.example'))!;
    const body = JSON.parse(openaiCall[1].body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGk=' } },
    ]);
  });

  // A Telegram file URL is `/file/bot<TELEGRAM_BOT_TOKEN>/...`. Passing it by
  // reference makes the provider fetch it, disclosing full control of the bot.
  it('never puts a credentialed source URL in a provider request', async () => {
    const telegramUrl = 'https://api.telegram.org/file/bot123456:SECRET-BOT-TOKEN/photos/a.jpg';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === telegramUrl) {
        return new Response(new Uint8Array([104, 105]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
      return new Response(JSON.stringify(OPENAI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await api.analyzeImage(telegramUrl, 'what is this?', 'gpt-vision');

    const outbound = calls(fetchImpl).filter(([url]) => String(url).includes('openai.example'));
    expect(outbound).toHaveLength(1);
    expect(JSON.stringify(outbound[0])).not.toContain('SECRET-BOT-TOKEN');
  });

  it('reuses an already-inlined data URL without re-fetching it', async () => {
    const fetchImpl = visionFetch(OPENAI_OK);
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await api.analyzeImage('data:image/png;base64,aGk=', 'x', 'gpt-vision');

    expect(calls(fetchImpl)).toHaveLength(1);
    const body = JSON.parse(calls(fetchImpl)[0][1].body as string);
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,aGk=');
  });

  it('rejects a model none of the providers recognise', async () => {
    const api = new ImageAnalysisAPI(undefined, {
      config: CONFIG,
      fetchImpl: visionFetch(OPENAI_OK),
      openaiCompatible: compatible(['compat-vision']),
    });

    await expect(api.analyzeImage(IMAGE_URL, 'x', 'unknown-model'))
      .rejects.toThrow('Invalid model for image analysis');
  });
});

describe('ImageAnalysisAPI Gemini path', () => {
  it('passes the API key as a header, never in the query string', async () => {
    const fetchImpl = visionFetch(GEMINI_OK);
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await api.analyzeImage(IMAGE_URL, 'what is this?', 'gemini-vision');

    const geminiCall = calls(fetchImpl).find(([url]) => String(url).includes('gemini.example'))!;
    expect(String(geminiCall[0])).not.toContain('key=');
    expect(String(geminiCall[0])).not.toContain('google-key');
    expect((geminiCall[1].headers as Record<string, string>)['x-goog-api-key']).toBe('google-key');
  });

  it('downloads the image and inlines it as base64', async () => {
    const fetchImpl = visionFetch(GEMINI_OK, new Uint8Array([104, 105]));
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    expect(await api.analyzeImage(IMAGE_URL, 'what is this?', 'gemini-vision')).toBe('a bicycle');

    const geminiCall = calls(fetchImpl).find(([url]) => String(url).includes('gemini.example'))!;
    const parts = JSON.parse(geminiCall[1].body as string).contents[0].parts;
    expect(parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: 'aGk=' });
  });

  it('honours the served content type', async () => {
    const fetchImpl = visionFetch(GEMINI_OK, new Uint8Array([104, 105]), 'image/png');
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await api.analyzeImage(IMAGE_URL, 'x', 'gemini-vision');

    const geminiCall = calls(fetchImpl).find(([url]) => String(url).includes('gemini.example'))!;
    expect(JSON.parse(geminiCall[1].body as string).contents[0].parts[1].inlineData.mimeType).toBe('image/png');
  });

  it('falls back to jpeg when the content type is not an image type', async () => {
    const fetchImpl = visionFetch(GEMINI_OK, new Uint8Array([104, 105]), 'application/octet-stream');
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await api.analyzeImage(IMAGE_URL, 'x', 'gemini-vision');

    const geminiCall = calls(fetchImpl).find(([url]) => String(url).includes('gemini.example'))!;
    expect(JSON.parse(geminiCall[1].body as string).contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
  });

  it('encodes a large image without overflowing the call stack', async () => {
    // Spreading a multi-megabyte Uint8Array into String.fromCharCode throws
    // RangeError; the encoder has to chunk.
    const large = new Uint8Array(600_000).fill(97);
    const fetchImpl = visionFetch(GEMINI_OK, large);
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await expect(api.analyzeImage(IMAGE_URL, 'x', 'gemini-vision')).resolves.toBe('a bicycle');
  });

  it('refuses an image beyond the analysis size limit', async () => {
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    const fetchImpl = visionFetch(GEMINI_OK, oversized);
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await expect(api.analyzeImage(IMAGE_URL, 'x', 'gemini-vision')).rejects.toThrow('analysis limit');
  });

  it('reports a failed image download clearly', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === IMAGE_URL) return new Response('gone', { status: 404 });
      return new Response(JSON.stringify(GEMINI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await expect(api.analyzeImage(IMAGE_URL, 'x', 'gemini-vision')).rejects.toThrow('Could not download image: HTTP 404');
  });

  it('reports an empty Gemini answer', async () => {
    const fetchImpl = visionFetch({ candidates: [] });
    const api = new ImageAnalysisAPI(undefined, { config: CONFIG, fetchImpl, openaiCompatible: compatible() });

    await expect(api.analyzeImage(IMAGE_URL, 'x', 'gemini-vision')).rejects.toThrow('No content in Gemini API response');
  });
});
