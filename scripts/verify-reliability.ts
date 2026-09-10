import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { LuaRedis } from '../src/test/lua_redis';

await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'browser', format: 'esm',
  external: ['node:*'], outfile: 'output/reliability-worker.mjs' });
const redis = new LuaRedis();
redis.now = Date.now();
const sent: string[] = [];
let release!: () => void;
const pausedModel = new Promise<void>(resolve => { release = resolve; });
let modelCalls = 0;
let outboundCalls = 0;
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'bot', scriptPath: 'output/reliability-worker.mjs', modules: true,
  compatibilityDate: '2024-09-29', compatibilityFlags: ['nodejs_compat'],
  serviceBindings: { INBOX_WORKER: 'bot' },
  bindings: {
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    WHITELISTED_USERS: '1', OWNER_USER_ID: '1',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test',
    OPENAI_COMPATIBLE_KEY: 'test', OPENAI_COMPATIBLE_URL: 'https://model.test',
    OPENAI_COMPATIBLE_MODELS: 'test-model', DEFAULT_MODEL: 'test-model',
    SYSTEM_INIT_MESSAGE: 'Test assistant', SYSTEM_INIT_MESSAGE_ROLE: 'system',
  },
  outboundService: async request => {
    outboundCalls++;
    const url = new URL(request.url);
    if (url.hostname === 'redis.test') {
      const body = await request.json() as any[];
      if (url.pathname === '/pipeline') return Response.json(await Promise.all(body.map(async command => ({ result: await redis.execute(command) }))));
      return Response.json({ result: await redis.execute(body) });
    }
    if (url.hostname === 'model.test') {
      if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] });
      modelCalls++; await pausedModel;
      const body = await request.json() as { stream?: boolean };
      if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Runtime smoke reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Runtime smoke reply' } }] });
    }
    if (url.hostname === 'api.telegram.org') {
      if (url.pathname.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 2, username: 'test_bot' } });
      const body = await request.json() as { text?: string };
      if (url.pathname.endsWith('/sendMessage')) sent.push(body.text ?? '');
      return Response.json({ ok: true, result: { message_id: 55 } });
    }
    throw new Error(`Unexpected smoke-test outbound host: ${url.hostname}`);
  },
}] }));
try {
  const body = JSON.stringify({ update_id: 9001, message: {
    message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'Test', is_bot: false }, text: 'hello', date: 1,
  } });
  const submit = () => mf.dispatchFetch('https://bot.test/webhook', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' } });
  assert.equal((await submit()).status, 200);
  assert.ok(await redis.get('inbox:v1:update:9001'));
  assert.deepEqual(sent, []);
  const delay = Number(process.env.SMOKE_MODEL_DELAY_MS ?? 0);
  if (delay) setTimeout(release, delay); else release();
  const deadline = Date.now() + delay + 15000;
  while (Date.now() < deadline) {
    const record = JSON.parse((await redis.get('inbox:v1:update:9001'))!);
    if (record.state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(JSON.parse((await redis.get('inbox:v1:update:9001'))!).state, 'completed');
  assert.deepEqual(sent, ['Runtime smoke reply']);
  assert.equal((await submit()).status, 200);
  assert.equal(modelCalls, 1);
  assert.equal(sent.length, 1);
  assert.ok(outboundCalls <= 50, `Basic reply exceeded 50 outbound calls: ${outboundCalls}`);
  assert.equal((await mf.dispatchFetch('https://bot.test/internal/inbox', { method: 'POST' })).status, 403);
  console.log(`Worker runtime smoke passed: acceptance, dispatch, execution, delivery, deduplication, authentication; ${outboundCalls} outbound calls.`);
} finally {
  release();
  await mf.dispose();
}
