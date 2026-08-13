import type { Env } from '../src/env';
import type { RedisClient } from '../src/utils/redis';
import { ArtifactGateway } from '../src/agent/box/artifact_gateway';
import { BoxJobService } from '../src/agent/box/box_job_service';
import { BoxJobStore } from '../src/agent/box/box_job_store';
import { shouldRouteToBox } from '../src/agent/box/hybrid_router';
import type { LaunchPiBoxJobInput } from '../src/agent/box/box_launcher';

class MemoryRedis {
  readonly values = new Map<string, string>();
  readonly sorted = new Map<string, Array<{ score: number; member: string }>>();

  async get(key: string) { return this.values.get(key) ?? null; }
  async getMany(keys: string[]) { return keys.map(key => this.values.get(key) ?? null); }
  async set(key: string, value: string) { this.values.set(key, value); }
  async zadd(key: string, score: number, member: string) {
    const entries = this.sorted.get(key) ?? [];
    entries.push({ score, member });
    entries.sort((left, right) => left.score - right.score);
    this.sorted.set(key, entries);
  }
  async zrangeAll(key: string, limit = 200) {
    return (this.sorted.get(key) ?? []).slice(0, limit).map(entry => entry.member);
  }
  async withLock<T>(_scope: string, action: () => Promise<T>) { return await action(); }
}

const now = Date.UTC(2026, 7, 13, 12, 0, 0);
const prompt = 'Research serverless control planes, then create a concise PDF report with source links.';
const callbackSecret = 'local-demo-callback-secret-with-32-characters';
const env = {
  OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODELS: '',
  TELEGRAM_BOT_TOKEN: 'local-demo-token', TELEGRAM_WEBHOOK_SECRET: 'local-demo-webhook-secret',
  WHITELISTED_USERS: 'demo-owner', OWNER_USER_ID: 'demo-owner',
  SYSTEM_INIT_MESSAGE: 'demo', SYSTEM_INIT_MESSAGE_ROLE: 'system', DEFAULT_MODEL: 'demo-model',
  UPSTASH_REDIS_REST_URL: 'https://redis.invalid', UPSTASH_REDIS_REST_TOKEN: 'local-demo-redis-token',
  CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', FLUX_STEPS: '4',
  GOOGLE_MODEL_KEY: 'local-demo-model-key', GOOGLE_MODELS: 'demo-model',
  GROQ_API_KEY: '', GROQ_MODELS: '', CLAUDE_API_KEY: '', CLAUDE_MODELS: '',
  AZURE_API_KEY: '', AZURE_MODELS: '', AZURE_ENDPOINT: '',
  BOX_AGENT_ENABLED: 'true', BOX_ALLOW_GROUP_MEMBERS: 'false', UPSTASH_BOX_API_KEY: 'local-demo-box-key',
  BOX_CALLBACK_URL: 'https://worker.demo.invalid/box/callback', BOX_CALLBACK_SECRET: callbackSecret,
  DEEPSEEK_API_KEY: 'local-demo-deepseek-key',
  ARTIFACT_BUCKET: {} as R2Bucket,
} as Env;

async function main() {
  const memory = new MemoryRedis();
  const redis = memory as unknown as RedisClient;
  const store = new BoxJobStore(redis);
  const artifacts = new ArtifactGateway(env, redis, { jobs: store, now: () => now });
  const launches: LaunchPiBoxJobInput[] = [];
  const messages: string[] = [];
  const documents: Array<{ filename: string; url: string }> = [];

  const service = new BoxJobService(env, redis, {
    store,
    artifacts,
    now: () => now,
    launchJob: async input => {
      launches.push(input);
      return { boxId: 'demo-box', runId: 'demo-run', route: input.route.route, model: input.route.model };
    },
    sendMessage: async (_chatId, text) => { messages.push(text); },
    sendDocument: async (_chatId, url, filename) => { documents.push({ filename, url }); },
    deleteBox: async () => undefined,
  });

  console.log('Telegram Box Agent — provider-free control-plane demo');
  console.log(`1. Router: ${shouldRouteToBox(prompt) ? 'Box' : 'ordinary chat'}`);
  await service.bindChat(-100_000_000_001, 'group:-100000000001');
  const queued = await service.queue({
    chatId: -100_000_000_001,
    sessionKey: 'group:-100000000001',
    userId: 'demo-owner',
    request: prompt,
  });
  console.log(`2. Accepted immediately: ${queued.job.id} (${queued.job.status})`);

  await queued.provision();
  console.log(`3. Execution plane attached: ${(await store.get(queued.job.id))?.status}`);

  const artifact = await artifacts.store.create({
    jobId: queued.job.id,
    chatId: queued.job.chatId,
    userId: queued.job.userId,
    filename: 'serverless-sandbox-report.pdf',
    contentType: 'application/pdf',
    declaredSize: 24_576,
    uploadToken: 'local_demo_upload_token_123456',
    idempotencyKey: 'a'.repeat(64),
    uploadExpiresAt: now + 60_000,
    now,
  });
  await artifacts.store.markUploaded(artifact.id, { actualSize: artifact.declaredSize, etag: 'demo-etag', now });

  const webhook = launches[0].webhook;
  const callback = new Request(webhook.url, {
    method: 'POST',
    headers: webhook.headers,
    body: JSON.stringify({
      box_id: 'demo-box', run_id: 'demo-run', status: 'completed',
      output: 'Research complete. The report was published as a private artifact.',
    }),
  });
  const response = await service.handleCompletion(callback);
  if (!response.ok) throw new Error(`Demo callback failed with HTTP ${response.status}`);

  const completed = await store.get(queued.job.id);
  console.log(`4. Signed callback applied: ${completed?.status}`);
  console.log(`5. Telegram message: ${messages.at(-1)?.split('\n')[0]}`);
  console.log(`6. Private artifact delivery: ${documents[0]?.filename} (24-hour signed URL)`);
  console.log('Demo complete. No provider, Telegram, Redis, Cloudflare, R2, or Box account was contacted.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
