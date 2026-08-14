import { Env } from "../../env";
import { TelegramTypes } from "../../../types/telegram";
import {
  constantTimeEqual,
  fetchJson,
  sendChatAction,
} from "../../utils/helpers";
import { translate, translateMessage } from "../../utils/i18n";
import { commands } from "../../config/commands";
import ImageAnalysisAPI from "../image_analyze";
import OpenAICompatibleAPI from "../openai_compatible";
import { SharedScheduler } from "../../scheduling/scheduler";
import { AudioAPI } from "../audio";
import { TelegramStreamingReply } from "../../telegram/streaming_reply";
import { DashboardAccess } from "../../dashboard/dashboard";
import {
  classifyBoxRoute,
  type BoxRouteDecision,
} from "../../agent/box/hybrid_router";
import { isBoxAdmissionError } from "../../agent/box/box_job_service";
import { MODEL_CALLBACK_PREFIX } from "../../config/callback_data";
import { isUserFacingError } from "../../utils/user_facing_error";
import type { PromptFiles } from "@upstash/box";

import { type ImageCapableAPI } from "./types";

import { TelegramBotBase, uint8ToBase64 } from "./base";
import TelegramBoxOrchestrationBot from "./box_orchestration";

export abstract class TelegramMessageHandlingBot extends TelegramBoxOrchestrationBot {
  getEnv(): Env {
    return this.env;
  }

  async createDashboardLink(
    sessionKey: string,
    userId: string,
  ): Promise<{ url: string; expiresInMinutes: number }> {
    if (!this.isOwner(userId))
      throw new Error("Dashboard access is owner-only.");
    if (!this.config.dashboardBaseUrl)
      throw new Error("DASHBOARD_BASE_URL is not configured.");
    return await new DashboardAccess(
      this.redis,
      this.config.dashboardBaseUrl,
    ).createSession(sessionKey, userId);
  }

  async handleDashboardApi(request: Request): Promise<Response> {
    const access = new DashboardAccess(
      this.redis,
      this.config.dashboardBaseUrl || new URL(request.url).origin,
    );
    const session = await access.authenticate(request);
    if (!session || !this.isOwner(session.ownerUserId)) {
      return Response.json(
        { error: "Unauthorized or expired dashboard session." },
        {
          status: 401,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const today = new Date();
    const trendDates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - (6 - index));
      return date;
    });
    const [status, dailyReports, month, jobs] = await Promise.all([
      this.getStatus(session.sessionKey),
      Promise.all(
        trendDates.map((date) => this.usageTracker.getReport("day", date)),
      ),
      this.usageTracker.getReport("month"),
      new SharedScheduler(this.redis).list(session.sessionKey),
    ]);
    const day = dailyReports[dailyReports.length - 1];
    const cacheModels = this.config.openaiCompatibleModels.filter((model) =>
      /deepseek/i.test(model),
    );
    const [cacheReports, dailyCacheReports] = await Promise.all([
      Promise.all(
        cacheModels.map((model) =>
          this.usageTracker.getModelCacheReport("month", model),
        ),
      ),
      Promise.all(
        trendDates.map((date) =>
          Promise.all(
            cacheModels.map((model) =>
              this.usageTracker.getModelCacheReport("day", model, date),
            ),
          ),
        ),
      ),
    ]);
    const cacheHitTokens = cacheReports.reduce(
      (sum, report) => sum + report.cacheHitTokens,
      0,
    );
    const cacheMissTokens = cacheReports.reduce(
      (sum, report) => sum + report.cacheMissTokens,
      0,
    );
    const measuredCacheTokens = cacheHitTokens + cacheMissTokens;

    return Response.json(
      {
        generatedAt: new Date().toISOString(),
        status,
        usage: {
          day,
          month,
          trend: dailyReports.map((report) => ({
            date: report.period,
            calls: report.calls,
            errors: report.errors,
            totalTokens: report.totalTokens,
            searchCalls: report.searchCalls,
          })),
          dayAverageLatencyMs:
            day.calls > 0 ? Math.round(day.totalLatencyMs / day.calls) : 0,
          monthAverageLatencyMs:
            month.calls > 0
              ? Math.round(month.totalLatencyMs / month.calls)
              : 0,
        },
        cache: {
          hitTokens: cacheHitTokens,
          missTokens: cacheMissTokens,
          hitRate:
            measuredCacheTokens > 0
              ? `${((cacheHitTokens / measuredCacheTokens) * 100).toFixed(1)}%`
              : "n/a",
          trend: dailyCacheReports.map((reports, index) => {
            const hits = reports.reduce(
              (sum, report) => sum + report.cacheHitTokens,
              0,
            );
            const misses = reports.reduce(
              (sum, report) => sum + report.cacheMissTokens,
              0,
            );
            return {
              date: trendDates[index].toISOString().slice(0, 10),
              hitRate:
                hits + misses > 0
                  ? Number(((hits / (hits + misses)) * 100).toFixed(1))
                  : null,
            };
          }),
        },
        jobs: jobs.map((job) => ({
          id: job.id,
          type: job.type,
          nextAt: job.nextAt,
          recurrence: job.recurrence,
        })),
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  public async executeCommand(
    commandName: string,
    chatId: number,
    sessionKey: string,
    userId: string,
    args: string[],
  ): Promise<void> {
    const command = this.commands.find((cmd) => cmd.name === commandName);
    if (command) {
      await command.action(chatId, sessionKey, userId, this, args);
    } else {
      console.log(`Unknown command: ${commandName}`);
      await this.sendMessage(chatId, translate("command_not_found"));
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: { parse_mode?: "Markdown" | "HTML"; reply_markup?: string } = {},
  ): Promise<TelegramTypes.SendMessageResult[]> {
    return await this.transport.sendMessage(chatId, text, options);
  }

  async handleUpdate(update: TelegramTypes.Update): Promise<void> {
    this.runBackground("syncCommandsIfStale", () => this.syncCommandsIfStale());
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      const chatId = update.message.chat.id;
      const chatType = update.message.chat.type;
      const chatTitle =
        update.message.chat.title ||
        update.message.chat.username ||
        "Group Chat";
      this.reportChatMigration(update.message);
      const sender = update.message.from;
      const userId = sender?.id?.toString();
      if (!sender || !userId) {
        console.error("User ID is undefined");
        return;
      }
      const senderName = this.getDisplayName(sender);
      const sessionKey = this.getSessionKey(chatId, userId, chatType);

      if (!this.isAuthorized({ userId, chatId, chatType })) {
        await this.sendMessageWithFallback(chatId, translate("unauthorized"));
        return;
      }

      const botSettings = await this.getBotSettings(sessionKey);

      if (chatType !== "private") {
        this.runBackground("rememberSeenMember", () =>
          this.rememberSeenMember(sessionKey, update.message!.from!),
        );
      }

      if (update.message.voice) {
        if (
          chatType !== "private" &&
          !(await this.messageMentionsBot(
            update.message.caption || "",
            update.message.caption_entities,
          ))
        ) {
          return;
        }
        await this.handleVoiceTranscription(chatId, update.message.voice);
      } else if ("document" in update.message && update.message.document) {
        await this.handleBoxDocument(
          update.message,
          chatId,
          sessionKey,
          userId,
          chatType,
        );
      } else if (
        "photo" in update.message &&
        Array.isArray(update.message.photo) &&
        update.message.photo.length > 0
      ) {
        if (
          chatType !== "private" &&
          !(await this.messageMentionsBot(
            update.message.caption || "",
            update.message.caption_entities,
          ))
        ) {
          return;
        }
        await this.handleImageAnalysis(
          chatId,
          sessionKey,
          update.message as TelegramTypes.Message & {
            photo: TelegramTypes.PhotoSize[];
          },
        );
      } else if (update.message.text) {
        if (update.message.text.startsWith("/")) {
          const [rawCommandName, ...args] = update.message.text
            .slice(1)
            .split(" ");
          const commandTarget = rawCommandName.split("@")[1];
          const botUsername = await this.getBotUsername();
          if (
            commandTarget &&
            botUsername &&
            commandTarget.toLowerCase() !== botUsername.toLowerCase()
          ) {
            return;
          }
          const commandName = rawCommandName.split("@")[0];
          try {
            await this.executeCommand(
              commandName,
              chatId,
              sessionKey,
              userId,
              args,
            );
          } catch (error) {
            // Most command actions have no error handling of their own. Without
            // this the rejection reached `handleWebhook`, which only logs, so a
            // failing command produced complete silence in the chat.
            console.error(`Error in /${commandName}:`, error);
            this.runBackground("notifyCommandError", async () => {
              await this.sendMessageWithFallback(
                chatId,
                this.getUserFacingErrorMessage(error),
              );
            });
          }
        } else {
          try {
            const mentionsBot = await this.messageMentionsBot(
              update.message.text,
              update.message.entities,
            );
            if (chatType !== "private" && !mentionsBot) {
              if (botSettings.ambientMemory) {
                const ambientEntry = `[Group: ${chatTitle}] ${senderName}: ${update.message.text}`;
                this.runBackground("rememberAmbientMessage", () =>
                  this.rememberAmbientMessage(sessionKey, ambientEntry),
                );
              }
              return;
            }

            const cleanedText = await this.stripBotMention(update.message.text);
            const routeDecision = classifyBoxRoute(cleanedText);
            if (
              chatType !== "private" &&
              routeDecision.route &&
              (await this.boxJobs().canRunInChat(chatId))
            ) {
              // The router is a heuristic over free text and will misfire. An
              // auto-routed request that Box refuses falls through to the
              // ordinary chat path instead of costing the user their answer;
              // an explicit /agent still surfaces the refusal.
              const started = await this.tryStartAutoRoutedBoxJob(
                chatId,
                sessionKey,
                userId,
                cleanedText,
                routeDecision,
              );
              if (started) return;
            }
            const replyContext = this.formatReplyContext(
              update.message,
              chatTitle,
            );
            const promptText =
              chatType === "private"
                ? cleanedText
                : `[Group: ${chatTitle}]\n${senderName}: ${cleanedText}`;
            const shouldInjectCurrentDateTime =
              this.shouldIncludeCurrentDateTime(cleanedText);

            await sendChatAction(chatId, "typing", this.env);
            const promptState = await this.loadPromptState(
              sessionKey,
              botSettings,
            );
            this.modelAPI = await this.getModelAPIForModel(
              promptState.currentModel,
            );

            const lastReadContext = await this.getLastReadFollowUpContext(
              sessionKey,
              cleanedText,
            );
            const effectiveReplyContext =
              [replyContext, lastReadContext].filter(Boolean).join("\n\n") ||
              null;
            const messages = this.buildChatMessages({
              promptState,
              promptText,
              replyContext: effectiveReplyContext,
              includeCurrentDateTime: shouldInjectCurrentDateTime,
            });

            const streamingReply =
              chatType === "private"
                ? new TelegramStreamingReply(
                    this.transport,
                    chatId,
                    update.message!.message_id,
                    "message_thread_id" in update.message! &&
                    typeof update.message!.message_thread_id === "number"
                      ? update.message!.message_thread_id
                      : undefined,
                  )
                : null;
            const response = await this.generateChatResponse(
              messages,
              promptState.currentModel,
              sessionKey,
              chatId,
              (delta) => streamingReply?.append(delta) || Promise.resolve(),
            );

            await this.rememberConversation(
              sessionKey,
              promptText,
              response,
              promptState.currentModel,
            ).catch((error) => {
              console.error(
                "Failed to persist conversation before reply:",
                error,
              );
            });
            if (!(await streamingReply?.complete(response))) {
              await this.sendMessageWithFallback(chatId, response);
            }
          } catch (error) {
            console.error("Error in handleUpdate:", error);
            this.runBackground("notifyHandleUpdateError", async () => {
              await this.sendMessageWithFallback(
                chatId,
                this.getUserFacingErrorMessage(error),
              );
            });
          }
        }
      }
    }
  }

  /**
   * Starts a Box job that the router chose rather than the user.
   *
   * Returns false when Box declined the request, so the caller can answer on
   * the ordinary chat path. Only admission failures fall back: a genuine
   * provisioning fault is still an error worth reporting, because the user's
   * request was accepted and then failed.
   */
  protected async tryStartAutoRoutedBoxJob(
    chatId: number,
    sessionKey: string,
    userId: string,
    request: string,
    decision: BoxRouteDecision,
  ): Promise<boolean> {
    try {
      await this.startBoxAgentJob(
        chatId,
        sessionKey,
        userId,
        request,
        undefined,
        undefined,
        decision,
      );
      return true;
    } catch (error) {
      if (!isBoxAdmissionError(error)) throw error;
      console.log(
        `Auto-routed Box job declined (${decision.rule}); answering on the chat path:`,
        error.message,
      );
      return false;
    }
  }

  protected async handleCallbackQuery(
    query: TelegramTypes.CallbackQuery,
  ): Promise<void> {
    if (!query.message || !query.data) {
      console.log("Invalid callback query");
      return;
    }

    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const sessionKey = this.getSessionKey(
      chatId,
      userId,
      query.message.chat.type,
    );

    try {
      if (
        !this.isAuthorized({
          userId,
          chatId,
          chatType: query.message.chat.type,
        })
      ) {
        await this.sendMessageWithFallback(chatId, translate("unauthorized"));
        return;
      }

      console.log("Handling callback query:", query.data);

      if (query.data.startsWith(MODEL_CALLBACK_PREFIX)) {
        // slice, not split("_"): a model name may itself contain underscores,
        // and splitting silently truncated it to the first segment.
        const newModel = query.data.slice(MODEL_CALLBACK_PREFIX.length);
        console.log("Switching to model:", newModel);
        try {
          // Validate before clearing context. Storing an unknown model made
          // the next turn fall back to the default, so the user lost their
          // history and was told the switch had succeeded.
          if (!this.isConfiguredModel(this.normalizeModelName(newModel))) {
            await this.sendMessageWithFallback(
              chatId,
              `${translate("error")}\n"${newModel}" is not a configured model. Run /switchmodel again.`,
            );
            return;
          }
          await this.clearContext(sessionKey, chatId, userId);
          await this.setCurrentModel(sessionKey, newModel);
          await this.sendMessageWithFallback(
            chatId,
            translate("model_changed") + newModel,
          );
        } catch (error) {
          console.error("Error switching model:", error);
          await this.sendMessageWithFallback(
            chatId,
            translate("error") +
              ": " +
              (error instanceof Error ? error.message : "Unknown error"),
          );
        }
      }
    } finally {
      this.answerCallbackQuery(query.id);
    }
  }

  protected answerCallbackQuery(callbackQueryId: string): void {
    this.runBackground("answerCallbackQuery", () =>
      fetch(`${this.apiUrl}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
      }).then(() => {
        console.log("Callback query answered");
      }),
    );
  }

  protected async handleImageAnalysis(
    chatId: number,
    sessionKey: string,
    message: TelegramTypes.Message & { photo: TelegramTypes.PhotoSize[] },
  ): Promise<void> {
    if (!message.photo || message.photo.length === 0) {
      await this.sendMessageWithFallback(
        chatId,
        translate("image_analysis_error"),
      );
      return;
    }

    const fileId = message.photo[message.photo.length - 1].file_id;
    const caption = "caption" in message ? message.caption || "" : "";

    let taskId: string | null = null;
    let progress: TelegramTypes.SendMessageResult[] = [];
    try {
      taskId = await this.beginCancellableTask(sessionKey, "image analysis");
      await sendChatAction(chatId, "typing", this.env);
      progress = await this.sendMessageWithFallback(
        chatId,
        translateMessage("image_analysis_progress"),
      );

      const fileUrl = await this.getFileUrl(fileId);

      const selectedModel = await this.getCurrentModel(sessionKey);
      const currentModel = this.getRoleModel("vision", selectedModel);
      const provider = this.resolveStaticProvider(currentModel, this.config);

      let imageAnalysisAPI: ImageCapableAPI;
      if (provider === "openai" || provider === "google") {
        imageAnalysisAPI = new ImageAnalysisAPI(this.env);
      } else if (this.config.openaiCompatibleUrl) {
        const openaiCompatibleAPI = new OpenAICompatibleAPI(this.env);
        const compatibleModels = await openaiCompatibleAPI.getModels();
        if (!compatibleModels.includes(currentModel)) {
          if (progress[0]?.message_id)
            await this.replaceProgressMessage(
              chatId,
              progress[0].message_id,
              translate("image_analysis_not_supported"),
            );
          else
            await this.sendMessageWithFallback(
              chatId,
              translate("image_analysis_not_supported"),
            );
          return;
        }
        imageAnalysisAPI = openaiCompatibleAPI;
      } else {
        if (progress[0]?.message_id)
          await this.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            translate("image_analysis_not_supported"),
          );
        else
          await this.sendMessageWithFallback(
            chatId,
            translate("image_analysis_not_supported"),
          );
        return;
      }

      const startedAt = Date.now();
      let analysisResult: string;
      try {
        analysisResult = await imageAnalysisAPI.analyzeImage(
          fileUrl,
          caption,
          currentModel,
        );
        this.recordModelUsage(currentModel, "vision", startedAt, true);
      } catch (error) {
        this.recordModelUsage(
          currentModel,
          "vision",
          startedAt,
          false,
          undefined,
          error,
        );
        throw error;
      }

      await this.assertTaskActive(sessionKey, taskId);
      if (progress[0]?.message_id)
        await this.replaceProgressMessage(
          chatId,
          progress[0].message_id,
          analysisResult,
        );
      else await this.sendMessageWithFallback(chatId, analysisResult);
    } catch (error) {
      console.error("Error in image analysis:", error);
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      const userMessage =
        translate("image_analysis_error") + ": " + errorMessage;
      if (progress[0]?.message_id)
        await this.replaceProgressMessage(
          chatId,
          progress[0].message_id,
          userMessage,
        );
      else await this.sendMessage(chatId, userMessage);
    } finally {
      if (taskId) await this.finishCancellableTask(sessionKey, taskId);
    }
  }

  protected async handleBoxDocument(
    message: TelegramTypes.Message,
    chatId: number,
    sessionKey: string,
    userId: string,
    chatType: TelegramTypes.Chat["type"],
  ): Promise<void> {
    const document = message.document;
    if (!document) return;
    const caption = (message.caption || "").trim();
    const explicit = caption
      .match(/^\/agent(?:@\w+)?(?:\s+([\s\S]*))?$/i)?.[1]
      ?.trim();
    const mentioned =
      chatType === "private" ||
      (await this.messageMentionsBot(caption, message.caption_entities));
    if (!explicit && !mentioned) return;
    if (chatType === "private") {
      await this.sendMessageWithFallback(
        chatId,
        "Box agent attachments can only be started from the bound group.",
      );
      return;
    }
    if ((document.file_size ?? 0) > 20 * 1024 * 1024) {
      await this.sendMessageWithFallback(
        chatId,
        "Telegram bot downloads are limited to 20 MB. Provide an accessible URL for this larger input.",
      );
      return;
    }
    try {
      const url = await this.getFileUrl(document.file_id);
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Telegram file download failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 20 * 1024 * 1024)
        throw new Error("Telegram input exceeds the 20 MB download limit.");
      const files: PromptFiles = [
        {
          data: uint8ToBase64(bytes),
          mediaType: document.mime_type || "application/octet-stream",
          filename: document.file_name || "telegram-attachment.bin",
        },
      ];
      const request =
        explicit ||
        caption.replace(/\/agent(?:@\w+)?/i, "").trim() ||
        `Inspect and process the attached file ${document.file_name || ""}.`;
      await this.startBoxAgentJob(
        chatId,
        sessionKey,
        userId,
        request,
        undefined,
        files,
      );
    } catch (error) {
      await this.sendMessageWithFallback(
        chatId,
        this.getUserFacingErrorMessage(error),
      );
    }
  }

  protected async handleVoiceTranscription(
    chatId: number,
    voice: TelegramTypes.Voice,
  ): Promise<void> {
    const audioApi = new AudioAPI(this.env);
    if (!audioApi.isConfigured()) {
      await this.sendMessageWithFallback(
        chatId,
        translateMessage("voice_unavailable"),
      );
      return;
    }
    if ((voice.file_size || 0) > this.config.maxVoiceFileBytes) {
      await this.sendMessageWithFallback(
        chatId,
        translateMessage("voice_too_large", {
          size: Math.round(this.config.maxVoiceFileBytes / 1024 / 1024),
        }),
      );
      return;
    }
    const progress = await this.sendMessageWithFallback(
      chatId,
      translateMessage("voice_progress"),
    );
    const startedAt = Date.now();
    try {
      const fileUrl = await this.getFileUrl(voice.file_id);
      const response = await fetch(fileUrl, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`Telegram file download failed (${response.status}).`);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > this.config.maxVoiceFileBytes)
        throw new Error("Voice note exceeds the configured file-size limit.");
      const audio = await response.blob();
      if (audio.size > this.config.maxVoiceFileBytes)
        throw new Error("Voice note exceeds the configured file-size limit.");
      const transcript = await audioApi.transcribe(
        audio,
        "voice.ogg",
        AbortSignal.timeout(30_000),
      );
      this.recordModelUsage(
        audioApi.transcriptionModel,
        "transcription",
        startedAt,
        true,
      );
      const text = translateMessage("transcript_header", { value: transcript });
      if (progress[0]?.message_id)
        await this.replaceProgressMessage(chatId, progress[0].message_id, text);
      else await this.sendMessageWithFallback(chatId, text);
    } catch (error) {
      this.recordModelUsage(
        audioApi.transcriptionModel,
        "transcription",
        startedAt,
        false,
        undefined,
        error,
      );
      const message = `${translate("image_analysis_error")}\n${error instanceof Error ? error.message : translateMessage("transcription_failed")}`;
      if (progress[0]?.message_id)
        await this.replaceProgressMessage(
          chatId,
          progress[0].message_id,
          message,
        );
      else await this.sendMessageWithFallback(chatId, message);
    }
  }

  protected getProcessedUpdateKey(updateId: number): string {
    return `processed_update:${updateId}`;
  }

  protected async markUpdateAsProcessed(updateId: number): Promise<boolean> {
    try {
      return await this.redis.setIfNotExists(
        this.getProcessedUpdateKey(updateId),
        "1",
        TelegramBotBase.PROCESSED_UPDATE_TTL_SECONDS,
      );
    } catch (error) {
      console.error(
        "Redis update deduplication unavailable; processing update in degraded mode:",
        error,
      );
      return true;
    }
  }

  protected async getFileUrl(fileId: string): Promise<string> {
    const data = await fetchJson<{
      ok: boolean;
      result: { file_path: string };
    }>(
      `https://api.telegram.org/bot${this.token}/getFile?file_id=${fileId}`,
      {},
      "Failed to get file URL",
    );
    if (data.ok) {
      return `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`;
    }
    throw new Error("Failed to get file URL");
  }

  async syncCommands(): Promise<void> {
    await this.setMenuButton();
    await this.redis.set(
      TelegramBotBase.COMMAND_SCHEMA_KEY,
      this.getCommandSchemaFingerprint(),
    );
  }

  protected async syncCommandsIfStale(): Promise<void> {
    if ((await this.getCommandMenuStatus()) === "current") return;
    await this.redis.withLock(
      TelegramBotBase.COMMAND_SCHEMA_KEY,
      async () => {
        if ((await this.getCommandMenuStatus()) === "stale")
          await this.syncCommands();
      },
      { ttlSeconds: 30, retries: 1 },
    );
  }

  protected async getCommandMenuStatus(): Promise<"current" | "stale"> {
    return (await this.redis.get(TelegramBotBase.COMMAND_SCHEMA_KEY)) ===
      this.getCommandSchemaFingerprint()
      ? "current"
      : "stale";
  }

  protected getCommandSchemaFingerprint(): string {
    const schema = this.commands
      .map((command) => `${command.name}:${command.description}`)
      .sort()
      .join("|");
    let hash = 2166136261;
    for (let index = 0; index < schema.length; index += 1) {
      hash ^= schema.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async handleWebhook(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Fail closed. Without a configured secret this endpoint accepted forged
    // updates from anyone who knew the URL.
    const webhookSecret = this.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      console.error(
        "TELEGRAM_WEBHOOK_SECRET is not configured; refusing all webhook traffic. " +
          "Set it as a Wrangler secret and register the same value as Telegram's webhook secret token.",
      );
      return new Response("Forbidden", { status: 403 });
    }
    const headerSecret =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!constantTimeEqual(headerSecret, webhookSecret)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const update: TelegramTypes.Update = await request.json();
      const shouldProcess = await this.markUpdateAsProcessed(update.update_id);
      if (!shouldProcess) {
        return new Response("OK", { status: 200 });
      }

      const processUpdate = this.handleUpdate(update).catch((error) => {
        console.error("Error processing webhook:", error);
      });

      if (this.ctx) {
        this.ctx.waitUntil(processUpdate);
      } else {
        await processUpdate;
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error processing webhook:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  async sendPhoto(
    chatId: number,
    photo: string | Uint8Array,
    options: { caption?: string } = {},
  ): Promise<void> {
    await this.transport.sendPhoto(chatId, photo, options.caption);
  }

  async synthesizeSpeech(text: string): Promise<Uint8Array> {
    const audioApi = new AudioAPI(this.env);
    const startedAt = Date.now();
    try {
      const audio = await audioApi.synthesize(
        text,
        AbortSignal.timeout(30_000),
      );
      this.recordModelUsage(audioApi.ttsModel, "tts", startedAt, true);
      return audio;
    } catch (error) {
      this.recordModelUsage(
        audioApi.ttsModel,
        "tts",
        startedAt,
        false,
        undefined,
        error,
      );
      throw error;
    }
  }

  async sendVoice(
    chatId: number,
    voice: Uint8Array,
    caption?: string,
  ): Promise<void> {
    await this.transport.sendVoice(chatId, voice, caption);
  }

  async setWebhook(url: string): Promise<void> {
    // Registering without a secret token would produce a webhook whose every
    // delivery `handleWebhook` then rejects. Fail here, where it is diagnosable.
    const webhookSecret = this.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET must be set before registering the Telegram webhook.",
      );
    }
    const setWebhookUrl = `${this.apiUrl}/setWebhook`;
    const result = await fetchJson<{ ok: boolean; description?: string }>(
      setWebhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, secret_token: webhookSecret }),
      },
      "Failed to set webhook",
    );
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }
  }

  async sendMessageWithFallback(
    chatId: number,
    text: string,
  ): Promise<TelegramTypes.SendMessageResult[]> {
    return await this.transport.sendMessageWithFallback(chatId, text);
  }

  async replaceProgressMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.transport.replaceProgressMessage(chatId, messageId, text);
  }

  protected getUserFacingErrorMessage(error: unknown): string {
    const fallback = translate("error");
    // A policy or admission message is the actionable part of the answer;
    // replacing it with "an error occurred" strands the user.
    if (isUserFacingError(error)) {
      return error.message;
    }
    if (!(error instanceof Error)) {
      return fallback;
    }

    const message = error.message.toLowerCase();
    if (
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("fair usage policy") ||
      message.includes("quota exceeded") ||
      message.includes("resource_exhausted")
    ) {
      return `${fallback}\nThe current AI provider is temporarily rate-limiting this bot. Try again later.`;
    }

    if (
      message.includes("unavailable") ||
      message.includes("high demand") ||
      message.includes("service unavailable")
    ) {
      return `${fallback}\nThe current AI provider is temporarily overloaded. Try again in a bit.`;
    }

    return fallback;
  }

  /**
   * One global menu covers every chat. This previously scanned the keyspace for
   * per-user language keys and issued a scoped setMyCommands call per user,
   * which grew a subrequest per user on a single invocation.
   */

  protected async setMenuButton(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: this.commands.map((command) => ({
          command: command.name,
          description: translate(command.description),
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to set the Telegram command menu: ${response.statusText}`,
      );
    }
  }

  protected getDisplayName(user: TelegramTypes.User): string {
    const fullName = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    return user.username || fullName || user.id.toString();
  }

  protected formatReplyContext(
    message: TelegramTypes.Message,
    chatTitle: string,
  ): string | null {
    const repliedMessage = message.reply_to_message;
    if (!repliedMessage) {
      return null;
    }

    const repliedSender = repliedMessage.from
      ? this.getDisplayName(repliedMessage.from)
      : "Unknown";
    const repliedText = repliedMessage.text || repliedMessage.caption;
    if (!repliedText) {
      return `[Group: ${chatTitle}]\nThis message is replying to ${repliedSender}, but the original message had no readable text.`;
    }

    const normalizedText = repliedText.replace(/\s+/g, " ").trim();
    return `[Group: ${chatTitle}]\nThis message is directly replying to ${repliedSender}: ${normalizedText}`;
  }

  protected async getBotUsername(): Promise<string | null> {
    if (this.botUsername) {
      return this.botUsername;
    }

    try {
      const cached = await this.redis.get(TelegramBotBase.BOT_USERNAME_KEY);
      if (cached) {
        this.botUsername = cached;
        return cached;
      }
    } catch (error) {
      console.error("Error reading cached bot username:", error);
    }

    try {
      const data = await fetchJson<{
        ok: boolean;
        result?: { username?: string };
      }>(`${this.apiUrl}/getMe`, {}, "Failed to get bot info");
      if (!data.ok) {
        throw new Error("Failed to get bot info");
      }
      const username = data.result?.username || null;
      this.botUsername = username;
      if (username) {
        this.runBackground("cacheBotUsername", () =>
          this.redis.set(
            TelegramBotBase.BOT_USERNAME_KEY,
            username,
            TelegramBotBase.BOT_USERNAME_TTL_SECONDS,
          ),
        );
      }
      return username;
    } catch (error) {
      console.error("Error fetching bot username:", error);
      return null;
    }
  }

  protected async messageMentionsBot(
    text: string,
    entities?: TelegramTypes.MessageEntity[],
  ): Promise<boolean> {
    const botUsername = await this.getBotUsername();
    if (!botUsername) {
      return false;
    }

    if (entities && entities.length > 0) {
      const loweredBotMention = `@${botUsername.toLowerCase()}`;
      for (const entity of entities) {
        if (entity.type !== "mention") {
          continue;
        }

        const entityText = text
          .slice(entity.offset, entity.offset + entity.length)
          .toLowerCase();
        if (entityText === loweredBotMention) {
          return true;
        }
      }
    }

    const mentionRegex = new RegExp(
      `(^|\\s)@${botUsername}(?=\\s|$|[,.!?;:])`,
      "i",
    );
    return mentionRegex.test(text);
  }

  protected async stripBotMention(text: string): Promise<string> {
    const botUsername = await this.getBotUsername();
    if (!botUsername) {
      return text.trim();
    }

    const mentionRegex = new RegExp(
      `(^|\\s)@${botUsername}(?=\\s|$|[,.!?;:])`,
      "ig",
    );
    return text
      .replace(mentionRegex, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
}

export default TelegramMessageHandlingBot;
