import { TelegramTransport } from './transport';

type StreamingMode = 'unknown' | 'native' | 'edit' | 'disabled';

/**
 * Streams final-answer deltas through Telegram's native draft API when available.
 * Bots without private-topic mode transparently fall back to editing one message.
 */
export class TelegramStreamingReply {
  private mode: StreamingMode = 'unknown';
  private content = '';
  private fallbackMessageId: number | null = null;
  private lastSentAt = 0;
  private lastSentLength = 0;

  constructor(
    private readonly transport: TelegramTransport,
    private readonly chatId: number,
    private readonly draftId: number,
    private readonly messageThreadId?: number,
    private readonly minimumIntervalMs = 1_000,
  ) {}

  async append(delta: string): Promise<void> {
    if (!delta || this.mode === 'disabled') return;
    this.content += delta;
    const now = Date.now();
    if (this.lastSentLength > 0 && now - this.lastSentAt < this.minimumIntervalMs) return;
    await this.flush();
  }

  async complete(finalText: string): Promise<boolean> {
    if (this.mode === 'edit' && this.fallbackMessageId !== null) {
      await this.transport.replaceProgressMessage(this.chatId, this.fallbackMessageId, finalText);
      return true;
    }
    return false;
  }

  private async flush(): Promise<void> {
    const preview = this.content.trim();
    if (!preview || preview.length === this.lastSentLength) return;

    try {
      if (this.mode === 'unknown' || this.mode === 'native') {
        await this.transport.sendMessageDraft(this.chatId, this.draftId, preview, this.messageThreadId);
        this.mode = 'native';
      } else if (this.mode === 'edit' && this.fallbackMessageId !== null) {
        await this.transport.editMessageTextPlain(this.chatId, this.fallbackMessageId, preview);
      }
      this.lastSentAt = Date.now();
      this.lastSentLength = preview.length;
    } catch (error) {
      if (this.mode !== 'unknown') {
        console.warn('Telegram streaming update failed; final response will be sent normally.', error);
        this.mode = 'disabled';
        return;
      }
      try {
        const sent = await this.transport.sendMessage(this.chatId, preview);
        this.fallbackMessageId = sent[0]?.message_id ?? null;
        this.mode = this.fallbackMessageId === null ? 'disabled' : 'edit';
        this.lastSentAt = Date.now();
        this.lastSentLength = preview.length;
      } catch (fallbackError) {
        console.warn('Telegram streaming fallback failed; final response will be sent normally.', fallbackError);
        this.mode = 'disabled';
      }
    }
  }
}
