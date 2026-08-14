import { describe, expect, it } from 'vitest';
import {
  decodeModelCallbackData,
  encodeModelCallbackData,
  fitsCallbackData,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from './callback_data';

describe('model callback data', () => {
  it('round-trips a plain model name', () => {
    expect(decodeModelCallbackData(encodeModelCallbackData('gpt-5'))).toBe('gpt-5');
  });

  // Decoding with split('_') truncated to the first segment, which stored a
  // model that `resolveCurrentModel` then reverted — losing the conversation
  // while reporting success.
  it('round-trips a model name containing underscores', () => {
    const model = 'llama_3_70b_instruct';

    expect(decodeModelCallbackData(encodeModelCallbackData(model))).toBe(model);
  });

  it('ignores callback data belonging to another feature', () => {
    expect(decodeModelCallbackData('artifact_ba_123')).toBeNull();
  });

  it('accepts a name that fits Telegram\'s 64-byte callback limit', () => {
    const model = 'm'.repeat(TELEGRAM_CALLBACK_DATA_MAX_BYTES - 'model_'.length);

    expect(fitsCallbackData(encodeModelCallbackData(model))).toBe(true);
  });

  it('rejects a name one byte past the limit', () => {
    const model = 'm'.repeat(TELEGRAM_CALLBACK_DATA_MAX_BYTES - 'model_'.length + 1);

    expect(fitsCallbackData(encodeModelCallbackData(model))).toBe(false);
  });

  it('measures bytes rather than characters', () => {
    // Telegram's limit is on bytes; a multi-byte name that looks short by
    // `length` can still be rejected by the Bot API.
    const model = '模'.repeat(20);

    expect(model.length).toBeLessThan(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    expect(fitsCallbackData(encodeModelCallbackData(model))).toBe(false);
  });
});
