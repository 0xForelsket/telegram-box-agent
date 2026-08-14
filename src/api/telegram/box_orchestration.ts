import { BoxJobService, type QueuedBoxJob } from "../../agent/box/box_job_service";
import type { BoxJob } from "../../agent/box/box_job_store";
import type { BoxRouteDecision } from "../../agent/box/hybrid_router";
import { ArtifactGateway } from "../../agent/box/artifact_gateway";
import { ActionBroker } from "../../agent/box/action_broker";
import { BoxScheduleService } from "../../agent/box/box_schedule_service";
import type { PromptFiles } from "@upstash/box";

import TelegramSchedulingBot from "./scheduling";

export abstract class TelegramBoxOrchestrationBot extends TelegramSchedulingBot {
  protected boxJobs(): BoxJobService {
    return new BoxJobService(this.env, this.redis, {
      sendMessage: async (chatId, text) =>
        await this.sendMessageWithFallback(chatId, text),
      editMessage: async (chatId, messageId, text) => {
        await this.replaceProgressMessage(chatId, messageId, text);
      },
      sendDocument: async (chatId, documentUrl, filename, caption) => {
        await this.transport.sendDocument(
          chatId,
          documentUrl,
          filename,
          caption,
        );
      },
    });
  }

  protected artifactGateway(): ArtifactGateway {
    return new ArtifactGateway(this.env, this.redis);
  }

  protected boxSchedules(): BoxScheduleService {
    return new BoxScheduleService(
      this.env,
      this.redis,
      async (chatId, text) => await this.sendMessageWithFallback(chatId, text),
    );
  }

  async handleBoxCompletion(request: Request): Promise<Response> {
    return await this.boxJobs().handleCompletion(request);
  }

  async handleBoxScheduleCompletion(request: Request): Promise<Response> {
    return await this.boxSchedules().handleCallback(request);
  }

  async handleBoxProgress(request: Request): Promise<Response> {
    return await this.boxJobs().handleProgress(request);
  }

  protected actionBroker(): ActionBroker {
    return new ActionBroker(this.env, this.redis, {
      sendMessage: async (chatId, text) =>
        await this.sendMessageWithFallback(chatId, text),
    });
  }

  async handleBoxActionRequest(request: Request): Promise<Response> {
    return await this.actionBroker().handleRequest(request);
  }

  async handleBoxActionResult(request: Request): Promise<Response> {
    return await this.actionBroker().handleResult(request);
  }

  async approveBrokeredAction(
    chatId: number,
    userId: string,
    actionId: string,
    nonce: string,
  ): Promise<string> {
    const record = await this.actionBroker().approve({
      chatId,
      ownerUserId: userId,
      actionId,
      nonce,
    });
    return record.status === "executed"
      ? `Action ${record.id} executed.\n${record.result ?? ""}`.trim()
      : `Action ${record.id} ${record.status}.\n${record.error ?? ""}`.trim();
  }

  async denyBrokeredAction(
    chatId: number,
    userId: string,
    actionId: string,
  ): Promise<string> {
    const record = await this.actionBroker().deny({
      chatId,
      ownerUserId: userId,
      actionId,
    });
    return `Action ${record.id} denied. The Box was told the request was refused.`;
  }

  async listBrokeredActions(chatId: number, userId: string): Promise<string> {
    if (!this.isOwner(userId)) {
      throw new Error("Only the bot owner can inspect brokered actions.");
    }
    const broker = this.actionBroker();
    if (!broker.isEnabled()) {
      return "The action broker is disabled. Set ACTION_BROKER_ENABLED=true to allow brokered external writes.";
    }
    const records = await broker.listForChat(chatId);
    const available = broker.availableActions();
    const header = available.length
      ? `Available actions: ${available.join(", ")}`
      : "No actions are available; no action credential is configured.";
    if (records.length === 0) return `${header}\n\nNo action requests in this chat.`;
    return [
      header,
      "",
      ...records.map(
        (record) =>
          `${record.id}: ${record.status}\n${record.action} · job ${record.jobId}\n${record.description.slice(0, 300)}`,
      ),
    ].join("\n\n");
  }

  async handleBoxArtifactAuthorization(request: Request): Promise<Response> {
    return await this.artifactGateway().authorizeUpload(request);
  }

  async handleBoxArtifactUpload(
    request: Request,
    artifactId: string,
  ): Promise<Response> {
    return await this.artifactGateway().upload(request, artifactId);
  }

  async handleArtifactDownload(
    request: Request,
    artifactId: string,
  ): Promise<Response> {
    return await this.artifactGateway().download(request, artifactId);
  }

  async enableBoxForChat(chatId: number, sessionKey: string): Promise<void> {
    await this.boxJobs().bindChat(chatId, sessionKey);
  }

  async startBoxAgentJob(
    chatId: number,
    sessionKey: string,
    userId: string,
    request: string,
    requestedRoute?: string,
    files?: PromptFiles,
    routeDecision?: BoxRouteDecision,
  ): Promise<void> {
    const service = this.boxJobs();
    const queued = await service.queue({
      chatId,
      sessionKey,
      userId,
      request,
      requestedRoute,
      files,
    });
    const header = this.formatBoxJobAcceptance(queued, routeDecision);
    const sent = await this.sendMessageWithFallback(chatId, header);
    // Live progress edits this message rather than sending new ones. A split
    // message has no single anchor, so progress falls back to silence there.
    const messageId = sent.length === 1 ? sent[0]?.message_id : undefined;
    if (typeof messageId === "number") {
      this.runBackground(`boxProgressAnchor:${queued.job.id}`, () =>
        service.attachProgressMessage(queued.job.id, messageId, header),
      );
    }
    this.runBackground(`provisionBoxJob:${queued.job.id}`, queued.provision);
  }

  /**
   * The acceptance message is the only place a user learns why their message
   * became a Box job and how much headroom they have left. Without the routing
   * line an auto-routed request looks like the bot ignoring them; without the
   * quota line the daily limit is only ever discovered by hitting it.
   */
  protected formatBoxJobAcceptance(
    queued: QueuedBoxJob,
    routeDecision?: BoxRouteDecision,
  ): string {
    const { job, quota } = queued;
    const lines = [
      `Queued Box job ${job.id} (${job.route}, ${job.model}).`,
    ];
    if (routeDecision?.reason) {
      lines.push(
        `Routed to the agent because ${routeDecision.reason}. Use /quick to answer in chat instead.`,
      );
    }
    lines.push(
      `Daily starts: ${quota.dailyStartsUsed}/${quota.dailyStartsLimit} · active jobs: ${quota.activeJobs}/${quota.concurrencyLimit}`,
    );
    lines.push(`Use /agent status ${job.id} or /agent cancel ${job.id}.`);
    return lines.join("\n");
  }

  async runQuickChat(
    chatId: number,
    sessionKey: string,
    _userId: string,
    request: string,
  ): Promise<void> {
    const promptState = await this.loadPromptState(sessionKey);
    this.modelAPI = await this.getModelAPIForModel(promptState.currentModel);
    const response = await this.generateChatResponse(
      this.buildChatMessages({
        promptState,
        promptText: request,
        replyContext: null,
        includeCurrentDateTime: this.shouldIncludeCurrentDateTime(request),
      }),
      promptState.currentModel,
      sessionKey,
      chatId,
    );
    await this.rememberConversation(
      sessionKey,
      request,
      response,
      promptState.currentModel,
    );
    await this.sendMessageWithFallback(chatId, response);
  }

  async getBoxAgentStatus(
    chatId: number,
    userId: string,
    jobId?: string,
  ): Promise<string> {
    const service = this.boxJobs();
    const [result, quota] = await Promise.all([
      service.getStatus(chatId, userId, this.isOwner(userId), jobId),
      service.getQuotaState(chatId, userId),
    ]);
    const jobs = Array.isArray(result) ? result : [result];
    const footer =
      `Daily starts: ${quota.dailyStartsUsed}/${quota.dailyStartsLimit} · ` +
      `active jobs: ${quota.activeJobs}/${quota.concurrencyLimit}`;
    if (jobs.length === 0) return `No Box jobs found in this chat.\n${footer}`;
    return `${jobs.map((job) => this.formatBoxJobStatus(job)).join("\n\n")}\n\n${footer}`;
  }

  async cancelBoxAgentJob(
    chatId: number,
    userId: string,
    jobId: string,
  ): Promise<string> {
    const job = await this.boxJobs().cancel(
      chatId,
      userId,
      this.isOwner(userId),
      jobId,
    );
    return `Canceled Box job ${job.id}.`;
  }

  async approveBoxAgentJob(
    chatId: number,
    userId: string,
    jobId: string,
    nonce: string,
  ): Promise<string> {
    if (!this.isOwner(userId))
      throw new Error("Only the bot owner can approve Box actions.");
    const job = await this.boxJobs().approve(chatId, userId, jobId, nonce);
    return `Approved Box job ${job.id}; the protected action is resuming.`;
  }

  async createBoxAgentSchedule(
    chatId: number,
    userId: string,
    cron: string,
    prompt: string,
    requestedRoute?: string,
  ): Promise<string> {
    const record = await this.boxSchedules().create({
      chatId,
      ownerUserId: userId,
      cron,
      prompt,
      requestedRoute,
    });
    return `Created Box schedule ${record.id}: ${record.cron} UTC (${record.route}, ${record.status}).`;
  }

  async listBoxAgentSchedules(chatId: number, userId: string): Promise<string> {
    const records = await this.boxSchedules().list(chatId, userId);
    if (records.length === 0) return "No Box schedules found in this chat.";
    return records
      .map(
        (record) =>
          `${record.id}: ${record.status}\n${record.cron} UTC · ${record.route}\n${record.prompt.slice(0, 300)}\nRuns: ${record.totalRuns}, failures: ${record.totalFailures}`,
      )
      .join("\n\n");
  }

  async changeBoxAgentSchedule(
    chatId: number,
    userId: string,
    id: string,
    action: "pause" | "resume" | "delete",
  ): Promise<string> {
    const record = await this.boxSchedules().change(chatId, userId, id, action);
    return `Box schedule ${record.id}: ${record.status}.`;
  }

  async listArtifacts(chatId: number, userId: string): Promise<string> {
    const entries = await this.artifactGateway().listForUser({
      chatId,
      userId,
      owner: this.isOwner(userId),
    });
    if (entries.length === 0) {
      return "No stored artifacts in this chat.";
    }
    const rows = entries.map(({ artifact, retentionDaysLeft }) => {
      const size = artifact.actualSize ?? artifact.declaredSize;
      const retention =
        retentionDaysLeft > 0
          ? `${retentionDaysLeft}d left`
          : "expiring now";
      return `${artifact.id}  ${artifact.filename}\n  ${formatArtifactBytes(size)} · ${retention} · job ${artifact.jobId}`;
    });
    return [
      `Stored artifacts (${entries.length}):`,
      ...rows,
      "",
      "Use /artifact <artifact-id> for a fresh 24-hour download link.",
    ].join("\n");
  }

  async getArtifactLink(
    chatId: number,
    userId: string,
    artifactId: string,
  ): Promise<string> {
    const result = await this.artifactGateway().getDownloadForUser({
      artifactId,
      chatId,
      userId,
      owner: this.isOwner(userId),
    });
    return `${result.artifact.filename}\nDownload link (24 hours): ${result.url}`;
  }

  protected formatBoxJobStatus(job: BoxJob): string {
    const cost = job.cost ? `\nCost: $${job.cost.totalUsd.toFixed(4)}` : "";
    const detail =
      job.status === "succeeded" ? job.result : job.error || job.terminalReason;
    return `${job.id}: ${job.status}\nRoute: ${job.route} (${job.model})${detail ? `\n${detail.replace(/\s+/g, " ").slice(0, 400)}` : ""}${cost}`;
  }
}

function formatArtifactBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default TelegramBoxOrchestrationBot;
