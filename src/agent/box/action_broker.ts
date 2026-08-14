import { getConfig, type Env } from '../../env';
import type { RedisClient } from '../../utils/redis';
import { UserFacingError } from '../../utils/user_facing_error';
import {
  ACTION_CATALOG,
  describeAction,
  hashAction,
  parseActionRequest,
  type ActionRequest,
} from './action_catalog';
import { ActionStore, type BrokeredAction } from './action_store';
import { BoxJobStore } from './box_job_store';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'provisioning', 'running', 'awaiting_approval']);
const MAX_PENDING_PER_JOB = 3;

type SendMessage = (chatId: number, text: string) => Promise<unknown>;

export interface ActionBrokerDependencies {
  store?: ActionStore;
  jobs?: BoxJobStore;
  sendMessage?: SendMessage;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Executes allowlisted external writes on behalf of a Box job, after the owner
 * approves the exact operation.
 *
 * The credential never leaves the Worker, and the executor reads its parameters
 * from the stored record rather than from anything the Box sends at execution
 * time. A Box that is fully compromised can request an action and can decline
 * to request one; it cannot widen, alter, or repeat what the owner approved.
 */
export class ActionBroker {
  private readonly config: ReturnType<typeof getConfig>;
  private readonly store: ActionStore;
  private readonly jobs: BoxJobStore;
  private readonly sendMessage: SendMessage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly env: Env,
    redis: RedisClient,
    dependencies: ActionBrokerDependencies = {},
  ) {
    this.config = getConfig(env);
    this.store = dependencies.store ?? new ActionStore(redis);
    this.jobs = dependencies.jobs ?? new BoxJobStore(redis);
    this.sendMessage = dependencies.sendMessage ?? (async () => undefined);
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  isEnabled(): boolean {
    return this.config.actionBrokerEnabled;
  }

  /** Actions whose credential and scope are actually configured. */
  availableActions(): string[] {
    if (!this.isEnabled()) return [];
    return Object.entries(ACTION_CATALOG)
      .filter(([, definition]) => this.hasCredential(definition.credential))
      .map(([name]) => name);
  }

  /**
   * `POST /box/actions/request` — a Box asks for an external write.
   *
   * Nothing happens here except validation and an owner notification. The
   * request is not authority; the approval is.
   */
  async handleRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!this.isEnabled()) return json({ error: 'The action broker is disabled.' }, 503);

    const jobId = request.headers.get('X-Box-Job-Id')?.trim().toLowerCase() ?? '';
    const sessionToken = bearer(request.headers);
    if (!jobId || !sessionToken) return json({ error: 'Missing action credentials.' }, 401);

    let job;
    try {
      job = await this.jobs.verifyArtifactSession(jobId, sessionToken);
    } catch {
      return json({ error: 'Invalid action credentials.' }, 401);
    }
    if (!job) return json({ error: 'Invalid action credentials.' }, 401);
    if (!ACTIVE_JOB_STATUSES.has(job.status)) return json({ error: `Box job is ${job.status}.` }, 409);

    let parsed: ActionRequest;
    try {
      parsed = parseActionRequest(await request.json());
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid action request.' }, 400);
    }

    const definition = ACTION_CATALOG[parsed.action];
    if (!this.hasCredential(definition.credential)) {
      return json({ error: `The ${definition.credential} credential is not configured.` }, 503);
    }
    if (!this.isScopeAllowed(parsed)) {
      return json({ error: 'That target is not in the configured action allowlist.' }, 403);
    }

    const pending = (await this.store.listForChat(job.chatId, 20))
      .filter(record => record.jobId === jobId && record.status === 'pending');
    if (pending.length >= MAX_PENDING_PER_JOB) {
      return json({ error: 'This job already has the maximum number of pending actions.' }, 429);
    }

    const approvalNonce = crypto.randomUUID().replace(/-/g, '');
    const record = await this.store.create({
      jobId,
      chatId: job.chatId,
      userId: job.userId,
      action: parsed.action,
      params: parsed.params,
      actionHash: await hashAction(parsed),
      description: describeAction(parsed),
      approvalNonce,
      now: this.now(),
    });

    await this.sendMessage(job.chatId, formatApprovalRequest(record, approvalNonce)).catch(error => {
      console.error(`Failed to deliver action approval request ${record.id}:`, error);
    });

    return json({ actionId: record.id, status: record.status, expiresAt: record.expiresAt });
  }

  /**
   * `GET /box/actions/result?id=...` — the Box polls for the outcome.
   *
   * Returns status only. The Box learns whether the write happened, never how.
   */
  async handleResult(request: Request): Promise<Response> {
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    const jobId = request.headers.get('X-Box-Job-Id')?.trim().toLowerCase() ?? '';
    const sessionToken = bearer(request.headers);
    if (!jobId || !sessionToken) return json({ error: 'Missing action credentials.' }, 401);

    let job;
    try {
      job = await this.jobs.verifyArtifactSession(jobId, sessionToken);
    } catch {
      return json({ error: 'Invalid action credentials.' }, 401);
    }
    if (!job) return json({ error: 'Invalid action credentials.' }, 401);

    const actionId = new URL(request.url).searchParams.get('id')?.trim() ?? '';
    let record: BrokeredAction | null;
    try {
      record = await this.store.get(actionId);
    } catch {
      return json({ error: 'Invalid action ID.' }, 400);
    }
    // Scoped to the requesting job so one Box cannot read another's outcomes.
    if (!record || record.jobId !== jobId) return json({ error: 'Action not found.' }, 404);
    await this.store.expireIfElapsed(record.id, this.now());
    const current = (await this.store.get(record.id)) ?? record;

    return json({
      actionId: current.id,
      status: current.status,
      result: current.result,
      error: current.error,
    });
  }

  /**
   * Owner approval, followed immediately by server-side execution.
   *
   * Execution reads only the stored record, and the record was written before
   * the owner saw it, so what runs is exactly what was displayed.
   */
  async approve(input: {
    chatId: number;
    ownerUserId: string;
    actionId: string;
    nonce: string;
  }): Promise<BrokeredAction> {
    this.requireOwner(input.ownerUserId);
    const record = await this.store.get(input.actionId);
    if (!record || record.chatId !== input.chatId) {
      throw new UserFacingError('Action request not found in this chat.');
    }

    const approved = await this.store.approve({
      id: record.id,
      nonce: input.nonce,
      ownerUserId: input.ownerUserId,
      now: this.now(),
    });

    // Re-derive the fingerprint from the stored parameters. If the record were
    // ever altered between display and execution, this refuses to run it.
    const replayHash = await hashAction({ action: approved.action, params: approved.params });
    if (replayHash !== approved.actionHash) {
      return await this.store.markFailed(approved.id, 'Stored action no longer matches its approved fingerprint.', this.now());
    }

    try {
      const result = await this.execute(approved);
      return await this.store.markExecuted(approved.id, result, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action execution failed.';
      return await this.store.markFailed(approved.id, message, this.now());
    }
  }

  async deny(input: { chatId: number; ownerUserId: string; actionId: string }): Promise<BrokeredAction> {
    this.requireOwner(input.ownerUserId);
    const record = await this.store.get(input.actionId);
    if (!record || record.chatId !== input.chatId) {
      throw new UserFacingError('Action request not found in this chat.');
    }
    return await this.store.deny(record.id, this.now());
  }

  async listForChat(chatId: number, limit = 20): Promise<BrokeredAction[]> {
    return await this.store.listForChat(chatId, limit);
  }

  private async execute(record: BrokeredAction): Promise<string> {
    switch (record.action) {
      case 'github.issue_comment':
        return await this.githubRequest(
          `/repos/${record.params.owner}/${record.params.repo}/issues/${record.params.issue_number}/comments`,
          { body: String(record.params.body) },
        );
      case 'github.create_issue':
        return await this.githubRequest(
          `/repos/${record.params.owner}/${record.params.repo}/issues`,
          { title: String(record.params.title), body: String(record.params.body) },
        );
    }
  }

  private async githubRequest(path: string, body: Record<string, unknown>): Promise<string> {
    const token = this.config.githubToken;
    if (!token) throw new Error('GITHUB_TOKEN is not configured.');
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'telegram-box-agent',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub responded ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    try {
      const parsed = JSON.parse(text) as { html_url?: string };
      return parsed.html_url ?? 'Action completed.';
    } catch {
      return 'Action completed.';
    }
  }

  private hasCredential(credential: 'github'): boolean {
    return credential === 'github' && !!this.config.githubToken;
  }

  /**
   * Repository allowlist. Empty means no repository is permitted: an action
   * broker that defaults to "anywhere" would be a worse boundary than none,
   * because it would look like one.
   */
  private isScopeAllowed(request: ActionRequest): boolean {
    const target = `${request.params.owner}/${request.params.repo}`.toLowerCase();
    return this.config.actionBrokerGithubRepos.some(allowed => allowed.toLowerCase() === target);
  }

  private requireOwner(userId: string): void {
    if (!this.config.ownerUserId || userId !== this.config.ownerUserId) {
      throw new UserFacingError('Only the bot owner can approve or deny brokered actions.');
    }
  }
}

function formatApprovalRequest(record: BrokeredAction, nonce: string): string {
  const minutes = Math.max(1, Math.round((record.expiresAt - record.createdAt) / 60_000));
  return [
    `Box job ${record.jobId} is requesting an external write.`,
    '',
    record.description,
    '',
    `The Worker performs this itself using its own credential; the sandbox never sees it.`,
    `Approve within ${minutes} minutes:`,
    `/action approve ${record.id} ${nonce}`,
    `/action deny ${record.id}`,
  ].join('\n');
}

function bearer(headers: Headers): string {
  const value = headers.get('Authorization') ?? '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
