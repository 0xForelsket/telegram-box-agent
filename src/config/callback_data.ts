/**
 * Inline-keyboard `callback_data` encoding.
 *
 * Telegram caps `callback_data` at 64 bytes and rejects the whole
 * `sendMessage` when any button exceeds it, so a long model name would break
 * the entire picker rather than just its own row. Encoding and decoding live
 * together here so the two sides cannot drift apart.
 */

export const MODEL_CALLBACK_PREFIX = 'model_';
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export function encodeModelCallbackData(model: string): string {
  return `${MODEL_CALLBACK_PREFIX}${model}`;
}

export function decodeModelCallbackData(data: string): string | null {
  return data.startsWith(MODEL_CALLBACK_PREFIX)
    ? data.slice(MODEL_CALLBACK_PREFIX.length)
    : null;
}

export function fitsCallbackData(value: string): boolean {
  const size = new TextEncoder().encode(value).length;
  return size > 0 && size <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}
