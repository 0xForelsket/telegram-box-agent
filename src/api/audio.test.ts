import { afterEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../env';
import { AudioAPI } from './audio';

function env(): Env {
  return {
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODELS: '', TELEGRAM_BOT_TOKEN: 't', WHITELISTED_USERS: '1',
    SYSTEM_INIT_MESSAGE: 's', SYSTEM_INIT_MESSAGE_ROLE: 'system', UPSTASH_REDIS_REST_URL: 'https://r', UPSTASH_REDIS_REST_TOKEN: 'r',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4', GOOGLE_MODEL_KEY: 'g', GOOGLE_MODELS: 'gemini',
    GROQ_API_KEY: '', GROQ_MODELS: '', CLAUDE_API_KEY: '', CLAUDE_MODELS: '', AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
    AUDIO_API_KEY: 'audio-key',
  };
}

describe('AudioAPI', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends multipart audio transcription requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: 'hello world' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new AudioAPI(env()).transcribe(new Blob(['audio'], { type: 'audio/ogg' }))).resolves.toBe('hello world');
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
  });

  it('generates bounded MP3 speech', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new AudioAPI(env()).synthesize('hello')).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
