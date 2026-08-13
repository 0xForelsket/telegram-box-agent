import { Box } from '@upstash/box';
import { getConfig, type Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import { createBoxCallbackAuthorization, verifyBoxCallbackAuthorization } from './callback_auth';
import { createPiBoxSchedule } from './box_launcher';
import { BoxScheduleStore } from './box_schedule_store';
import { isGlmCodingTask } from './hybrid_router';
import { resolvePiModelRoute } from './pi_runtime';
import { verifyScheduleCallbackSignature, type VerifyScheduleCallbackInput } from './schedule_callback_auth';

type UpstreamSchedule = {
  id: string;
  box_id: string;
  status: 'active' | 'paused' | 'deleted';
  last_run_id?: string;
  last_run_status?: 'completed' | 'failed' | 'skipped';
  qstash_schedule_id?: string;
};

type ScheduleBox = {
  schedule: {
    get(id: string): Promise<UpstreamSchedule>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  delete(): Promise<void>;
};

export interface BoxScheduleServiceDependencies {
  store?: BoxScheduleStore;
  createSchedule?: typeof createPiBoxSchedule;
  getBox?: (boxId: string, apiKey: string, baseUrl?: string) => Promise<ScheduleBox>;
  verifyScheduleSignature?: (input: VerifyScheduleCallbackInput) => Promise<boolean>;
  now?: () => number;
}

export class BoxScheduleService {
  private readonly config: ReturnType<typeof getConfig>;
  readonly store: BoxScheduleStore;
  private readonly createSchedule: typeof createPiBoxSchedule;
  private readonly getBox: NonNullable<BoxScheduleServiceDependencies['getBox']>;
  private readonly verifyScheduleSignature: NonNullable<BoxScheduleServiceDependencies['verifyScheduleSignature']>;
  private readonly now: () => number;

  constructor(
    private readonly env: Env,
    private readonly redis: RedisClient,
    private readonly sendMessage: (chatId: number, text: string) => Promise<unknown> = async () => undefined,
    dependencies: BoxScheduleServiceDependencies = {},
  ) {
    this.config = getConfig(env);
    this.store = dependencies.store ?? new BoxScheduleStore(redis);
    this.createSchedule = dependencies.createSchedule ?? createPiBoxSchedule;
    this.getBox = dependencies.getBox ?? (async (boxId, apiKey, baseUrl) => await Box.get(boxId, { apiKey, baseUrl }));
    this.verifyScheduleSignature = dependencies.verifyScheduleSignature ?? verifyScheduleCallbackSignature;
    this.now = dependencies.now ?? Date.now;
  }

  async create(input: { chatId: number; ownerUserId: string; cron: string; prompt: string; requestedRoute?: string }) {
    this.requireOwner(input.ownerUserId);
    if (!this.config.boxAgentEnabled) throw new Error('Box agent execution is disabled.');
    if (!this.config.boxSnapshotId || !this.config.upstashBoxApiKey || !this.config.boxCallbackUrl || !this.config.boxCallbackSecret
      || !this.config.qstashCurrentSigningKey || !this.config.qstashNextSigningKey) {
      throw new Error('Box schedule runtime is not fully configured.');
    }
    const cron = normalizeCron(input.cron);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Schedule prompt is empty.');
    const route = resolvePiModelRoute({
      requestedRoute: input.requestedRoute,
      actorUserId: input.ownerUserId,
      ownerUserId: this.config.ownerUserId,
      deepseekApiKey: this.config.deepseekApiKey,
      zaiCodingPlanApiKey: this.config.zaiCodingPlanApiKey,
      deepseekRateCard: {
        inputUsdPerMTokens: this.config.boxDeepseekInputUsdPerMTokens,
        cachedInputUsdPerMTokens: this.config.boxDeepseekCachedInputUsdPerMTokens,
        outputUsdPerMTokens: this.config.boxDeepseekOutputUsdPerMTokens,
      },
    });
    if (route.route === 'glm' && !isGlmCodingTask(prompt)) throw new Error('GLM schedules are restricted to owner coding tasks.');
    const callbackNonce = crypto.randomUUID().replace(/-/g, '');
    const approvalNonce = crypto.randomUUID().replace(/-/g, '');
    const record = await this.store.create({
      chatId: input.chatId, ownerUserId: input.ownerUserId, cron, prompt, route: route.route, model: route.model, callbackNonce,
    });
    try {
      const callbackUrl = `${new URL(this.config.boxCallbackUrl).origin}/box/schedule-callback`;
      const webhook = await createBoxCallbackAuthorization({
        url: callbackUrl, secret: this.config.boxCallbackSecret, jobId: record.id, nonce: callbackNonce,
      });
      const created = await this.createSchedule({
        scheduleId: record.id, cron, prompt,
        boxApiKey: this.config.upstashBoxApiKey, boxBaseUrl: this.config.upstashBoxBaseUrl,
        snapshotId: this.config.boxSnapshotId, route, approvalNonce,
        webhook: { url: webhook.url, headers: webhook.headers },
      });
      return await this.store.update(record.id, { status: 'active', boxId: created.boxId, upstreamScheduleId: created.scheduleId });
    } catch (error) {
      await this.store.update(record.id, { status: 'error', lastError: message(error) });
      throw error;
    }
  }

  async list(chatId: number, ownerUserId: string) {
    this.requireOwner(ownerUserId);
    return await this.store.list(chatId);
  }

  async change(chatId: number, ownerUserId: string, id: string, action: 'pause' | 'resume' | 'delete') {
    this.requireOwner(ownerUserId);
    const record = await this.store.get(id);
    if (!record || record.chatId !== chatId || !record.boxId || !record.upstreamScheduleId) throw new Error('Box schedule not found in this chat.');
    const box = await this.getBox(record.boxId, this.config.upstashBoxApiKey!, this.config.upstashBoxBaseUrl);
    if (action === 'pause') {
      await box.schedule.pause(record.upstreamScheduleId);
      return await this.store.update(record.id, { status: 'paused' });
    }
    if (action === 'resume') {
      await box.schedule.resume(record.upstreamScheduleId);
      return await this.store.update(record.id, { status: 'active' });
    }
    await box.schedule.delete(record.upstreamScheduleId);
    await box.delete();
    return await this.store.update(record.id, { status: 'deleted' });
  }

  async recoverDeliveries(chatId: number): Promise<number> {
    let recovered = 0;
    for (const schedule of await this.store.list(chatId)) {
      for (const run of await this.store.listPendingRuns(schedule.id, 50)) {
        await this.deliverRun(schedule.chatId, schedule.id, run.id)
          .catch(error => console.error('Box schedule delivery recovery failed:', error));
        recovered += 1;
      }
    }
    return recovered;
  }

  async handleCallback(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    const id = request.headers.get('X-Box-Job-Id')?.trim().toLowerCase() ?? '';
    const record = await this.store.get(id);
    if (!record || !this.config.boxCallbackSecret) return Response.json({ error: 'Schedule not found.' }, { status: 404 });
    if (record.status !== 'active') return Response.json({ error: 'Schedule is not active.' }, { status: 409 });
    if (!record.boxId || !record.upstreamScheduleId || !this.config.upstashBoxApiKey) {
      return Response.json({ error: 'Schedule runtime identity is incomplete.' }, { status: 409 });
    }
    if (!this.config.qstashCurrentSigningKey || !this.config.qstashNextSigningKey) {
      return Response.json({ error: 'QStash callback verification is not configured.' }, { status: 503 });
    }
    const body = await request.text();
    const qstashValid = await this.verifyScheduleSignature({
      request,
      body,
      currentSigningKey: this.config.qstashCurrentSigningKey,
      nextSigningKey: this.config.qstashNextSigningKey,
    });
    if (!qstashValid) return Response.json({ error: 'Unauthorized QStash callback.' }, { status: 401 });
    const auth = await verifyBoxCallbackAuthorization({
      headers: request.headers, secret: this.config.boxCallbackSecret, expectedJobId: id,
      maxAgeMs: 10 * 365 * 24 * 60 * 60_000,
    });
    if (!auth.valid) return Response.json({ error: 'Unauthorized schedule callback.' }, { status: 401 });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid schedule callback JSON.' }, { status: 400 });
    }
    if (payload.status !== 'completed' && payload.status !== 'failed') return Response.json({ error: 'Invalid schedule status.' }, { status: 400 });
    if (typeof payload.run_id !== 'string' || !payload.run_id.trim()) return Response.json({ error: 'Missing schedule run ID.' }, { status: 400 });

    let upstream: UpstreamSchedule;
    try {
      const box = await this.getBox(record.boxId, this.config.upstashBoxApiKey, this.config.upstashBoxBaseUrl);
      upstream = await box.schedule.get(record.upstreamScheduleId);
    } catch {
      return Response.json({ error: 'Unable to attest the scheduled run.' }, { status: 503 });
    }
    const qstashScheduleId = request.headers.get('Upstash-Schedule-Id')?.trim();
    if (upstream.id !== record.upstreamScheduleId || upstream.box_id !== record.boxId
      || upstream.status !== 'active' || upstream.last_run_id !== payload.run_id
      || upstream.last_run_status !== payload.status
      || (qstashScheduleId && upstream.qstash_schedule_id && qstashScheduleId !== upstream.qstash_schedule_id)) {
      return Response.json({ error: 'Scheduled run attestation failed.' }, { status: 409 });
    }
    const applied = await this.store.applyRun(id, auth.nonce, {
      run_id: payload.run_id,
      status: payload.status,
      output: typeof payload.output === 'string' ? payload.output : undefined,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    });
    await this.deliverRun(record.chatId, record.id, applied.run.id);
    return Response.json({ ok: true, duplicate: applied.duplicate });
  }

  private async deliverRun(chatId: number, scheduleId: string, runId: string): Promise<void> {
    const claim = await this.store.claimRunDelivery(runId, this.now());
    if (!claim) return;
    try {
      const detail = claim.run.status === 'completed' ? claim.run.output : claim.run.error;
      await this.sendMessage(chatId, `Scheduled Box job ${scheduleId}: ${claim.run.status}${detail ? `\n\n${detail.slice(0, 12_000)}` : ''}`);
      await this.store.markRunDelivered(runId, claim.leaseId, this.now());
    } catch (error) {
      await this.store.releaseRunDelivery(runId, claim.leaseId);
      throw error;
    }
  }

  private requireOwner(userId: string) {
    if (!this.config.ownerUserId || userId !== this.config.ownerUserId) throw new Error('Only the bot owner can manage Box schedules.');
  }
}

function normalizeCron(value: string): string {
  const cron = value.trim().replace(/^['"]|['"]$/g, '');
  const fields = cron.split(/\s+/);
  if (fields.length !== 5 || fields.some(field => !/^[\d*/?,\-]+$/.test(field))) throw new Error('Use a standard five-field UTC cron expression.');
  return fields.join(' ');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_000) : 'Box schedule operation failed.';
}
