import { describe, expect, it, vi } from 'vitest';
import { TelegramTransport } from './transport';
import { TelegramStreamingReply } from './streaming_reply';

function mockTransport(overrides: Partial<TelegramTransport> = {}): TelegramTransport {
  return {
    sendMessageDraft: vi.fn().mockResolvedValue(undefined),
    editMessageTextPlain: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue([{ message_id: 10 }]),
    replaceProgressMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TelegramTransport;
}

describe('TelegramStreamingReply', () => {
  it('updates one native draft and leaves final delivery to sendMessage', async () => {
    const transport = mockTransport();
    const reply = new TelegramStreamingReply(transport, 42, 7, undefined, 0);

    await reply.append('Hello');
    await reply.append(' world');

    expect(transport.sendMessageDraft).toHaveBeenNthCalledWith(1, 42, 7, 'Hello', undefined);
    expect(transport.sendMessageDraft).toHaveBeenNthCalledWith(2, 42, 7, 'Hello world', undefined);
    await expect(reply.complete('Hello world')).resolves.toBe(false);
  });

  it('falls back to one editable message when native drafts are unavailable', async () => {
    const transport = mockTransport({
      sendMessageDraft: vi.fn().mockRejectedValue(new Error('Telegram API error (400): topic mode required')),
    });
    const reply = new TelegramStreamingReply(transport, 42, 7, undefined, 0);

    await reply.append('Hello');
    await reply.append(' world');

    expect(transport.sendMessage).toHaveBeenCalledWith(42, 'Hello');
    expect(transport.editMessageTextPlain).toHaveBeenCalledWith(42, 10, 'Hello world');
    await expect(reply.complete('Hello world')).resolves.toBe(true);
    expect(transport.replaceProgressMessage).toHaveBeenCalledWith(42, 10, 'Hello world');
  });
});
