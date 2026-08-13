import { describe, expect, it } from 'vitest';
import { verifyScheduleCallbackSignature } from './schedule_callback_auth';

const CURRENT_KEY = 'test-current-qstash-signing-key-with-enough-entropy';
const NEXT_KEY = 'test-next-qstash-signing-key-with-enough-entropy';
const CALLBACK_URL = 'https://worker.example.com/webhook/box/schedule';

function base64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function signCallback(body: string, url = CALLBACK_URL): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: 'Upstash',
        sub: url,
        body: await sha256(body),
        iat: now,
        nbf: now - 1,
        exp: now + 60,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CURRENT_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function verify(body: string, signature: string, url = CALLBACK_URL): Promise<boolean> {
  return verifyScheduleCallbackSignature({
    request: new Request(url, {
      method: 'POST',
      headers: { 'Upstash-Signature': signature },
      body,
    }),
    body,
    currentSigningKey: CURRENT_KEY,
    nextSigningKey: NEXT_KEY,
  });
}

describe('verifyScheduleCallbackSignature', () => {
  it('accepts an authentic QStash JWT for the exact callback URL and body', async () => {
    const body = JSON.stringify({ run_id: 'run-123', output: 'finished' });

    await expect(verify(body, await signCallback(body))).resolves.toBe(true);
  });

  it('rejects replay against a different body or callback URL', async () => {
    const body = JSON.stringify({ run_id: 'run-123', output: 'finished' });
    const signature = await signCallback(body);

    await expect(verify(`${body} `, signature)).resolves.toBe(false);
    await expect(verify(body, signature, `${CALLBACK_URL}?job=other`)).resolves.toBe(false);
  });

  it('rejects missing and invalid signatures without throwing', async () => {
    const body = '{}';
    const missing = await verifyScheduleCallbackSignature({
      request: new Request(CALLBACK_URL, { method: 'POST', body }),
      body,
      currentSigningKey: CURRENT_KEY,
      nextSigningKey: NEXT_KEY,
    });

    expect(missing).toBe(false);
    await expect(verify(body, 'not-a-jwt')).resolves.toBe(false);
  });
});
