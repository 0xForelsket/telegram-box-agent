/**
 * Image payload handling for vision requests.
 *
 * A provider given `image_url.url` fetches that URL from its own servers, so
 * whatever the URL contains is disclosed to the provider and retained in its
 * request logs. Telegram file URLs embed the bot token
 * (`/file/bot<TELEGRAM_BOT_TOKEN>/...`), and that token is full control of the
 * bot. Inlining the bytes here keeps the URL — and any credential inside it —
 * within the Worker, and applies the same size ceiling to every provider.
 */

import { globalFetch } from '../utils/helpers';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface InlineImage {
  /** `data:<mime>;base64,<payload>`, safe to hand to any provider. */
  dataUrl: string;
  base64: string;
  mimeType: string;
}

const DATA_URL = /^data:([^;,]*)(;base64)?,/i;

/**
 * Downloads `imageUrl` and returns it as an inline payload. An input that is
 * already a base64 `data:` URL is reused rather than re-fetched, so a caller
 * that has inlined the image cannot be made to leak a URL by a later provider.
 */
export async function inlineImage(
  imageUrl: string,
  fetchImpl: typeof fetch = globalFetch,
): Promise<InlineImage> {
  const existing = parseDataUrl(imageUrl);
  if (existing) return existing;

  const response = await fetchImpl(imageUrl);
  if (!response.ok) throw new Error(`Could not download image: HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES}-byte analysis limit.`);
  }

  const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const mimeType = declared.startsWith('image/') ? declared : 'image/jpeg';
  const base64 = toBase64(bytes);
  return { dataUrl: `data:${mimeType};base64,${base64}`, base64, mimeType };
}

function parseDataUrl(value: string): InlineImage | null {
  const match = value.match(DATA_URL);
  if (!match || !match[2]) return null;
  const mimeType = match[1].trim().toLowerCase() || 'image/jpeg';
  const base64 = value.slice(match[0].length);
  return { dataUrl: value, base64, mimeType };
}

/**
 * Chunked so a large image cannot overflow the call stack. Spreading a
 * multi-megabyte Uint8Array into String.fromCharCode throws RangeError once the
 * argument count passes the engine's limit.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
