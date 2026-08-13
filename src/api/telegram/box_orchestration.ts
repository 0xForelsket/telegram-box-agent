import { BoxJobService } from "../../agent/box/box_job_service";
import type { BoxJob } from "../../agent/box/box_job_store";
import { ArtifactGateway } from "../../agent/box/artifact_gateway";
import { BoxScheduleService } from "../../agent/box/box_schedule_service";
import type { PromptFiles } from "@upstash/box";

import TelegramSchedulingBot from "./scheduling";

export abstract class TelegramBoxOrchestrationBot extends TelegramSchedulingBot {
  protected boxJobs(): BoxJobService {
    return new BoxJobService(this.env, this.redis, {
      sendMessage: async (chatId, text) =>
        await this.sendMessageWithFallback(chatId, text),
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
  ): Promise<void> {
    const queued = await this.boxJobs().queue({
      chatId,
      sessionKey,
      userId,
      request,
      requestedRoute,
      files,
    });
    await this.sendMessageWithFallback(
      chatId,
      `Queued Box job ${queued.job.id} (${queued.job.route}, ${queued.job.model}).\nUse /agent status ${queued.job.id} or /agent cancel ${queued.job.id}.`,
    );
    this.runBackground(`provisionBoxJob:${queued.job.id}`, queued.provision);
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
    const result = await this.boxJobs().getStatus(
      chatId,
      userId,
      this.isOwner(userId),
      jobId,
    );
    const jobs = Array.isArray(result) ? result : [result];
    if (jobs.length === 0) return "No Box jobs found in this chat.";
    return jobs.map((job) => this.formatBoxJobStatus(job)).join("\n\n");
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

export default TelegramBoxOrchestrationBot;
