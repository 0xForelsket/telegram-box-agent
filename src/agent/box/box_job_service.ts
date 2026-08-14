import { Box, type WebhookPayload } from '@upstash/box';
import { getConfig, type Env } from '../../env';
import { RedisClient } from '../../utils/redis';
import { createBoxCallbackAuthorization, verifyBoxCallbackAuthorization } from './callback_auth';
import { launchPiBoxJob, resumeApprovedPiBoxJob, type LaunchPiBoxJobInput, type LaunchedPiBoxJob } from './box_launcher';
import { BoxJobStore, type BoxJob } from './box_job_store';
import { resolvePiModelRoute } from './pi_runtime';
import { ArtifactGateway, TELEGRAM_DOCUMENT_LIMIT_BYTES } from './artifact_gateway';
import { isGlmCodingTask } from './hybrid_router';
import { ActionBroker } from './action_broker';
import { UserFacingError } from '../../utils/user_facing_error';
import { localDayKey, secondsUntilLocalMidnight } from '../../utils/timezone';
import type { PromptFiles } from '@upstash/box';

const BOUND_CHAT_KEY = 'box_config:v1:bound_chat_id';
const ACTIVE_STATUSES = new Set(['queued', 'provisioning', 'running', 'awaiting_approval']);
export const MAX_GROUP_CONCURRENCY = 2;
export const MAX_DAILY_USER_STARTS = 5;

/**
 * A request was refused before any Box work started: policy, quota,
 * concurrency, configuration, or route restriction.
 *
 * Auto-routed requests use this to fall back to the ordinary chat path. A
 * heuristic router will misfire, and a misfire must not cost the user their
 * answer — an explicit `/agent` still surfaces the refusal.
 */
export class BoxAdmissionError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = 'BoxAdmissionError';
  }
}

export function isBoxAdmissionError(error: unknown): error is BoxAdmissionError {
  return error instanceof Error && error.name === 'BoxAdmissionError';
}

type LaunchJob = (input: LaunchPiBoxJobInput) => Promise<LaunchedPiBoxJob>;
type SendMessage = (chatId: number, text: string) => Promise<unknown>;
type EditMessage = (chatId: number, messageId: number, text: string) => Promise<unknown>;
type DeleteBox = (boxId: string, apiKey: string, baseUrl?: string) => Promise<void>;
type SendDocument = (chatId: number, documentUrl: string, filename: string, caption: string) => Promise<void>;
type ResumeJob = typeof resumeApprovedPiBoxJob;

export interface BoxQuotaState {
  dailyStartsUsed: number;
  dailyStartsLimit: number;
  activeJobs: number;
  concurrencyLimit: number;
}

export interface QueuedBoxJob {
  job: BoxJob;
  quota: BoxQuotaState;
  provision: () => Promise<void>;
}

export interface BoxJobServiceDependencies {
  store?: BoxJobStore;
  launchJob?: LaunchJob;
  sendMessage?: SendMessage;
  editMessage?: EditMessage;
  deleteBox?: DeleteBox;
  now?: () => number;
  artifacts?: ArtifactGateway;
  sendDocument?: SendDocument;
  resumeJob?: ResumeJob;
}

export class BoxJobService {
  private readonly config: ReturnType<typeof getConfig>;
  private readonly store: BoxJobStore;
  private readonly launchJob: LaunchJob;
  private readonly sendMessage: SendMessage;
  private readonly editMessage: EditMessage;
  private readonly deleteBox: DeleteBox;
  private readonly now: () => number;
  private readonly artifacts: ArtifactGateway;
  private readonly sendDocument: SendDocument;
  private readonly resumeJob: ResumeJob;

  constructor(
    private readonly env: Env,
    private readonly redis: RedisClient,
    dependencies: BoxJobServiceDependencies = {},
  ) {
    this.config = getConfig(env);
    this.store = dependencies.store ?? new BoxJobStore(redis);
    this.launchJob = dependencies.launchJob ?? launchPiBoxJob;
    this.sendMessage = dependencies.sendMessage ?? (async () => undefined);
    this.editMessage = dependencies.editMessage ?? (async () => undefined);
    this.deleteBox = dependencies.deleteBox ?? (async (boxId, apiKey, baseUrl) => {
      await Box.delete({ boxIds: boxId, apiKey, baseUrl });
    });
    this.now = dependencies.now ?? Date.now;
    this.artifacts = dependencies.artifacts ?? new ArtifactGateway(env, redis, { jobs: this.store, now: this.now });
    this.sendDocument = dependencies.sendDocument ?? (async () => undefined);
    this.resumeJob = dependencies.resumeJob ?? resumeApprovedPiBoxJob;
  }

  async bindChat(chatId: number, sessionKey: string): Promise<void> {
    if (!sessionKey.startsWith('group:')) throw new Error('/box enable can only be used in a group.');
    await this.redis.set(BOUND_CHAT_KEY, String(chatId));
  }

  async getBoundChatId(): Promise<number | null> {
    const raw = await this.redis.get(BOUND_CHAT_KEY);
    if (!raw) return null;
    const chatId = Number(raw);
    return Number.isSafeInteger(chatId) ? chatId : null;
  }

  async canRunInChat(chatId: number): Promise<boolean> {
    return this.config.boxAgentEnabled && await this.getBoundChatId() === chatId;
  }

  async recoverTerminalSideEffects(): Promise<number> {
    const chatId = await this.getBoundChatId();
    if (chatId === null) return 0;
    let recovered = 0;
    for (const candidate of await this.store.listForChat(chatId, 50)) {
      let job = candidate;
      const expired = await this.store.expireApproval(job.id, this.now());
      if (expired) job = expired;
      if (job.status === 'awaiting_approval' && !job.approvalNoticeDeliveredAt) {
        await this.deliverApproval(job.id).catch(error => console.error('Box approval delivery recovery failed:', error));
        recovered += 1;
        continue;
      }
      if (!['succeeded', 'failed', 'canceled', 'timed_out'].includes(job.status)) continue;
      if (!job.completionDeliveredAt) await this.deliverTerminal(job.id).catch(error => console.error('Box delivery recovery failed:', error));
      if (!job.cleanupCompletedAt) await this.cleanup(job);
      recovered += 1;
    }
    return recovered;
  }

  async queue(input: {
    chatId: number;
    sessionKey: string;
    userId: string;
    request: string;
    requestedRoute?: string;
    files?: PromptFiles;
  }): Promise<QueuedBoxJob> {
    if (!this.config.boxAgentEnabled) {
      throw new BoxAdmissionError('Box agent execution is disabled. Set BOX_AGENT_ENABLED=true after deployment checks pass.');
    }
    this.requireRuntimeConfiguration();
    const boundChatId = await this.getBoundChatId();
    if (boundChatId === null) throw new BoxAdmissionError('Box is not bound to a Telegram group. The owner must run /box enable there first.');
    if (input.chatId !== boundChatId || !input.sessionKey.startsWith('group:')) {
      throw new BoxAdmissionError('Box agent jobs can only be started from the bound Telegram group.');
    }
    if (!this.config.boxAllowGroupMembers && input.userId !== this.config.ownerUserId) {
      throw new BoxAdmissionError('Box jobs are owner-only. Set BOX_ALLOW_GROUP_MEMBERS=true only when every group member is trusted.');
    }

    const route = resolvePiModelRoute({
      requestedRoute: input.requestedRoute,
      actorUserId: input.userId,
      ownerUserId: this.config.ownerUserId,
      deepseekApiKey: this.config.deepseekApiKey,
      zaiCodingPlanApiKey: this.config.zaiCodingPlanApiKey,
      deepseekRateCard: {
        inputUsdPerMTokens: this.config.boxDeepseekInputUsdPerMTokens,
        cachedInputUsdPerMTokens: this.config.boxDeepseekCachedInputUsdPerMTokens,
        outputUsdPerMTokens: this.config.boxDeepseekOutputUsdPerMTokens,
      },
    });
    if (route.route === 'glm' && !isGlmCodingTask(input.request)) {
      throw new BoxAdmissionError('The GLM Coding Plan route is restricted to owner coding-agent tasks. Use DeepSeek for general work.');
    }
    const callbackNonce = crypto.randomUUID();
    const artifactSessionToken = crypto.randomUUID().replace(/-/g, '');
    const approvalNonce = crypto.randomUUID().replace(/-/g, '');
    const now = this.now();
    const admitted = await this.redis.withLock(`box-admission:${input.chatId}`, async () => {
      const active = (await this.store.listForChat(input.chatId, 50))
        .filter(candidate => ACTIVE_STATUSES.has(candidate.status));
      if (active.length >= MAX_GROUP_CONCURRENCY) {
        throw new BoxAdmissionError(
          `The bound group already has ${MAX_GROUP_CONCURRENCY} active Box jobs. `
          + `Wait for one to finish, or cancel one with /agent cancel <job-id>.`,
        );
      }
      const quotaKey = this.quotaKey(input.userId, now);
      const used = Number.parseInt(await this.redis.get(quotaKey) ?? '0', 10) || 0;
      if (used >= MAX_DAILY_USER_STARTS) {
        throw new BoxAdmissionError(
          `You have reached the daily limit of ${MAX_DAILY_USER_STARTS} Box jobs. `
          + `It resets at midnight ${this.config.defaultTimezone}.`,
        );
      }
      const created = await this.store.create({
        chatId: input.chatId,
        userId: input.userId,
        sessionKey: input.sessionKey,
        request: input.request,
        route: route.route,
        model: route.model,
        callbackNonce,
        artifactSessionToken,
        approvalNonce,
        now,
      });
      await this.redis.set(quotaKey, String(used + 1), this.secondsUntilLocalMidnight(now));
      return {
        job: created,
        quota: {
          dailyStartsUsed: used + 1,
          dailyStartsLimit: MAX_DAILY_USER_STARTS,
          activeJobs: active.length + 1,
          concurrencyLimit: MAX_GROUP_CONCURRENCY,
        },
      };
    });

    const { job, quota } = admitted;
    return {
      job,
      quota,
      provision: async () => {
        await this.provision(job, callbackNonce, artifactSessionToken, approvalNonce, route, input.files);
      },
    };
  }

  /** Binds live progress updates to the message that acknowledged the job. */
  async attachProgressMessage(jobId: string, messageId: number, header: string): Promise<void> {
    await this.store.setProgressMessage(jobId, { messageId, header });
  }

  /** Remaining daily starts and group concurrency headroom, for status views. */
  async getQuotaState(chatId: number, userId: string): Promise<BoxQuotaState> {
    const now = this.now();
    const [activeJobs, usedRaw] = await Promise.all([
      this.store.listForChat(chatId, 50).then(jobs => jobs.filter(job => ACTIVE_STATUSES.has(job.status)).length),
      this.redis.get(this.quotaKey(userId, now)),
    ]);
    return {
      dailyStartsUsed: Number.parseInt(usedRaw ?? '0', 10) || 0,
      dailyStartsLimit: MAX_DAILY_USER_STARTS,
      activeJobs,
      concurrencyLimit: MAX_GROUP_CONCURRENCY,
    };
  }

  async getStatus(
    chatId: number,
    userId: string,
    owner: boolean,
    jobId?: string,
  ): Promise<BoxJob | BoxJob[]> {
    if (jobId) {
      const job = await this.store.get(jobId);
      if (!job || job.chatId !== chatId) throw new Error('Box job not found in this chat.');
      if (!owner && job.userId !== userId) throw new Error('You can only inspect your own Box jobs.');
      return job;
    }
    const jobs = await this.store.listForChat(chatId, 10);
    return owner ? jobs : jobs.filter(job => job.userId === userId);
  }

  async cancel(chatId: number, userId: string, owner: boolean, jobId: string): Promise<BoxJob> {
    const existing = await this.store.get(jobId);
    if (!existing || existing.chatId !== chatId) throw new Error('Box job not found in this chat.');
    if (!owner && existing.userId !== userId) throw new Error('You can only cancel your own Box jobs.');
    const canceled = await this.store.cancel(existing.id);
    if (!canceled) throw new Error(`Box job ${existing.id} is already ${existing.status}.`);
    if (canceled.boxId) await this.cleanup(canceled);
    return canceled;
  }

  async approve(chatId: number, ownerUserId: string, jobId: string, nonce: string): Promise<BoxJob> {
    if (!this.config.ownerUserId || ownerUserId !== this.config.ownerUserId) throw new Error('Only the bot owner can approve Box actions.');
    const existing = await this.store.get(jobId);
    if (!existing || existing.chatId !== chatId || !existing.boxId || !existing.pendingApproval) {
      throw new Error('Box approval request not found in this chat.');
    }
    const callbackNonce = crypto.randomUUID().replace(/-/g, '');
    const approvalNonce = crypto.randomUUID().replace(/-/g, '');
    const webhook = await createBoxCallbackAuthorization({
      url: this.config.boxCallbackUrl!, secret: this.config.boxCallbackSecret!, jobId: existing.id,
      nonce: callbackNonce, now: this.now(),
    });
    const resumed = await this.store.prepareApprovalResume({
      id: existing.id, nonce, nextCallbackNonce: callbackNonce, nextApprovalNonce: approvalNonce, now: this.now(),
    });
    try {
      const runId = await this.resumeJob({
        boxId: existing.boxId,
        boxApiKey: this.config.upstashBoxApiKey!,
        boxBaseUrl: this.config.upstashBoxBaseUrl,
        approvalNonce,
        grant: { nonce, actionHash: existing.pendingApproval.actionHash, expiresAt: this.now() + 10 * 60_000 },
        webhook: { url: webhook.url, headers: webhook.headers },
      });
      return await this.store.markRunning(resumed.id, existing.boxId, runId, this.now());
    } catch (error) {
      return await this.store.markFailed(existing.id, safeError(error, 'Failed to resume approved Box job.'), this.now());
    }
  }

  /**
   * Live progress from a running Box.
   *
   * A Box job can run for many minutes with nothing between "queued" and the
   * final result, which is indistinguishable from the bot having dropped the
   * request. The Box authenticates with its own job-scoped session token — the
   * same authority it already holds for artifact uploads — and the Worker
   * decides whether the update is frequent enough to be worth an edit.
   *
   * Failure here is never fatal: progress is cosmetic, and a job must not fail
   * because a status line could not be delivered.
   */
  async handleProgress(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const jobId = request.headers.get('X-Box-Job-Id')?.trim().toLowerCase() ?? '';
    const sessionToken = bearer(request.headers);
    if (!jobId || !sessionToken) return json({ error: 'Missing progress credentials.' }, 401);

    let job: BoxJob | null;
    try {
      job = await this.store.verifyArtifactSession(jobId, sessionToken);
    } catch {
      return json({ error: 'Invalid progress credentials.' }, 401);
    }
    if (!job) return json({ error: 'Invalid progress credentials.' }, 401);

    let text: string;
    try {
      const body = await request.json() as { step?: unknown };
      if (typeof body.step !== 'string' || !body.step.trim()) throw new Error('Progress step is required.');
      text = body.step;
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid progress payload.' }, 400);
    }

    const updated = await this.store.recordProgress(jobId, text, this.now());
    if (!updated) return json({ ok: true, throttled: true });
    await this.publishProgress(updated).catch(error => {
      console.error(`Box progress delivery failed for ${jobId}:`, error);
    });
    return json({ ok: true });
  }

  private async publishProgress(job: BoxJob): Promise<void> {
    if (!job.progressMessageId || !job.progressText) return;
    const header = job.progressHeader ?? `Box job ${job.id} (${job.route}, ${job.model}).`;
    await this.editMessage(
      job.chatId,
      job.progressMessageId,
      `${header}\n\nWorking: ${job.progressText}`,
    );
  }

  async handleCompletion(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const jobId = request.headers.get('X-Box-Job-Id')?.trim().toLowerCase() ?? '';
    if (!jobId) return json({ error: 'Missing Box job ID.' }, 400);
    if (!this.config.boxCallbackSecret) return json({ error: 'Callback authentication is not configured.' }, 503);
    const authorization = await verifyBoxCallbackAuthorization({
      headers: request.headers,
      secret: this.config.boxCallbackSecret,
      expectedJobId: jobId,
      now: this.now(),
    });
    if (!authorization.valid) return json({ error: 'Unauthorized Box callback.' }, 401);

    const knownJob = await this.store.get(jobId);
    if (!knownJob) return json({ error: 'Box job not found.' }, 404);
    let payload: WebhookPayload;
    try {
      payload = validateWebhookPayload(await request.json());
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid callback payload.' }, 400);
    }

    try {
      const completion = await this.store.applyCompletion({
        jobId,
        nonce: authorization.nonce,
        payload,
        now: this.now(),
      });
      if (completion.job.status === 'awaiting_approval') {
        await this.deliverApproval(completion.job.id);
        return json({ ok: true, awaitingApproval: true });
      }
      if (!completion.late) await this.deliverTerminal(jobId);
      const artifacts = completion.late ? [] : await this.deliverArtifacts(completion.job);
      const durableJob = artifacts.length > 0
        ? await this.store.setArtifactIds(jobId, artifacts.map(artifact => artifact.id), this.now())
        : completion.job;
      await this.cleanup(durableJob);
      return json({ ok: true, duplicate: completion.duplicate, late: completion.late });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Callback rejected.' }, 409);
    }
  }

  private async provision(
    job: BoxJob,
    callbackNonce: string,
    artifactSessionToken: string,
    approvalNonce: string,
    route: ReturnType<typeof resolvePiModelRoute>,
    files?: PromptFiles,
  ): Promise<void> {
    const actionBroker = new ActionBroker(this.env, this.redis, { jobs: this.store, now: this.now });
    try {
      await this.store.markProvisioning(job.id, this.now());
      const webhook = await createBoxCallbackAuthorization({
        url: this.config.boxCallbackUrl!,
        secret: this.config.boxCallbackSecret!,
        jobId: job.id,
        nonce: callbackNonce,
        now: this.now(),
      });
      const launched = await this.launchJob({
        jobId: job.id,
        prompt: job.request,
        boxApiKey: this.config.upstashBoxApiKey!,
        boxBaseUrl: this.config.upstashBoxBaseUrl,
        snapshotId: this.config.boxSnapshotId,
        route,
        approvalNonce,
        sessionId: job.id,
        files,
        webhook: { url: webhook.url, headers: webhook.headers },
        artifactSession: this.env.ARTIFACT_BUCKET ? {
          authorizeUrl: `${new URL(this.config.boxCallbackUrl!).origin}/box/artifacts/authorize`,
          token: artifactSessionToken,
        } : undefined,
        progressSession: {
          url: `${new URL(this.config.boxCallbackUrl!).origin}/box/progress`,
          token: artifactSessionToken,
        },
        actionSession: actionBroker.isEnabled() && actionBroker.availableActions().length > 0
          ? {
              requestUrl: `${new URL(this.config.boxCallbackUrl!).origin}/box/actions/request`,
              resultUrl: `${new URL(this.config.boxCallbackUrl!).origin}/box/actions/result`,
              token: artifactSessionToken,
              availableActions: actionBroker.availableActions(),
            }
          : undefined,
      });
      const running = await this.store.markRunning(job.id, launched.boxId, launched.runId, this.now());
      if (!ACTIVE_STATUSES.has(running.status)) await this.cleanup(running);
    } catch (error) {
      const message = safeError(error, 'Box provisioning failed.');
      await this.store.markFailed(job.id, message, this.now());
      await this.deliverTerminal(job.id);
    }
  }

  private async deliverTerminal(jobId: string): Promise<void> {
    const claim = await this.store.claimCompletionDelivery(jobId, this.now());
    if (!claim) return;
    try {
      await this.sendMessage(claim.job.chatId, formatTerminalMessage(claim.job));
      await this.store.markCompletionDelivered(jobId, claim.leaseId, this.now());
    } catch (error) {
      await this.store.releaseCompletionDelivery(jobId, claim.leaseId, this.now());
      throw error;
    }
  }

  private async deliverApproval(jobId: string): Promise<void> {
    const claim = await this.store.claimApprovalDelivery(jobId, this.now());
    if (!claim) return;
    try {
      await this.sendMessage(
        claim.job.chatId,
        formatApprovalMessage(claim.job, claim.job.pendingApproval?.nonce),
      );
      await this.store.markApprovalDelivered(jobId, claim.leaseId, this.now());
    } catch (error) {
      await this.store.releaseApprovalDelivery(jobId, claim.leaseId, this.now());
      throw error;
    }
  }

  private async deliverArtifacts(job: BoxJob) {
    const uploaded = (await this.artifacts.store.listForJob(job.id, 10))
      .filter(artifact => artifact.status === 'uploaded');
    for (const artifact of uploaded) {
      const claim = await this.artifacts.store.claimTelegramDelivery(artifact.id, this.now());
      if (!claim) continue;
      try {
        const url = await this.artifacts.createDownloadUrl(claim.artifact);
        const size = claim.artifact.actualSize ?? claim.artifact.declaredSize;
        if (size <= TELEGRAM_DOCUMENT_LIMIT_BYTES) {
          await this.sendDocument(
            job.chatId,
            url,
            claim.artifact.filename,
            `Artifact ${claim.artifact.id}\nDownload link (24 hours): ${url}`,
          );
        } else {
          await this.sendMessage(
            job.chatId,
            `Artifact ${claim.artifact.id}: ${claim.artifact.filename} (${formatBytes(size)})\nDownload link (24 hours): ${url}`,
          );
        }
        await this.artifacts.store.markTelegramDelivered(artifact.id, claim.leaseId, this.now());
      } catch (error) {
        await this.artifacts.store.releaseTelegramDelivery(artifact.id, claim.leaseId);
        throw error;
      }
    }
    return uploaded;
  }

  private async cleanup(job: BoxJob): Promise<void> {
    if (!job.boxId || job.cleanupCompletedAt || !this.config.upstashBoxApiKey) return;
    try {
      await this.deleteBox(job.boxId, this.config.upstashBoxApiKey, this.config.upstashBoxBaseUrl);
      await this.store.markCleanupCompleted(job.id, this.now());
    } catch (error) {
      console.error(`Failed to clean up Box for job ${job.id}:`, safeError(error, 'Unknown cleanup error.'));
    }
  }

  private requireRuntimeConfiguration(): void {
    if (!this.config.upstashBoxApiKey) throw new Error('UPSTASH_BOX_API_KEY is not configured.');
    if (!this.config.boxCallbackUrl) throw new Error('BOX_CALLBACK_URL is not configured.');
    if (!this.config.boxCallbackSecret || this.config.boxCallbackSecret.length < 32) {
      throw new Error('BOX_CALLBACK_SECRET must be at least 32 characters.');
    }
  }

  private quotaKey(userId: string, now: number): string {
    return `box_quota:v1:user:${userId}:${localDayKey(this.config.defaultTimezone, now)}`;
  }

  private secondsUntilLocalMidnight(now: number): number {
    return secondsUntilLocalMidnight(this.config.defaultTimezone, now);
  }
}

function validateWebhookPayload(value: unknown): WebhookPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid callback payload.');
  const payload = value as Record<string, unknown>;
  if (typeof payload.box_id !== 'string' || !payload.box_id.trim()) throw new Error('Callback box_id is required.');
  if (payload.status !== 'completed' && payload.status !== 'failed') throw new Error('Invalid callback status.');
  if (payload.run_id !== undefined && typeof payload.run_id !== 'string') throw new Error('Invalid callback run_id.');
  if (payload.output !== undefined && typeof payload.output !== 'string') throw new Error('Invalid callback output.');
  if (payload.error !== undefined && typeof payload.error !== 'string') throw new Error('Invalid callback error.');
  return payload as unknown as WebhookPayload;
}

function formatTerminalMessage(job: BoxJob): string {
  const heading = `Box job ${job.id}: ${job.status}`;
  const body = job.status === 'succeeded' ? job.result : job.error || job.terminalReason;
  const cost = job.cost ? `\nCost: $${job.cost.totalUsd.toFixed(4)}` : '';
  return `${heading}${body ? `\n\n${body}` : ''}${cost}`.slice(0, 40_000);
}

function formatApprovalMessage(job: BoxJob, nonce?: string): string {
  const pending = job.pendingApproval;
  if (!pending) return `Box job ${job.id} is awaiting owner approval.`;
  return `Box job ${job.id} paused for owner approval.\nCategory: ${pending.category}\nAction: ${pending.action.slice(0, 1200)}\n\nApprove within 15 minutes with:\n/agent approve ${job.id} ${nonce ?? '<nonce unavailable>'}`;
}

function safeError(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).trim().slice(0, 4_000) || fallback;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function bearer(headers: Headers): string {
  const value = headers.get('Authorization') ?? '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
