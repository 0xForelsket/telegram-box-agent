import { bytesToHex, constantTimeEqual } from '../../utils/helpers';

const SIGNATURE_VERSION = 'v1';
// Callback replay is prevented by the one-time nonce stored with the job. Keep
// the signed request valid for the job-record lifetime so Worker policy does
// not impose an artificial execution timeout on Box.
export const BOX_CALLBACK_MAX_AGE_MS = 45 * 24 * 60 * 60_000;

export interface BoxCallbackAuthorization {
  url: string;
  headers: Record<string, string>;
  nonce: string;
  timestamp: number;
}

export async function createBoxCallbackAuthorization(input: {
  url: string;
  secret: string;
  jobId: string;
  now?: number;
  nonce?: string;
}): Promise<BoxCallbackAuthorization> {
  const url = new URL(input.url).toString();
  const secret = requireSecret(input.secret);
  const jobId = requireToken(input.jobId, 'job ID');
  const timestamp = Math.trunc(input.now ?? Date.now());
  const nonce = requireToken(input.nonce ?? crypto.randomUUID(), 'callback nonce');
  const signature = await sign(secret, canonicalPayload(jobId, timestamp, nonce));
  return {
    url,
    nonce,
    timestamp,
    headers: {
      'X-Box-Callback-Version': SIGNATURE_VERSION,
      'X-Box-Job-Id': jobId,
      'X-Box-Callback-Timestamp': String(timestamp),
      'X-Box-Callback-Nonce': nonce,
      'X-Box-Callback-Signature': signature,
    },
  };
}

export async function verifyBoxCallbackAuthorization(input: {
  headers: Headers;
  secret: string;
  expectedJobId: string;
  now?: number;
  maxAgeMs?: number;
}): Promise<{ valid: true; nonce: string; timestamp: number } | { valid: false; reason: string }> {
  const version = input.headers.get('X-Box-Callback-Version');
  const jobId = input.headers.get('X-Box-Job-Id') ?? '';
  const timestampRaw = input.headers.get('X-Box-Callback-Timestamp') ?? '';
  const nonce = input.headers.get('X-Box-Callback-Nonce') ?? '';
  const suppliedSignature = input.headers.get('X-Box-Callback-Signature') ?? '';
  if (version !== SIGNATURE_VERSION) return { valid: false, reason: 'unsupported signature version' };
  if (jobId !== input.expectedJobId) return { valid: false, reason: 'job ID mismatch' };
  if (!nonce || !suppliedSignature) return { valid: false, reason: 'missing callback credentials' };

  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: 'invalid callback timestamp' };
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? BOX_CALLBACK_MAX_AGE_MS;
  if (timestamp > now + 60_000 || now - timestamp > maxAgeMs) {
    return { valid: false, reason: 'expired callback authorization' };
  }

  let expectedSignature: string;
  try {
    expectedSignature = await sign(requireSecret(input.secret), canonicalPayload(jobId, timestamp, nonce));
  } catch {
    return { valid: false, reason: 'callback secret is not configured' };
  }
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
    return { valid: false, reason: 'invalid callback signature' };
  }
  return { valid: true, nonce, timestamp };
}

function canonicalPayload(jobId: string, timestamp: number, nonce: string): string {
  return [SIGNATURE_VERSION, jobId, timestamp, nonce].join('\n');
}

async function sign(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(signature);
}

function requireSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 32) throw new Error('BOX_CALLBACK_SECRET must be at least 32 characters.');
  return secret;
}

function requireToken(value: string, label: string): string {
  const token = value.trim();
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(token)) throw new Error(`Invalid ${label}.`);
  return token;
}
