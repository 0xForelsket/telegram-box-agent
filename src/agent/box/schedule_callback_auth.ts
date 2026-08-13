import { jwtVerify, type JWTPayload } from 'jose';

export interface VerifyScheduleCallbackInput {
  request: Request;
  body: string;
  currentSigningKey: string;
  nextSigningKey: string;
}

function base64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function verifyJwt(signature: string, signingKey: string): Promise<JWTPayload> {
  const verified = await jwtVerify(signature, new TextEncoder().encode(signingKey), {
    algorithms: ['HS256'],
    issuer: 'Upstash',
    clockTolerance: 60,
  });
  return verified.payload;
}

/**
 * Verifies QStash's short-lived JWT over the exact callback URL and raw body.
 * The static Box webhook headers remain a schedule identifier, but are never
 * sufficient by themselves to authorize a recurring result.
 */
export async function verifyScheduleCallbackSignature(input: VerifyScheduleCallbackInput): Promise<boolean> {
  const signature = input.request.headers.get('Upstash-Signature')?.trim();
  if (!signature) return false;

  try {
    let payload: JWTPayload;
    try {
      payload = await verifyJwt(signature, input.currentSigningKey);
    } catch {
      payload = await verifyJwt(signature, input.nextSigningKey);
    }

    if (payload.sub !== input.request.url || typeof payload.body !== 'string') return false;

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.body));
    return payload.body.replace(/=+$/g, '') === base64Url(new Uint8Array(digest));
  } catch {
    return false;
  }
}
