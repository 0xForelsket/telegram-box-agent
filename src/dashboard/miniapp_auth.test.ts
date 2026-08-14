import { describe, expect, it } from 'vitest';
import { MINIAPP_MAX_AUTH_AGE_MS, verifyMiniAppInitData } from './miniapp_auth';

// Deliberately not shaped like a real bot token: `scan-git-history-secrets`
// flags `<digits>:<35 chars>` anywhere in the tree, and a fixture that trips
// the scanner on every run trains people to ignore it. The HMAC does not care
// about the format.
const BOT_TOKEN = 'test-bot-token-not-a-real-credential';
const NOW = 1_800_000_000_000;
const AUTH_DATE = Math.floor(NOW / 1000) - 30;

/**
 * Signs a payload the way Telegram does, so these tests fail if the
 * verification's key derivation order is wrong rather than merely
 * self-consistent with a shared helper.
 */
async function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): Promise<string> {
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const encoder = new TextEncoder();
  const secretKeyRaw = await crypto.subtle.importKey(
    'raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const secretKey = await crypto.subtle.sign('HMAC', secretKeyRaw, encoder.encode(botToken));

  const signingKey = await crypto.subtle.importKey(
    'raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(dataCheckString));
  const hash = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');

  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

const USER = JSON.stringify({ id: 1501649147, first_name: 'Sam', username: 'sam', language_code: 'en' });

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return { auth_date: String(AUTH_DATE), query_id: 'AAF-test', user: USER, ...overrides };
}

describe('verifyMiniAppInitData', () => {
  it('accepts a payload Telegram actually signed', async () => {
    const initData = await signInitData(baseFields());

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result).toMatchObject({
      valid: true,
      identity: { userId: '1501649147', username: 'sam', firstName: 'Sam' },
    });
  });

  it('exposes the user id as a string so it compares with OWNER_USER_ID', async () => {
    const initData = await signInitData(baseFields());

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result.valid && typeof result.identity.userId).toBe('string');
  });

  it('rejects a payload signed with a different bot token', async () => {
    const initData = await signInitData(baseFields(), 'a-different-test-bot-token');

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result).toEqual({ valid: false, reason: 'invalid init data signature' });
  });

  // The whole point of the signature: a user id cannot be chosen by the client.
  it('rejects a payload whose user was swapped after signing', async () => {
    const initData = await signInitData(baseFields());
    const tampered = new URLSearchParams(initData);
    tampered.set('user', JSON.stringify({ id: 999, first_name: 'Mallory' }));

    const result = await verifyMiniAppInitData({
      initData: tampered.toString(), botToken: BOT_TOKEN, now: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid init data signature' });
  });

  it('rejects a payload with an added field', async () => {
    const initData = await signInitData(baseFields());
    const tampered = new URLSearchParams(initData);
    tampered.set('chat_type', 'private');

    const result = await verifyMiniAppInitData({
      initData: tampered.toString(), botToken: BOT_TOKEN, now: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid init data signature' });
  });

  it('verifies independently of field order in the query string', async () => {
    const initData = await signInitData(baseFields());
    const reordered = [...new URLSearchParams(initData).entries()]
      .reverse()
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

    const result = await verifyMiniAppInitData({ initData: reordered, botToken: BOT_TOKEN, now: NOW });

    expect(result.valid).toBe(true);
  });

  // Telegram's Ed25519 third-party proof is not covered by this HMAC, so its
  // presence must not break verification.
  it('ignores the signature field when present', async () => {
    const initData = await signInitData(baseFields());
    const withSignature = new URLSearchParams(initData);
    withSignature.set('signature', 'ed25519-third-party-proof');

    const result = await verifyMiniAppInitData({
      initData: withSignature.toString(), botToken: BOT_TOKEN, now: NOW,
    });

    expect(result.valid).toBe(true);
  });

  it('rejects a replayed payload past the freshness window', async () => {
    const initData = await signInitData(baseFields());

    const result = await verifyMiniAppInitData({
      initData, botToken: BOT_TOKEN, now: NOW + MINIAPP_MAX_AUTH_AGE_MS + 60_000,
    });

    expect(result).toEqual({ valid: false, reason: 'init data has expired' });
  });

  it('accepts a payload just inside the freshness window', async () => {
    const initData = await signInitData(baseFields());

    const result = await verifyMiniAppInitData({
      initData, botToken: BOT_TOKEN, now: NOW + MINIAPP_MAX_AUTH_AGE_MS - 60_000,
    });

    expect(result.valid).toBe(true);
  });

  it('rejects a payload dated well into the future', async () => {
    const initData = await signInitData(baseFields({
      auth_date: String(Math.floor(NOW / 1000) + 3_600),
    }));

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result).toEqual({ valid: false, reason: 'init data is dated in the future' });
  });

  it('rejects an unsigned payload', async () => {
    const result = await verifyMiniAppInitData({
      initData: new URLSearchParams(baseFields()).toString(), botToken: BOT_TOKEN, now: NOW,
    });

    expect(result).toEqual({ valid: false, reason: 'missing init data hash' });
  });

  it('rejects empty init data', async () => {
    const result = await verifyMiniAppInitData({ initData: '', botToken: BOT_TOKEN, now: NOW });

    expect(result).toEqual({ valid: false, reason: 'missing init data' });
  });

  it('refuses to verify anything when the bot token is unset', async () => {
    const initData = await signInitData(baseFields());

    const result = await verifyMiniAppInitData({ initData, botToken: '', now: NOW });

    expect(result).toEqual({ valid: false, reason: 'bot token is not configured' });
  });

  it('rejects a validly signed payload carrying no user', async () => {
    const initData = await signInitData({ auth_date: String(AUTH_DATE), query_id: 'AAF-test' });

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result).toEqual({ valid: false, reason: 'init data has no usable user' });
  });

  it('rejects a signed payload whose user id is not a positive integer', async () => {
    const initData = await signInitData(baseFields({
      user: JSON.stringify({ id: 'not-a-number', first_name: 'X' }),
    }));

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result).toEqual({ valid: false, reason: 'init data has no usable user' });
  });
});

describe('launch context', () => {
  it('reads the chat id from an attachment-menu launch', async () => {
    const initData = await signInitData(baseFields({
      chat: JSON.stringify({ id: -652447362, type: 'group', title: 'Bound group' }),
    }));

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result.valid && result.identity.chatId).toBe(-652447362);
  });

  // `chat_instance` is an opaque per-chat identifier, not a chat ID. Reading it
  // as one would address the wrong session's data.
  it('does not mistake chat_instance for a chat id', async () => {
    const initData = await signInitData(baseFields({ chat_instance: '-9127384756102938' }));

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result.valid && result.identity.chatId).toBeUndefined();
  });

  it('leaves the chat id unset for a private menu-button launch', async () => {
    const initData = await signInitData(baseFields());

    const result = await verifyMiniAppInitData({ initData, botToken: BOT_TOKEN, now: NOW });

    expect(result.valid && result.identity.chatId).toBeUndefined();
  });
});
