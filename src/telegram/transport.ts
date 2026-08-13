import { TelegramTypes } from '../../types/telegram';
import { formatMarkdown, splitMessage, stripFormatting } from '../utils/helpers';

interface TelegramEnvelope<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramTransport {
  constructor(private readonly apiUrl: string) {}

  async sendMessage(
    chatId: number,
    text: string,
    options: { parse_mode?: 'Markdown' | 'HTML'; reply_markup?: string } = {},
  ): Promise<TelegramTypes.SendMessageResult[]> {
    const results: TelegramTypes.SendMessageResult[] = [];
    for (const message of splitMessage(text)) {
      const envelope = await this.requestJson<TelegramTypes.SendMessageResult>('/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, ...options }),
      });
      results.push(envelope.result);
    }
    return results;
  }

  async sendMessageWithFallback(chatId: number, text: string): Promise<TelegramTypes.SendMessageResult[]> {
    const messages = splitMessage(this.standardizeMarkdown(text), 4000);
    const results: TelegramTypes.SendMessageResult[] = [];
    for (const message of messages) {
      const markdownMessage = formatMarkdown(message);
      const unclosed = (markdownMessage.match(/```/g) || []).length % 2 !== 0 ||
        (markdownMessage.match(/\*/g) || []).length % 2 !== 0 ||
        (markdownMessage.match(/`(?!``)/g) || []).length % 2 !== 0;
      if (unclosed) {
        results.push(...await this.sendMessage(chatId, stripFormatting(message)));
        continue;
      }
      try {
        results.push(...await this.sendMessage(chatId, markdownMessage, { parse_mode: 'Markdown' }));
      } catch (error) {
        if (!this.isMarkdownError(error)) throw error;
        results.push(...await this.sendMessage(chatId, stripFormatting(message)));
      }
    }
    return results;
  }

  async replaceProgressMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const parts = splitMessage(this.standardizeMarkdown(text), 4000);
    const first = parts.shift() || 'Done.';
    try {
      await this.requestJson('/editMessageText', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: formatMarkdown(first), parse_mode: 'Markdown' }),
      });
    } catch (error) {
      if (!this.isMarkdownError(error)) throw error;
      await this.requestJson('/editMessageText', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: stripFormatting(first) }),
      });
    }
    if (parts.length > 0) await this.sendMessageWithFallback(chatId, parts.join('\n'));
  }

  async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    messageThreadId?: number,
  ): Promise<void> {
    await this.requestJson('/sendMessageDraft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        draft_id: draftId,
        text: text.slice(0, 4_096),
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      }),
    });
  }

  async editMessageTextPlain(chatId: number, messageId: number, text: string): Promise<void> {
    await this.requestJson('/editMessageText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text.slice(0, 4_096) }),
    });
  }

  async sendPhoto(chatId: number, photo: string | Uint8Array, caption?: string): Promise<void> {
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    if (typeof photo === 'string') formData.append('photo', photo);
    else formData.append('photo', new Blob([photo], { type: 'image/png' }), 'image.png');
    if (caption) formData.append('caption', caption);
    await this.requestOk('/sendPhoto', { method: 'POST', body: formData });
  }

  async sendVoice(chatId: number, voice: Uint8Array, caption?: string): Promise<void> {
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('voice', new Blob([voice], { type: 'audio/mpeg' }), 'speech.mp3');
    if (caption) formData.append('caption', caption.slice(0, 1_024));
    await this.requestOk('/sendVoice', { method: 'POST', body: formData });
  }

  async sendDocument(chatId: number, documentUrl: string, filename: string, caption?: string): Promise<void> {
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', documentUrl);
    formData.append('caption', (caption || filename).slice(0, 1_024));
    await this.requestOk('/sendDocument', { method: 'POST', body: formData });
  }

  private async requestJson<T = unknown>(path: string, init: RequestInit): Promise<TelegramEnvelope<T>> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.apiUrl}${path}`, init);
        let envelope: TelegramEnvelope<T>;
        try {
          envelope = await response.json() as TelegramEnvelope<T>;
        } catch {
          envelope = {
            ok: false,
            result: undefined as T,
            description: 'non-JSON response',
          };
        }
        if (response.ok && envelope.ok) return envelope;
        const error = new Error(`Telegram API error (${response.status}): ${envelope.description || 'ok=false'}`);
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 0 && /network|fetch|timeout|abort/i.test(lastError.message)) continue;
        throw lastError;
      }
    }
    throw lastError || new Error('Telegram request failed.');
  }

  private async requestOk(path: string, init: RequestInit): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.apiUrl}${path}`, init);
        if (response.ok) return;
        const error = new Error(`Telegram API error (${response.status}).`);
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 0 && /network|fetch|timeout|abort/i.test(lastError.message)) continue;
        throw lastError;
      }
    }
    throw lastError || new Error('Telegram request failed.');
  }

  private isMarkdownError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return message.includes('parse entities') || message.includes("can't find end");
  }

  private standardizeMarkdown(text: string): string {
    return text
      .replace(/([^\n])```/g, '$1\n```')
      .replace(/```([^\n])/g, '```\n$1')
      .replace(/\*\*\*/g, '*')
      .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '[$1]($2)')
      .replace(/([^\s`])`([^`]+)`([^\s`])/g, '$1 `$2` $3')
      .replace(/\\([*_`\[\]()#+\-=|{}.!])/g, '$1');
  }
}
