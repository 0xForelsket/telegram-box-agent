import type { Env } from '../env';

/**
 * The global `fetch`, safe to store on an object.
 *
 * Workers throws `TypeError: Illegal invocation` when the global fetch is
 * invoked with a `this` other than `globalThis`, which is exactly what happens
 * once it is assigned to a field and later called as `this.fetchImpl(...)`.
 * The wrapper keeps the call site plain while restoring the global receiver.
 */
export const globalFetch: typeof fetch = (input, init?) => fetch(input, init);

/**
 * Matches a fenced block: a closed pair, or an unterminated fence running to
 * the end of the text. The second branch matters because model replies get
 * truncated mid-block, and prose rules applied to a half-open fence corrupt it.
 */
const CODE_FENCE = /(```[\s\S]*?```|```[\s\S]*$)/;

interface Segment {
  code: boolean;
  value: string;
}

function splitOnCodeFences(text: string): Segment[] {
  return text
    .split(CODE_FENCE)
    .filter(value => value !== '')
    .map(value => ({ code: value.startsWith('```'), value }));
}

/** Applies `prose` only outside fenced blocks; `fence` rewrites the blocks. */
function mapSegments(
  text: string,
  prose: (value: string) => string,
  fence: (value: string) => string,
): string {
  return splitOnCodeFences(text)
    .map(segment => (segment.code ? fence(segment.value) : prose(segment.value)))
    .join('');
}

function normalizeCodeBlockContent(code: string): string {
  return code.trim()
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Rewrites a closed fence onto its own lines. Unterminated fences pass through. */
function reflowCodeBlock(block: string): string {
  return block.replace(
    /```(\w*)\n?([\s\S]+?)```/g,
    (_match, language: string, code: string) =>
      `\n\`\`\`${language || ''}\n${normalizeCodeBlockContent(code)}\n\`\`\`\n`,
  );
}

/** Rewrites common Markdown into the subset Telegram's Markdown parser accepts. */
export function formatMarkdown(text: string): string {
  return mapSegments(
    text,
    prose => prose
      // Telegram has no bold-italic and uses a single asterisk for bold.
      .replace(/\*\*\*([^*]+)\*\*\*/g, '*$1*')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '[$1]($2)')
      .replace(/^(\s*)-\s+(.+)$/gm, '$1• $2')
      .replace(/^>\s*(.+)$/gm, '▎ _$1_')
      // Telegram will not close inline code that touches a word on both sides.
      .replace(/([^\s`])`([^`]+)`([^\s`])/g, '$1 `$2` $3'),
    reflowCodeBlock,
  );
}

/** Reduces Markdown to plain text, for contexts that render no formatting. */
export function stripFormatting(text: string): string {
  return mapSegments(
    text,
    prose => prose
      .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/^(\s*)-\s+(.+)$/gm, '$1• $2')
      .replace(/^>\s*(.+)$/gm, '▎ $1'),
    block => block,
  );
}

export function splitMessage(text: string, maxLength: number = 4096): string[] {
  const messages: string[] = [];
  const parts = text.split(/(```[\s\S]*?```)/);
  let currentMessage = '';

  for (const part of parts) {
    if (part.startsWith('```')) {
      if (currentMessage.length + part.length > maxLength) {
        if (currentMessage) {
          messages.push(currentMessage.trim());
          currentMessage = '';
        }
        if (part.length <= maxLength) {
          messages.push(part);
        } else {
          const languageMatch = part.match(/^```([^\n]*)\n?/);
          const language = languageMatch?.[1] || '';
          const body = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          const overhead = language.length + 8;
          for (const chunk of splitLongText(body, Math.max(1, maxLength - overhead))) {
            messages.push(`\`\`\`${language}\n${chunk}\n\`\`\``);
          }
        }
      } else {
        currentMessage += part;
      }
    } else {
      const lines = part.split('\n');
      for (const line of lines) {
        if (currentMessage.length + line.length + 1 > maxLength) {
          if (currentMessage) {
            messages.push(currentMessage.trim());
            currentMessage = '';
          }
          if (line.length > maxLength) {
            messages.push(...splitLongText(line, maxLength));
            currentMessage = '';
          } else {
            currentMessage = line;
          }
        } else {
          currentMessage += (currentMessage ? '\n' : '') + line;
        }
      }
    }
  }

  if (currentMessage) {
    messages.push(currentMessage.trim());
  }

  return messages;
}

export async function sendChatAction(chatId: number, action: string, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      action: action,
    }),
  });
}

function splitLongText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1);
    const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    const splitAt = boundary > Math.floor(maxLength * 0.5) ? boundary : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Backstop against a provider that accepts the connection and then never
// answers. It is deliberately generous: slow reasoning models are normal, a
// request still open after a minute is not.
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export interface FetchJsonOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(errorContext: string, timeoutMs: number) {
    super(`${errorContext}: timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeoutSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  errorContext = 'Request failed',
  options: FetchJsonOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? globalFetch;

  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: withTimeoutSignal(init.signal, timeoutMs) });
  } catch (error) {
    // A caller-supplied signal aborting is the caller's business; surface it
    // unchanged. Only our own timeout gets translated.
    if (isTimeoutAbort(error) && !init.signal?.aborted) {
      throw new FetchTimeoutError(errorContext, timeoutMs);
    }
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${errorContext}: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return await response.json() as T;
}

function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Compare two secrets without leaking their contents through timing. Length is
 * not secret here — both sides are fixed-length shared secrets.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

/** Canonical lower-case hex encoding for Web Crypto results. */
export function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 for the string fingerprints and stored token digests used by the Worker. */
export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export interface HashTokenOptions {
  label: string;
  minLength: number;
  maxLength?: number;
}

/** Hashes opaque tokens, optionally validating the shared URL-safe token form. */
export async function hashToken(value: string, options?: HashTokenOptions): Promise<string> {
  if (!options) return await sha256Hex(value);
  const normalized = value.trim();
  const maxLength = options.maxLength ?? 128;
  if (
    normalized.length < options.minLength ||
    normalized.length > maxLength ||
    !/^[a-zA-Z0-9_-]+$/.test(normalized)
  ) {
    throw new Error(`Invalid ${options.label}.`);
  }
  return await sha256Hex(normalized);
}

export function getFirstChoiceContent(
  response: { choices?: Array<{ message?: { content?: string | null } }> },
  errorMessage: string,
): string {
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(errorMessage);
  }

  return content;
}
