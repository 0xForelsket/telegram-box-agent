import { Message } from "../chat_types";
import { translateMessage } from "../../utils/i18n";
import YahooFinanceAPI from "../yahoo_finance";
import { TelegramStatus } from "../../config/command_types";
import { formatSearchResponseForModel } from "../../search/search_broker";
import {
  createJobId,
  parseDigestInput,
  parseReminderInput,
  ScheduledJob,
  SharedScheduler,
} from "../../scheduling/scheduler";
import { formatFeed, readFeed } from "../../utils/structured_utilities";
import { feedSubscriptionsKey } from "../../memory/session_keys";
import { RUNTIME_BUDGETS } from "../../config/runtime_budgets";
import {
  AgentRun,
  AgentRunStore,
  AgentWakeResult,
} from "../../agent/agent_run_store";

import { type ActiveTaskRecord, type FeedSubscription } from "./types";

import { TelegramBotBase } from "./base";
import TelegramChatExecutionBot from "./chat_execution";

export abstract class TelegramSchedulingBot extends TelegramChatExecutionBot {
  async beginCancellableTask(
    sessionKey: string,
    type: string,
  ): Promise<string> {
    const record: ActiveTaskRecord = {
      id: crypto.randomUUID(),
      type: type.slice(0, 40),
      status: "running",
      startedAt: new Date().toISOString(),
    };
    await this.redis.set(
      this.getActiveTaskKey(sessionKey),
      JSON.stringify(record),
      TelegramBotBase.ACTIVE_TASK_TTL_SECONDS,
    );
    return record.id;
  }

  async assertTaskActive(sessionKey: string, taskId: string): Promise<void> {
    const record = await this.getActiveTask(sessionKey);
    if (!record || record.id !== taskId || record.status === "cancelled")
      throw new Error(translateMessage("task_cancelled"));
  }

  protected async assertCurrentTaskActive(sessionKey: string): Promise<void> {
    const record = await this.getActiveTask(sessionKey);
    if (record?.status === "cancelled")
      throw new Error(translateMessage("task_cancelled"));
  }

  async finishCancellableTask(
    sessionKey: string,
    taskId: string,
  ): Promise<void> {
    await this.redis.withLock(this.getActiveTaskKey(sessionKey), async () => {
      const record = await this.getActiveTask(sessionKey);
      if (record?.id === taskId)
        await this.redis.del(this.getActiveTaskKey(sessionKey));
    });
  }

  async cancelActiveTask(sessionKey: string): Promise<string | null> {
    return await this.redis.withLock(
      this.getActiveTaskKey(sessionKey),
      async () => {
        const record = await this.getActiveTask(sessionKey);
        if (!record || record.status !== "running") return null;
        await this.redis.set(
          this.getActiveTaskKey(sessionKey),
          JSON.stringify({
            ...record,
            status: "cancelled",
          } satisfies ActiveTaskRecord),
          TelegramBotBase.ACTIVE_TASK_TTL_SECONDS,
        );
        return record.type;
      },
    );
  }

  protected async getActiveTask(
    sessionKey: string,
  ): Promise<ActiveTaskRecord | null> {
    const raw = await this.redis.get(this.getActiveTaskKey(sessionKey));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as ActiveTaskRecord;
      return record &&
        typeof record.id === "string" &&
        typeof record.type === "string" &&
        (record.status === "running" || record.status === "cancelled")
        ? record
        : null;
    } catch {
      return null;
    }
  }

  async getStatus(sessionKey: string): Promise<TelegramStatus> {
    const settings = await this.getBotSettings(sessionKey);
    const [
      currentModel,
      groupProfile,
      summary,
      recentTurns,
      ambientMessages,
      seenMembers,
      personCards,
      activeTopics,
    ] = await Promise.all([
      this.getCurrentModel(sessionKey),
      this.getGroupProfile(sessionKey),
      this.getConversationSummary(sessionKey),
      this.getRecentTurns(sessionKey),
      this.getAmbientMessages(sessionKey),
      this.getSeenMembers(sessionKey),
      this.getPersonCards(sessionKey),
      this.getActiveTopics(sessionKey),
    ]);
    const roleModels = [
      currentModel,
      this.getRoleModel("summary", currentModel),
      this.getRoleModel("research", currentModel),
      this.getRoleModel("vision", currentModel),
      ...this.config.modelFallbacks,
    ];
    const modelProviders = Array.from(
      new Set(roleModels.map((model) => this.getProviderIdForModel(model))),
    );
    const [
      modelProviderHealth,
      searchProviderHealth,
      searchQuotas,
      commandMenuStatus,
    ] = await Promise.all([
      this.usageTracker
        .getProviderHealth("model", modelProviders)
        .catch(() => []),
      this.usageTracker
        .getProviderHealth("search", this.config.searchProviders)
        .catch(() => []),
      this.getSearchQuotaStatus().catch(() => []),
      this.getCommandMenuStatus(),
    ]);

    return {
      currentModel,
      summaryModel: this.getRoleModel("summary", currentModel),
      researchModel: this.getRoleModel("research", currentModel),
      visionModel: this.getRoleModel("vision", currentModel),
      ambientMemory: settings.ambientMemory,
      replyStyle: settings.replyStyle,
      hasGroupProfile: !!groupProfile,
      hasSummary: !!summary,
      recentTurnCount: recentTurns.length,
      ambientMessageCount: ambientMessages.length,
      seenMemberCount: seenMembers.length,
      personCardCount: personCards.length,
      activeTopicCount: activeTopics.length,
      searchProviders: this.config.searchProviders,
      webSearchAvailable: this.createSearchBroker().isConfigured(),
      modelFallbacks: this.config.modelFallbacks,
      modelProviderHealth,
      searchProviderHealth,
      searchQuotas,
      commandMenuStatus,
    };
  }

  protected async getSearchQuotaStatus(): Promise<
    Array<{ provider: string; used: number; cap: number | null }>
  > {
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
    return await Promise.all(
      this.config.searchProviders.map(async (provider) => {
        const cap =
          provider === "exa"
            ? this.config.exaMonthlySearchCap
            : provider === "openai"
              ? this.config.openaiSearchMonthlyCap
              : provider === "gemini_grounding"
                ? this.config.geminiSearchMonthlyCap
                : null;
        const [current, legacy] = await Promise.all([
          this.redis.get(`search_usage:v1:${provider}:${month}`),
          provider === "exa"
            ? this.redis.get(`web_search_usage:${month}`)
            : Promise.resolve(null),
        ]);
        return {
          provider,
          used:
            (Number.parseInt(current || "0", 10) || 0) +
            (Number.parseInt(legacy || "0", 10) || 0),
          cap,
        };
      }),
    );
  }

  async addReminder(
    chatId: number,
    sessionKey: string,
    input: string,
  ): Promise<string> {
    const parsed = parseReminderInput(input);
    if (parsed.dueAt <= Date.now())
      throw new Error(translateMessage("reminder_in_past"));
    const job: ScheduledJob = {
      id: createJobId(),
      type: "reminder",
      chatId,
      sessionKey,
      nextAt: parsed.dueAt,
      createdAt: Date.now(),
      recurrence: parsed.recurrence,
      payload: { text: parsed.text.slice(0, 2_000) },
    };
    await new SharedScheduler(this.redis).schedule(job);
    return translateMessage("reminder_set", {
      id: job.id,
      time: this.formatScheduledTime(job.nextAt),
      recurrence: job.recurrence ? ` (${job.recurrence})` : "",
    });
  }

  async createAgentRun(
    chatId: number,
    sessionKey: string,
    goal: string,
  ): Promise<AgentRun> {
    return await new AgentRunStore(this.redis).create({
      chatId,
      sessionKey,
      goal,
    });
  }

  async listAgentRuns(sessionKey: string): Promise<string | null> {
    const runs = await new AgentRunStore(this.redis).list(sessionKey);
    if (runs.length === 0) return null;
    return runs
      .slice(0, 10)
      .map((run) => {
        const detail =
          run.status === "completed" && run.result
            ? ` — ${run.result.replace(/\s+/g, " ").slice(0, 160)}`
            : run.status === "failed" && run.lastError
              ? ` — ${run.lastError.replace(/\s+/g, " ").slice(0, 160)}`
              : "";
        const phase =
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "cancelled"
            ? run.status
            : `${run.phase}, wake ${run.wakeCount}/${run.maxWakes}`;
        const current =
          run.phase === "executing" && run.plan[run.currentStep]
            ? `\n  Current: ${run.plan[run.currentStep].title}`
            : "";
        return `- ${run.id}: ${phase}\n  ${run.goal}${current}${detail}`;
      })
      .join("\n");
  }

  async cancelAgentRun(
    sessionKey: string,
    id: string,
  ): Promise<AgentRun | null> {
    return await new AgentRunStore(this.redis).cancel(sessionKey, id);
  }

  async listReminders(sessionKey: string): Promise<string | null> {
    const jobs = (
      await new SharedScheduler(this.redis).list(sessionKey)
    ).filter((job) => job.type === "reminder");
    if (jobs.length === 0) return null;
    return jobs
      .map(
        (job) =>
          `- ${job.id}: ${job.payload.text}\n  ${this.formatScheduledTime(job.nextAt)}${job.recurrence ? ` (${job.recurrence})` : ""}`,
      )
      .join("\n");
  }

  async removeReminder(sessionKey: string, id: string): Promise<string | null> {
    const job = await new SharedScheduler(this.redis).cancel(
      sessionKey,
      id,
      "reminder",
    );
    return job?.type === "reminder" ? job.payload.text || job.id : null;
  }

  async addFeedSubscription(sessionKey: string, url: string): Promise<string> {
    const feed = await readFeed(url, 1, AbortSignal.timeout(10_000));
    const subscriptions = await this.getFeedSubscriptions(sessionKey);
    const normalizedUrl = new URL(url).toString();
    const existing = subscriptions.find(
      (subscription) => subscription.url === normalizedUrl,
    );
    if (existing) return existing.id;
    const subscription: FeedSubscription = {
      id: createJobId(),
      url: normalizedUrl,
      title: feed.title || new URL(normalizedUrl).hostname,
      createdAt: new Date().toISOString(),
    };
    subscriptions.push(subscription);
    await this.redis.set(
      feedSubscriptionsKey(sessionKey),
      JSON.stringify(subscriptions.slice(-10)),
    );
    return subscription.id;
  }

  async listFeedSubscriptions(sessionKey: string): Promise<string | null> {
    const subscriptions = await this.getFeedSubscriptions(sessionKey);
    return subscriptions.length > 0
      ? subscriptions
          .map((item) => `- ${item.id}: ${item.title}\n  ${item.url}`)
          .join("\n")
      : null;
  }

  async removeFeedSubscription(
    sessionKey: string,
    id: string,
  ): Promise<string | null> {
    const subscriptions = await this.getFeedSubscriptions(sessionKey);
    const target = subscriptions.find(
      (item) => item.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (!target) return null;
    await this.redis.set(
      feedSubscriptionsKey(sessionKey),
      JSON.stringify(subscriptions.filter((item) => item.id !== target.id)),
    );
    return target.title;
  }

  async addDigest(
    chatId: number,
    sessionKey: string,
    input: string,
  ): Promise<string> {
    const parsed = parseDigestInput(input);
    if (
      parsed.mode === "feeds" &&
      (await this.getFeedSubscriptions(sessionKey)).length === 0
    ) {
      throw new Error(translateMessage("follow_feed_first"));
    }
    const job: ScheduledJob = {
      id: createJobId(),
      type: "digest",
      chatId,
      sessionKey,
      nextAt: parsed.dueAt,
      createdAt: Date.now(),
      recurrence: parsed.recurrence,
      payload: {
        mode: parsed.mode,
        ...(parsed.query ? { query: parsed.query.slice(0, 500) } : {}),
      },
    };
    await new SharedScheduler(this.redis).schedule(job);
    return translateMessage("digest_scheduled", {
      id: job.id,
      time: this.formatScheduledTime(job.nextAt),
      recurrence: job.recurrence || "",
      mode: parsed.mode,
    });
  }

  async listDigests(sessionKey: string): Promise<string | null> {
    const jobs = (
      await new SharedScheduler(this.redis).list(sessionKey)
    ).filter((job) => job.type === "digest");
    return jobs.length > 0
      ? jobs
          .map(
            (job) =>
              `- ${job.id}: ${job.payload.mode}${job.payload.query ? ` ${job.payload.query}` : ""}\n  ${this.formatScheduledTime(job.nextAt)} (${job.recurrence})`,
          )
          .join("\n")
      : null;
  }

  async removeDigest(sessionKey: string, id: string): Promise<string | null> {
    const job = await new SharedScheduler(this.redis).cancel(
      sessionKey,
      id,
      "digest",
    );
    return job?.type === "digest"
      ? `${job.payload.mode}${job.payload.query ? ` ${job.payload.query}` : ""}`
      : null;
  }

  async processScheduledTasks(): Promise<number> {
    let processed = 0;
    try {
      processed += await new SharedScheduler(this.redis).drainDue(
        async (job) => {
          if (job.type === "reminder") {
            await this.sendMessageWithFallback(
              job.chatId,
              translateMessage("reminder_alert", { value: job.payload.text }),
            );
            return;
          }
          await this.processDigestJob(job);
        },
      );
    } catch (error) {
      console.error("Scheduled reminders/digests drain failed:", error);
    }
    try {
      processed += await new AgentRunStore(this.redis).retirePending();
    } catch (error) {
      console.error("Legacy agent-run retirement failed:", error);
    }
    try {
      processed += await this.boxJobs().recoverTerminalSideEffects();
    } catch (error) {
      console.error("Box terminal side-effect recovery failed:", error);
    }
    try {
      const boundChatId = await this.boxJobs().getBoundChatId();
      if (boundChatId !== null)
        processed += await this.boxSchedules().recoverDeliveries(boundChatId);
    } catch (error) {
      console.error("Box schedule delivery recovery failed:", error);
    }
    return processed;
  }

  protected async processDueAgentRuns(): Promise<number> {
    const store = new AgentRunStore(this.redis);
    return await store.drainDue(
      async (run) => {
        await this.ensureAgentProgressMessage(store, run);
        return await this.executeAgentRunWake(run);
      },
      Date.now(),
      async (run) => this.publishAgentRunTransition(store, run),
    );
  }

  protected async executeAgentRunWake(run: AgentRun): Promise<AgentWakeResult> {
    const promptState = await this.loadPromptState(run.sessionKey);
    const model = promptState.currentModel;
    this.modelAPI = await this.getModelAPIForModel(model);

    if (run.phase === "planning") {
      const response = await this.generateTrackedResponse(
        this.modelAPI,
        [
          {
            role: "system",
            content: [
              "Create a short execution plan for a persistent background agent.",
              'Return only <agent-plan>{"steps":["step 1","step 2"]}</agent-plan>.',
              "Use one to five concrete steps. Each step must fit inside one bounded model-and-tool session.",
              "Make steps independently useful and ordered. Do not include final answer synthesis as a step.",
              "Do not perform the work yet and do not include hidden reasoning.",
            ].join(" "),
          },
          { role: "user", content: `Goal: ${run.goal}` },
        ],
        model,
        "agent_plan",
      );
      return {
        type: "planned",
        plan: this.parseAgentPlan(response),
        observation: "Created a bounded execution plan.",
      };
    }

    if (run.phase === "finalizing") {
      const response = await this.generateTrackedResponse(
        this.modelAPI,
        [
          {
            role: "system",
            content: [
              "Produce the final user-facing deliverable for this completed background job.",
              "Use the persisted observations as the factual record. Do not invent work that was not completed.",
              "Return only the deliverable, with no progress preamble, internal state, or reasoning trace.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Goal:\n${run.goal}\n\nCompleted plan:\n${this.formatAgentPlan(run)}\n\nObservations:\n${this.formatAgentObservations(run)}`,
          },
        ],
        model,
        "agent_step",
      );
      return { type: "completed", result: response };
    }

    const step = run.plan[run.currentStep];
    if (!step) {
      return {
        type: "blocked",
        error: "The persisted plan has no current executable step.",
      };
    }
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "Execute exactly one saved background-agent step using the available read-only tools when useful.",
          "Do not create reminders, change memory, queue jobs, contact third parties, spend money, or mutate external state.",
          "Do not redo completed plan steps. Use prior observations as your starting evidence.",
          "After the step, return only one of these envelopes:",
          '<agent-step>{"status":"advanced","observation":"compact factual work product"}</agent-step>',
          '<agent-step>{"status":"complete","observation":"compact factual work product","final_answer":"finished deliverable"}</agent-step>',
          '<agent-step>{"status":"blocked","observation":"specific blocker"}</agent-step>.',
          "Use complete only if the entire goal is already fulfilled. Use blocked only when another wake cannot make progress.",
          "The observation must preserve useful evidence, conclusions, links, numbers, and unresolved uncertainty without chain-of-thought.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Job: ${run.id}`,
          `Goal: ${run.goal}`,
          `Current step (${run.currentStep + 1}/${run.plan.length}): ${step.title}`,
          `Full plan:\n${this.formatAgentPlan(run)}`,
          `Persisted observations:\n${this.formatAgentObservations(run)}`,
          this.getCurrentDateTimeInstruction("current date and time"),
        ].join("\n\n"),
      },
    ];
    const response = await this.generateChatResponse(
      messages,
      model,
      run.sessionKey,
      run.chatId,
      undefined,
      new Set(),
      false,
      false,
    );
    return this.parseAgentStepResponse(response);
  }

  protected parseAgentPlan(response: string): string[] {
    const tagged = response.match(
      /<agent-plan>\s*([\s\S]*?)\s*<\/agent-plan>/i,
    )?.[1];
    for (const candidate of [tagged, response]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate.trim()) as { steps?: unknown };
        if (Array.isArray(parsed.steps)) {
          const steps = parsed.steps.filter(
            (step): step is string => typeof step === "string" && !!step.trim(),
          );
          if (steps.length > 0) return steps.slice(0, 5);
        }
      } catch {
        // Fall through to line-based recovery for providers that add formatting.
      }
    }
    const recovered = response
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length >= 4 && !/^<\/?agent-plan/i.test(line))
      .slice(0, 5);
    return recovered.length > 0
      ? recovered
      : [
          "Gather the evidence needed for the goal",
          "Analyze the evidence and resolve uncertainties",
          "Prepare the requested deliverable",
        ];
  }

  protected parseAgentStepResponse(response: string): AgentWakeResult {
    const tagged = response.match(
      /<agent-step>\s*([\s\S]*?)\s*<\/agent-step>/i,
    )?.[1];
    for (const candidate of [tagged, response]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate.trim()) as {
          status?: string;
          observation?: string;
          final_answer?: string;
        };
        const observation = parsed.observation?.trim();
        if (parsed.status === "complete" && parsed.final_answer?.trim()) {
          return {
            type: "completed",
            result: parsed.final_answer.trim(),
            observation,
          };
        }
        if (parsed.status === "blocked") {
          return {
            type: "blocked",
            error: observation || "The current step reported a blocker.",
          };
        }
        if (parsed.status === "advanced" && observation) {
          return { type: "advanced", observation };
        }
      } catch {
        // A useful plain-text step result can still be persisted safely.
      }
    }
    const recovered = response.replace(/<\/?agent-step>/gi, "").trim();
    if (!recovered)
      throw new Error("Agent step returned no usable observation.");
    return { type: "advanced", observation: recovered };
  }

  protected formatAgentPlan(run: AgentRun): string {
    if (run.plan.length === 0) return "Not planned yet.";
    return run.plan
      .map((step, index) => `${index + 1}. [${step.status}] ${step.title}`)
      .join("\n");
  }

  protected formatAgentObservations(run: AgentRun): string {
    if (run.observations.length === 0) return "None yet.";
    return run.observations
      .slice(-10)
      .map((item) => `- ${item.stepId}: ${item.summary.slice(0, 1_500)}`)
      .join("\n");
  }

  protected async ensureAgentProgressMessage(
    store: AgentRunStore,
    run: AgentRun,
  ): Promise<void> {
    const text = this.renderAgentRunProgress(run, true);
    if (run.progressMessageId) {
      await this.replaceProgressMessage(
        run.chatId,
        run.progressMessageId,
        text,
      ).catch((error) => {
        console.error(`Failed to update running agent job ${run.id}:`, error);
      });
      return;
    }
    const sent = await this.sendMessageWithFallback(run.chatId, text);
    if (sent[0]?.message_id)
      await store.setProgressMessage(run.id, sent[0].message_id);
  }

  protected async publishAgentRunTransition(
    store: AgentRunStore,
    run: AgentRun,
  ): Promise<void> {
    const latest = (await store.getForSession(run.sessionKey, run.id)) || run;
    const text = this.renderAgentRunProgress(latest, false);
    if (latest.progressMessageId) {
      await this.replaceProgressMessage(
        latest.chatId,
        latest.progressMessageId,
        text,
      );
    } else {
      const sent = await this.sendMessageWithFallback(latest.chatId, text);
      if (sent[0]?.message_id)
        await store.setProgressMessage(latest.id, sent[0].message_id);
    }
    if (latest.status === "completed" && latest.result) {
      const promptText = `[Background agent job ${latest.id}] ${latest.goal}`;
      const selectedModel = await this.getCurrentModel(latest.sessionKey);
      await this.rememberConversation(
        latest.sessionKey,
        promptText,
        latest.result,
        selectedModel,
      ).catch((error) =>
        console.error(
          `Failed to persist agent job ${latest.id} conversation:`,
          error,
        ),
      );
    }
  }

  protected renderAgentRunProgress(run: AgentRun, working: boolean): string {
    const header = `Background job ${run.id}`;
    if (run.status === "completed")
      return `${header} completed:\n\n${run.result || "Completed without a result."}`;
    if (run.status === "failed")
      return `${header} failed after ${run.wakeCount} wakes.\n\n${run.lastError || "Unknown failure."}`;
    if (run.status === "cancelled") return `${header} cancelled.`;
    if (run.phase === "planning")
      return `${header}\nPlanning the work${working ? "…" : "."}`;
    if (run.phase === "finalizing")
      return `${header}\nAll ${run.plan.length} steps complete. ${working ? "Preparing the final answer…" : "Final answer queued for the next wake."}`;
    const step = run.plan[run.currentStep];
    const done = run.plan.filter((item) => item.status === "completed").length;
    return [
      header,
      `Progress: ${done}/${run.plan.length} steps complete`,
      step
        ? `${working ? "Working on" : "Next"}: ${step.title}`
        : "Preparing final answer",
      working
        ? ""
        : `Eligible for the next cron wake after: ${this.formatScheduledTime(run.nextAt)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  protected formatScheduledTime(timestamp: number): string {
    return new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Kuala_Lumpur",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  }

  protected async processDigestJob(job: ScheduledJob): Promise<void> {
    const mode = job.payload.mode;
    let body: string;
    if (mode === "feeds") {
      const subscriptions = (
        await this.getFeedSubscriptions(job.sessionKey)
      ).slice(0, RUNTIME_BUDGETS.maxConcurrentOutboundRequests);
      if (subscriptions.length === 0)
        throw new Error("No feed subscriptions remain.");
      const results = await Promise.allSettled(
        subscriptions.map(async (subscription) => ({
          subscription,
          feed: await readFeed(
            subscription.url,
            3,
            AbortSignal.timeout(10_000),
          ),
        })),
      );
      const sections = results.flatMap((result) =>
        result.status === "fulfilled"
          ? [
              `${result.value.subscription.title}\n${formatFeed(result.value.feed)}`,
            ]
          : [],
      );
      if (sections.length === 0)
        throw new Error("All subscribed feeds failed.");
      body = sections.join("\n\n");
    } else if (mode === "search") {
      body = formatSearchResponseForModel(
        await this.createSearchBroker().search(job.payload.query || "", 5),
        3_500,
      );
    } else if (mode === "stock") {
      body = await new YahooFinanceAPI().lookupStockQuote(
        job.payload.query || "",
      );
    } else {
      throw new Error(`Unknown digest mode: ${mode}`);
    }
    await this.sendMessageWithFallback(
      job.chatId,
      translateMessage("digest_header", { mode, value: body }),
    );
  }

  protected async getFeedSubscriptions(
    sessionKey: string,
  ): Promise<FeedSubscription[]> {
    const raw = await this.redis.get(feedSubscriptionsKey(sessionKey));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as FeedSubscription[];
      return Array.isArray(parsed)
        ? parsed.filter(
            (item) =>
              item &&
              typeof item.id === "string" &&
              typeof item.url === "string" &&
              typeof item.title === "string",
          )
        : [];
    } catch {
      return [];
    }
  }

  protected getActiveTaskKey(sessionKey: string): string {
    return `active_task:v1:${sessionKey}`;
  }
}

export default TelegramSchedulingBot;
