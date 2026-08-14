/**
 * Telegram Mini App `initData` verification.
 *
 * Telegram signs the launch payload with a key derived from the bot token, so
 * possession of a valid `initData` proves Telegram issued it *and* identifies
 * which user it was issued to. That is strictly stronger than the dashboard's
 * bearer session, which only proves the holder once had a link.
 *
 * Algorithm, per https://core.telegram.org/bots/webapps — note that Telegram's
 * `HMAC_SHA256(data, key)` notation puts the *message* first:
 *
 *   secret_key = HMAC_SHA256(<bot_token>, "WebAppData")
 *   hash       = hex(HMAC_SHA256(data_check_string, secret_key))
 *
 * `data_check_string` is every received field except `hash` (and `signature`,
 * which carries the separate Ed25519 third-party proof and is not covered by
 * this HMAC), sorted alphabetically, as `key=value` joined by newlines.
 */

const WEB_APP_DATA_KEY = 'WebAppData';

/** Rejects a replayed launch payload. Telegram suggests checking `auth_date`
 * but names no window; an hour is generous for a session that is re-launched
 * on every open. */
export const MINIAPP_MAX_AUTH_AGE_MS = 60 * 60_000;

export interface MiniAppIdentity {
  userId: string;
  firstName?: string;
  username?: string;
  languageCode?: string;
  /**
   * The chat the app was launched from, present only for attachment-menu
   * launches in a group or channel. A menu-button launch happens in the
   * private chat with the bot and carries no `chat`, so this is undefined and
   * the caller falls back to the private session.
   *
   * Deliberately not derived from `chat_instance`: that is an opaque per-chat
   * identifier, not a chat ID, and treating it as one would silently address
   * the wrong session.
   */
  chatId?: number;
  authDate: number;
}

export type MiniAppVerification =
  | { valid: true; identity: MiniAppIdentity }
  | { valid: false; reason: string };

export async function verifyMiniAppInitData(input: {
  initData: string;
  botToken: string;
  now?: number;
  maxAgeMs?: number;
}): Promise<MiniAppVerification> {
  const botToken = input.botToken?.trim() ?? '';
  if (!botToken) return { valid: false, reason: 'bot token is not configured' };
  if (!input.initData) return { valid: false, reason: 'missing init data' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(input.initData);
  } catch {
    return { valid: false, reason: 'malformed init data' };
  }

  const suppliedHash = params.get('hash') ?? '';
  if (!/^[a-f0-9]{64}$/i.test(suppliedHash)) return { valid: false, reason: 'missing init data hash' };

  const authDate = Number.parseInt(params.get('auth_date') ?? '', 10);
  if (!Number.isFinite(authDate) || authDate <= 0) return { valid: false, reason: 'invalid auth_date' };

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secretKey = await hmac(new TextEncoder().encode(WEB_APP_DATA_KEY), botToken);
  const expected = toHex(await hmac(secretKey, dataCheckString));
  if (!constantTimeEqual(expected, suppliedHash.toLowerCase())) {
    return { valid: false, reason: 'invalid init data signature' };
  }

  // Freshness is checked only after the signature, so an unsigned payload can
  // never learn anything from the timing of an expiry response.
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? MINIAPP_MAX_AUTH_AGE_MS;
  const ageMs = now - authDate * 1000;
  if (ageMs > maxAgeMs) return { valid: false, reason: 'init data has expired' };
  if (ageMs < -60_000) return { valid: false, reason: 'init data is dated in the future' };

  const identity = parseIdentity(params, authDate);
  if (!identity) return { valid: false, reason: 'init data has no usable user' };
  return { valid: true, identity };
}

function parseIdentity(params: URLSearchParams, authDate: number): MiniAppIdentity | null {
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(params.get('user') ?? '') as Record<string, unknown>;
  } catch {
    return null;
  }
  // Telegram sends `id` as a JSON number. Normalising to string here keeps it
  // comparable with OWNER_USER_ID and WHITELISTED_USERS, which are strings
  // everywhere else in this codebase.
  const id = user?.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;

  return {
    userId: String(id),
    firstName: optionalString(user.first_name),
    username: optionalString(user.username),
    languageCode: optionalString(user.language_code),
    chatId: parseChatId(params.get('chat')),
    authDate,
  };
}

function parseChatId(raw: string | null): number | undefined {
  if (!raw) return undefined;
  try {
    const chat = JSON.parse(raw) as { id?: unknown };
    return typeof chat?.id === 'number' && Number.isSafeInteger(chat.id) ? chat.id : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
