import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramTransport } from './transport';

describe('TelegramTransport retries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a transient Telegram 5xx response once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, description: 'temporary' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new TelegramTransport('https://api.telegram.test').sendMessage(1, 'hello')).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient non-JSON Telegram 5xx response once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new TelegramTransport('https://api.telegram.test').sendMessage(1, 'hello')).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent Telegram 4xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, description: 'bad request' }, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new TelegramTransport('https://api.telegram.test').sendMessage(1, 'hello')).rejects.toThrow('400');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends an animated draft with a stable non-zero draft id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, result: true }));
    vi.stubGlobal('fetch', fetchMock);

    await new TelegramTransport('https://api.telegram.test').sendMessageDraft(42, 17, 'partial answer', 9);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.test/sendMessageDraft',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: 42, draft_id: 17, text: 'partial answer', message_thread_id: 9 }),
      }),
    );
  });

  it('sends a private signed URL through Telegram sendDocument', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, result: { message_id: 9 } }));
    vi.stubGlobal('fetch', fetchMock);
    await new TelegramTransport('https://api.telegram.test').sendDocument(
      -100,
      'https://worker.example/artifacts/ba_123456?expires=123&signature=abc',
      'report.pdf',
      'Artifact ready',
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.test/sendDocument');
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    expect(body.get('chat_id')).toBe('-100');
    expect(body.get('document')).toContain('/artifacts/ba_123456');
    expect(body.get('caption')).toBe('Artifact ready');
  });
});
