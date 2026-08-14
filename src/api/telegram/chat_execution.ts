import OpenAIAPI from "../openai_api";
import {
  ChatCompletionResponse,
  Message,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../chat_types";
import { translate, translateMessage } from "../../utils/i18n";
import {
  ModelAPIInterface,
  ModelResponse,
  ModelUsage,
} from "../model_api_interface";
import GeminiAPI from "../gemini";
import GroqAPI from "../groq";
import ClaudeAPI from "../claude";
import AzureAPI from "../azure";
import OpenAICompatibleAPI from "../openai_compatible";
import ExaSearchAPI from "../exa_search";
import EODHDAPI from "../eodhd";
import YahooFinanceAPI from "../yahoo_finance";
import WikipediaAPI from "../wikipedia";
import { ModelRequestMode, UsageTracker } from "../../utils/usage_tracker";
import {
  formatSearchResponseForModel,
  SearchBroker,
} from "../../search/search_broker";
import { OpenAIWebSearchProvider } from "../../search/providers/openai_web_search";
import { GeminiGroundingProvider } from "../../search/providers/gemini_grounding";
import { buildPromptLayout } from "../../prompt/prompt_layout";
import { lastReadKey, lastSourcesKey } from "../../memory/session_keys";
import {
  SearchProvider,
  SearchResponse,
  SearchSource,
} from "../../search/types";
import { URLReader } from "../../web/url_reader";
import { RUNTIME_BUDGETS } from "../../config/runtime_budgets";
import { ToolRegistry } from "../../tools/tool_registry";
import {
  parseToolArguments,
  runArxivTool,
  runCalculatorTool,
  runCurrencyTool,
  runGitHubTool,
  runStockQuoteTool,
  runWeatherTool,
  runWikipediaTool,
  toolFailure,
  toolSuccess,
} from "../../tools/tool_runners";
import {
  ARXIV_TOOL,
  CALCULATOR_TOOL,
  CURRENCY_TOOL,
  GITHUB_TOOL,
  MEMORY_TOOL,
  READ_URL_TOOL,
  REMINDER_TOOL,
  STOCK_QUOTE_TOOL,
  WEATHER_TOOL,
  WEB_SEARCH_TOOL,
  WIKIPEDIA_TOOL,
} from "../../tools/tool_definitions";
import { AgentRunStore } from "../../agent/agent_run_store";
import {
  buildStableMemoryBlock,
  buildVolatileContextBlock,
  selectRelevantPromptMemory,
} from "../../memory/prompt_memory";

import {
  type AppConfig,
  type ChatCompletionClient,
  type MemoryTurn,
  type ModelRole,
  type PromptState,
  type StaticProviderId,
} from "./types";

import { TelegramBotBase } from "./base";
import TelegramMemoryBot from "./memory";

export abstract class TelegramChatExecutionBot extends TelegramMemoryBot {
  protected runBackground(label: string, fn: () => Promise<void>): void {
    const promise = fn().catch((error) => {
      console.error(`Background task failed (${label}):`, error);
    });
    if (this.ctx) {
      this.ctx.waitUntil(promise);
    }
  }

  protected normalizeModelName(model: string): string {
    return TelegramBotBase.MODEL_MIGRATIONS[model] || model;
  }

  protected getProviderIdForModel(model: string): string {
    const staticProvider = this.resolveStaticProvider(model, this.config);
    if (staticProvider) return staticProvider;
    if (model === this.config.dallEModel) return "openai";
    if (model.startsWith("@cf/")) return "cloudflare";
    return "openai_compatible";
  }

  protected getErrorCategory(error: unknown): string {
    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    if (
      message.includes("429") ||
      message.includes("rate limit") ||
      message.includes("quota")
    )
      return "quota";
    if (
      message.includes("401") ||
      message.includes("403") ||
      message.includes("unauthorized")
    )
      return "auth";
    if (message.includes("timeout") || message.includes("abort"))
      return "timeout";
    if (message.includes("400") || message.includes("invalid"))
      return "invalid_request";
    if (
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503")
    )
      return "upstream";
    return "other";
  }

  protected isRetryableModelError(error: unknown): boolean {
    return ["quota", "auth", "timeout", "upstream"].includes(
      this.getErrorCategory(error),
    );
  }

  protected getModelFallbackCandidates(
    failedModel: string,
    mode: ModelRequestMode,
    requireTools = false,
  ): string[] {
    if (mode === "compare") return [];
    const seen = new Set([failedModel]);
    return this.config.modelFallbacks
      .map((model) => this.normalizeModelName(model))
      .filter((model) => {
        if (seen.has(model) || !this.isConfiguredModel(model)) return false;
        if (requireTools && !this.isToolCapableModel(model)) return false;
        seen.add(model);
        return true;
      })
      .slice(0, 2);
  }

  protected recordModelUsage(
    model: string,
    mode: ModelRequestMode,
    startedAt: number,
    success: boolean,
    usage?: ModelUsage,
    error?: unknown,
    resolvedModel?: string,
  ): void {
    this.runBackground("recordModelUsage", () =>
      this.usageTracker.recordModelCall({
        provider: this.getProviderIdForModel(model),
        model: resolvedModel || model,
        mode,
        latencyMs: Date.now() - startedAt,
        success,
        usage,
        errorCategory: error ? this.getErrorCategory(error) : undefined,
      }),
    );
  }

  protected async generateTrackedResponse(
    api: ModelAPIInterface,
    messages: Message[],
    model: string,
    mode: ModelRequestMode,
  ): Promise<string> {
    const attemptModels = [
      model,
      ...this.getModelFallbackCandidates(model, mode),
    ];

    let lastError: unknown;
    for (const [index, attemptModel] of attemptModels.entries()) {
      const attemptApi =
        index === 0 ? api : await this.getModelAPIForModel(attemptModel);
      const startedAt = Date.now();
      try {
        const result: ModelResponse = attemptApi.generateResponseWithMetadata
          ? await attemptApi.generateResponseWithMetadata(
              messages,
              attemptModel,
            )
          : {
              content: await attemptApi.generateResponse(
                messages,
                attemptModel,
              ),
              resolvedModel: attemptModel,
            };
        this.recordModelUsage(
          attemptModel,
          mode,
          startedAt,
          true,
          result.usage,
          undefined,
          result.resolvedModel,
        );
        return result.content;
      } catch (error) {
        this.recordModelUsage(
          attemptModel,
          mode,
          startedAt,
          false,
          undefined,
          error,
        );
        lastError = error;
        if (
          !this.isRetryableModelError(error) ||
          index === attemptModels.length - 1
        )
          throw error;
        console.warn(
          `Model ${attemptModel} failed for ${mode}; trying a configured compatible fallback.`,
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All configured models failed");
  }

  protected async createTrackedChatCompletion(
    api: ChatCompletionClient,
    messages: Message[],
    model: string,
    mode: ModelRequestMode,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse> {
    const attemptModels = [
      model,
      ...this.getModelFallbackCandidates(model, mode, true),
    ];

    let lastError: unknown;
    for (const [index, attemptModel] of attemptModels.entries()) {
      const attemptApi =
        index === 0
          ? api
          : ((await this.getModelAPIForModel(
              attemptModel,
            )) as unknown as ChatCompletionClient);
      const startedAt = Date.now();
      try {
        const response =
          onTextDelta && attemptApi.createStreamingChatCompletion
            ? await attemptApi.createStreamingChatCompletion(
                messages,
                attemptModel,
                options,
                onTextDelta,
              )
            : await attemptApi.createChatCompletion(
                messages,
                attemptModel,
                options,
              );
        const usage = response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
              cacheHitTokens: response.usage.prompt_cache_hit_tokens,
              cacheMissTokens: response.usage.prompt_cache_miss_tokens,
            }
          : undefined;
        this.recordModelUsage(attemptModel, mode, startedAt, true, usage);
        return response;
      } catch (error) {
        this.recordModelUsage(
          attemptModel,
          mode,
          startedAt,
          false,
          undefined,
          error,
        );
        lastError = error;
        if (
          !this.isRetryableModelError(error) ||
          index === attemptModels.length - 1
        )
          throw error;
        console.warn(
          `Tool-capable model ${attemptModel} failed; trying a configured tool-capable fallback.`,
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All configured tool-capable models failed");
  }

  protected getContextTTL(): number {
    return this.config.contextTTL;
  }

  protected resolveStaticProvider(
    model: string,
    config: AppConfig,
  ): StaticProviderId | null {
    if (config.openaiApiKey && config.openaiModels.includes(model))
      return "openai";
    if (config.googleModelKey && config.googleModels.includes(model))
      return "google";
    if (config.groqApiKey && config.groqModels.includes(model)) return "groq";
    if (config.claudeApiKey && config.claudeModels.includes(model))
      return "claude";
    if (config.azureApiKey && config.azureModels.includes(model))
      return "azure";
    return null;
  }

  protected createStaticProviderAPI(
    provider: StaticProviderId,
  ): ModelAPIInterface {
    switch (provider) {
      case "openai":
        return new OpenAIAPI(this.env);
      case "google":
        return new GeminiAPI(this.env);
      case "groq":
        return new GroqAPI(this.env);
      case "claude":
        return new ClaudeAPI(this.env);
      case "azure":
        return new AzureAPI(this.env);
    }
  }

  protected async getModelAPIForModel(
    model: string,
  ): Promise<ModelAPIInterface> {
    const provider = this.resolveStaticProvider(model, this.config);
    if (provider) {
      return this.createStaticProviderAPI(provider);
    }

    if (this.config.openaiCompatibleUrl) {
      const compatibleApi = new OpenAICompatibleAPI(this.env);
      const compatibleModels = await compatibleApi.getModels();
      if (compatibleModels.includes(model)) {
        return compatibleApi;
      }
    }

    throw new Error(`No valid API configuration found for model: ${model}`);
  }

  protected async initializeModelAPI(
    userId: string,
  ): Promise<ModelAPIInterface> {
    const currentModel = await this.getCurrentModel(userId);
    return await this.getModelAPIForModel(currentModel);
  }

  protected createSearchBroker(): SearchBroker {
    const searchProviderMap: Record<string, SearchProvider> = {
      exa: new ExaSearchAPI(this.env),
      openai: new OpenAIWebSearchProvider(this.env),
      gemini_grounding: new GeminiGroundingProvider(this.env),
    };
    const searchProviders = this.config.searchProviders
      .map((provider) => searchProviderMap[provider])
      .filter((provider): provider is SearchProvider => !!provider);
    return new SearchBroker(
      searchProviders,
      this.redis,
      (event) =>
        this.runBackground("recordSearchAttempt", () =>
          this.usageTracker.recordSearchCall(event.provider, event.success, {
            latencyMs: event.latencyMs,
            fallback: event.fallback,
            category: event.category,
          }),
        ),
      {
        exa: this.config.exaMonthlySearchCap,
        openai: this.config.openaiSearchMonthlyCap,
        gemini_grounding: this.config.geminiSearchMonthlyCap,
      },
      this.config.defaultTimezone,
    );
  }

  protected async generateChatResponse(
    messages: Message[],
    currentModel: string,
    sessionKey: string,
    chatId?: number,
    onTextDelta?: (delta: string) => Promise<void>,
    attemptedModels: Set<string> = new Set(),
    allowAgentJobs = true,
    allowMutatingTools = true,
  ): Promise<string> {
    attemptedModels.add(currentModel);
    const eodhdAPI = new EODHDAPI(this.env);
    const yahooFinanceAPI = new YahooFinanceAPI();
    const searchBroker = this.createSearchBroker();
    const wikipediaAPI = new WikipediaAPI();
    const canUseWebSearch = this.canUseWebSearch(searchBroker);
    const toolRegistry = new ToolRegistry(
      [
        {
          definition: WEB_SEARCH_TOOL,
          category: "search",
          isAvailable: () => canUseWebSearch,
          execute: (toolCall) =>
            this.runWebSearchTool(toolCall, searchBroker, sessionKey),
        },
        {
          definition: READ_URL_TOOL,
          category: "knowledge",
          isAvailable: () => true,
          execute: (toolCall, signal) =>
            this.runReadUrlTool(
              toolCall,
              new URLReader(),
              searchBroker,
              sessionKey,
              signal,
            ),
        },
        {
          definition: WIKIPEDIA_TOOL,
          category: "knowledge",
          isAvailable: () => true,
          execute: (toolCall, signal) =>
            runWikipediaTool(toolCall, wikipediaAPI, signal),
        },
        {
          definition: STOCK_QUOTE_TOOL,
          category: "finance",
          isAvailable: () => true,
          execute: (toolCall) =>
            runStockQuoteTool(toolCall, eodhdAPI, yahooFinanceAPI),
        },
        {
          definition: CALCULATOR_TOOL,
          category: "utility",
          isAvailable: () => true,
          execute: (toolCall) => runCalculatorTool(toolCall),
        },
        {
          definition: WEATHER_TOOL,
          category: "utility",
          isAvailable: () => true,
          execute: (toolCall, signal) => runWeatherTool(toolCall, signal),
        },
        {
          definition: CURRENCY_TOOL,
          category: "finance",
          isAvailable: () => true,
          execute: (toolCall, signal) => runCurrencyTool(toolCall, signal),
        },
        {
          definition: GITHUB_TOOL,
          category: "knowledge",
          isAvailable: () => true,
          execute: (toolCall, signal) =>
            runGitHubTool(toolCall, this.config.githubToken, signal),
        },
        {
          definition: ARXIV_TOOL,
          category: "knowledge",
          isAvailable: () => true,
          execute: (toolCall, signal) => runArxivTool(toolCall, signal),
        },
        {
          definition: REMINDER_TOOL,
          category: "utility",
          isAvailable: () => allowMutatingTools && chatId !== undefined,
          execute: (toolCall) =>
            this.runReminderTool(toolCall, sessionKey, chatId!),
        },
        {
          definition: MEMORY_TOOL,
          category: "memory",
          isAvailable: () => allowMutatingTools,
          execute: (toolCall) => this.runMemoryTool(toolCall, sessionKey),
        },
      ],
      15_000,
    );

    if (!this.isToolCapableModel(currentModel)) {
      return this.generateTrackedResponse(
        this.modelAPI,
        messages,
        currentModel,
        "chat",
      );
    }

    const tools = toolRegistry.getDefinitions();
    if (tools.length === 0) {
      return this.generateTrackedResponse(
        this.modelAPI,
        messages,
        currentModel,
        "chat",
      );
    }

    const toolEnabledMessages: Message[] = [
      ...messages.slice(0, 1),
      { role: "system", content: this.getToolsInstruction() },
      ...messages.slice(1),
    ];

    try {
      if (this.config.googleModels.includes(currentModel)) {
        const geminiAPI = new GeminiAPI(this.env);
        const startedAt = Date.now();
        try {
          const result = await geminiAPI.generateResponseWithToolsAndMetadata(
            toolEnabledMessages,
            tools,
            (toolCall) => toolRegistry.execute(toolCall),
            currentModel,
            onTextDelta,
          );
          this.recordModelUsage(
            currentModel,
            "chat_tools",
            startedAt,
            true,
            result.usage,
            undefined,
            result.resolvedModel,
          );
          return result.content;
        } catch (error) {
          this.recordModelUsage(
            currentModel,
            "chat_tools",
            startedAt,
            false,
            undefined,
            error,
          );
          throw error;
        }
      }

      const chatCompletionAPI = this.config.openaiCompatibleModels.includes(
        currentModel,
      )
        ? new OpenAICompatibleAPI(this.env)
        : new OpenAIAPI(this.env);
      const requestMessages: Message[] = [...toolEnabledMessages];
      let completedToolRounds = 0;
      while (true) {
        const completion = await this.createTrackedChatCompletion(
          chatCompletionAPI,
          requestMessages,
          currentModel,
          "chat_tools",
          { tools, toolChoice: "auto" },
          onTextDelta,
        );
        const assistantMessage = completion.choices[0]?.message;
        if (!assistantMessage)
          throw new Error(
            "Tool-assisted response did not return an assistant message",
          );

        const toolCalls = assistantMessage.tool_calls || [];
        if (toolCalls.length === 0) {
          const content = assistantMessage.content?.trim();
          if (!content)
            throw new Error("Tool-assisted response returned no final content");
          return content;
        }
        if (completedToolRounds >= RUNTIME_BUDGETS.maxToolRounds) {
          throw new Error(
            "Tool-assisted response exceeded maximum function-calling rounds",
          );
        }

        const toolResults = await Promise.all(
          toolCalls.map((call) => toolRegistry.execute(call)),
        );
        requestMessages.push(
          {
            role: "assistant",
            content: assistantMessage.content || "",
            tool_calls: assistantMessage.tool_calls,
          },
          ...toolResults,
        );
        completedToolRounds += 1;
      }
    } catch (error) {
      console.error(
        `Tool-assisted response failed for ${currentModel}:`,
        error,
      );
      for (const fallbackModel of this.getModelFallbackCandidates(
        currentModel,
        "chat_tools",
        true,
      )) {
        if (attemptedModels.has(fallbackModel)) continue;
        try {
          return await this.generateChatResponse(
            messages,
            fallbackModel,
            sessionKey,
            chatId,
            onTextDelta,
            attemptedModels,
            allowAgentJobs,
            allowMutatingTools,
          );
        } catch (fallbackError) {
          console.error(
            `Tool-capable fallback failed for ${fallbackModel}:`,
            fallbackError,
          );
        }
      }

      console.error(
        "All tool-capable models failed; falling back to a text-only response.",
      );
      return await this.generateTrackedResponse(
        this.modelAPI,
        messages,
        currentModel,
        "chat",
      );
    }
  }

  protected isToolCapableModel(currentModel: string): boolean {
    return (
      this.config.openaiModels.includes(currentModel) ||
      this.config.googleModels.includes(currentModel) ||
      this.config.openaiCompatibleModels.includes(currentModel)
    );
  }

  protected buildChatMessages(inputs: {
    promptState: PromptState;
    promptText: string;
    replyContext: string | null;
    includeCurrentDateTime: boolean;
  }): Message[] {
    const currentSubjectHint = this.buildCurrentSubjectHint(
      inputs.promptState.recentTurns,
      inputs.promptText,
      inputs.replyContext,
    );
    const relevantMemory = selectRelevantPromptMemory({
      promptText: inputs.promptText,
      replyContext: inputs.replyContext,
      personCards: inputs.promptState.personCards,
      seenMembers: inputs.promptState.seenMembers,
      activeTopics: inputs.promptState.activeTopics,
      ambientMessages: inputs.promptState.botSettings.ambientMemory
        ? inputs.promptState.ambientMessages
        : [],
      durableMemories: inputs.promptState.durableMemories || [],
    });
    const stableMemoryBlock = buildStableMemoryBlock({
      groupProfile: inputs.promptState.groupProfile,
      personCards: relevantMemory.personCards,
      conversationSummary: inputs.promptState.conversationSummary,
      durableMemories: relevantMemory.durableMemories,
    });
    const volatileContextBlock = buildVolatileContextBlock({
      seenMembers: relevantMemory.seenMembers,
      activeTopics: relevantMemory.activeTopics,
      ambientMessages: relevantMemory.ambientMessages,
      replyContext: inputs.replyContext,
      currentSubjectHint,
    });

    return buildPromptLayout({
      soul: this.soulMessage,
      baseInstructions: this.systemMessage,
      replyStyle: this.getReplyStyleInstruction(
        inputs.promptState.botSettings.replyStyle,
      ),
      stableMemory: stableMemoryBlock,
      recentTurns: inputs.promptState.recentTurns,
      volatileContext: volatileContextBlock,
      dateTimeContext: inputs.includeCurrentDateTime
        ? this.getCurrentDateTimeInstruction(inputs.promptText)
        : null,
      userMessage: inputs.promptText,
    });
  }

  protected buildCurrentSubjectHint(
    recentTurns: MemoryTurn[],
    promptText: string,
    replyContext: string | null,
  ): string | null {
    if (!this.hasAmbiguousFollowUpReference(promptText)) {
      return null;
    }

    const sourceTexts = [
      replyContext,
      ...recentTurns.slice(-6).map((turn) => turn.content),
    ].filter((text): text is string => !!text);

    const subject = this.extractLikelySubject(sourceTexts);
    if (!subject) {
      return null;
    }

    return [
      `Likely current subject from the immediate thread: ${subject}.`,
      "Resolve pronouns such as they, their, it, and this from the immediate thread first.",
      "Treat older group memory, active topics, and ambient chatter as background only if they conflict.",
    ]
      .join(" ")
      .slice(0, TelegramBotBase.MAX_SUBJECT_HINT_CHARS);
  }

  protected hasAmbiguousFollowUpReference(text: string): boolean {
    return (
      /\b(they|them|their|theirs|it|its|this|that|these|those)\b/i.test(text) &&
      !this.extractLikelySubject([text])
    );
  }

  protected extractLikelySubject(texts: string[]): string | null {
    const candidates = new Map<string, number>();
    const stopPhrases = new Set([
      "Group",
      "Assistant",
      "User",
      "Current",
      "Recent",
      "Memory",
      "Live",
      "Wikipedia",
      "Stock",
      "Not",
      "The",
      "They",
      "So",
      "But",
      "Add",
    ]);

    for (const text of texts.slice().reverse()) {
      const cleaned = text
        .replace(/\[[^\]]+\]/g, " ")
        .replace(/@\w+/g, " ")
        .replace(/\b[A-Z]{2,5}\d{0,2}\b/g, " ");
      const matches =
        cleaned.match(
          /\b[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3}\b/g,
        ) || [];
      for (const rawMatch of matches) {
        const candidate = rawMatch.trim().replace(/[.,:;!?)]$/, "");
        if (
          candidate.length < 3 ||
          stopPhrases.has(candidate) ||
          /^(I|You|We|He|She|It|This|That|There|Here|What|Why|When|Where|How)$/i.test(
            candidate,
          )
        ) {
          continue;
        }
        const hasCompanySignal =
          /\b(Semiconductors?|Photonics?|Systems?|Technologies?|Corporation|Corp|Inc|Ltd|AB|AG|NV|PLC|Group|Holdings?)\b/.test(
            candidate,
          );
        const score = hasCompanySignal ? 4 : candidate.split(/\s+/).length;
        candidates.set(candidate, (candidates.get(candidate) || 0) + score);
      }
    }

    return (
      [...candidates.entries()].sort(
        (left, right) => right[1] - left[1] || right[0].length - left[0].length,
      )[0]?.[0] || null
    );
  }

  protected getLatestUserMessageContent(messages: Message[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "user" && typeof message.content === "string") {
        return message.content;
      }
    }
    return "";
  }

  protected selectToolNames(text: string, canUseWebSearch: boolean): string[] {
    const selected: string[] = [];
    if (canUseWebSearch && this.shouldForceWebSearch(text)) {
      selected.push("web_search");
    }
    if (this.shouldForceWikipediaLookup(text)) {
      selected.push("wikipedia_lookup");
    }
    if (selected.length === 0) {
      if (
        canUseWebSearch &&
        /\b(latest|current|today|now|recent|news|price|weather|score|release|update)\b/i.test(
          text,
        )
      ) {
        selected.push("web_search");
      } else {
        selected.push("wikipedia_lookup");
      }
    }
    return selected;
  }

  protected shouldForceStockQuoteLookup(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return (
      /\b(prices?|stock prices?|share prices?|quote|ticker|market cap)\b/i.test(
        normalized,
      ) &&
      (/\b(now|right now|current|currently|latest|today|live|check|recent|recently|this week|this month)\b/i.test(
        normalized,
      ) ||
        /\$[a-z]{1,10}(?:\.[a-z]{1,8})?\b/i.test(text))
    );
  }

  protected shouldForceWebSearch(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const financePrompt =
      /\b(prices?|stock prices?|share prices?|quote|ticker|market cap)\b/i.test(
        normalized,
      ) &&
      (/\b(now|right now|current|currently|latest|today|live|check|recent|recently|this week|this month)\b/i.test(
        normalized,
      ) ||
        /\$[a-z]{1,10}\b/i.test(text));
    const currentEventsPrompt =
      /\b(news|breaking|latest|today|what happened|weather|forecast|score|result|results)\b/i.test(
        normalized,
      ) &&
      /\b(now|right now|current|currently|latest|today|live|breaking)\b/i.test(
        normalized,
      );
    const explicitWebPrompt =
      /\b(google|find online|check online|web search|use (?:your )?search(?: tool)?)\b/i.test(
        normalized,
      );
    const genericLookupWithWebSignals =
      /\b(search|look up|lookup)\b/i.test(normalized) &&
      /\b(latest|current|today|tonight|yesterday|recent|breaking|news|happened|situation|instagram|post|tweet|twitter|x\.com|tiktok|reddit|article|source|sources)\b/i.test(
        normalized,
      );

    return (
      financePrompt ||
      currentEventsPrompt ||
      explicitWebPrompt ||
      genericLookupWithWebSignals
    );
  }

  protected shouldForceWikipediaLookup(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (/\b(wikipedia|wiki)\b/i.test(normalized)) {
      return true;
    }

    const stableLookupPrompt = [
      /^(who|what|when|where)\s+(is|was|are|were)\b/i,
      /^(tell me about|define|history of|bio of|biography of)\b/i,
      /\b(look up|lookup|search)\b/i,
    ].some((pattern) => pattern.test(normalized));
    const webOrCurrentSignals =
      /\b(latest|current|today|tonight|tomorrow|yesterday|now|recent|breaking|news|weather|forecast|score|result|results|price|stock|market|version|release|update|happened|situation|instagram|post|tweet|twitter|x\.com|tiktok|reddit|article|source|sources|google|online|web search|search tool)\b/i.test(
        normalized,
      );

    return stableLookupPrompt && !webOrCurrentSignals;
  }

  protected buildForcedWebSearchQuery(text: string): string {
    const trimmed = text.trim();
    if (/\$[a-z]{1,10}\b/i.test(trimmed)) {
      return `${trimmed} stock price`;
    }
    return trimmed;
  }

  protected buildContextAwareWebSearchQuery(
    text: string,
    messages: Message[],
  ): string {
    const trimmed = text.trim();
    if (
      !this.hasAmbiguousFollowUpReference(trimmed) ||
      /\$[a-z]{1,10}\b/i.test(trimmed)
    ) {
      return this.buildForcedWebSearchQuery(trimmed);
    }

    const previousMessages = messages
      .slice(0, -1)
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .filter(Boolean);
    const subject = this.extractLikelySubject(previousMessages);
    if (!subject) {
      return this.buildForcedWebSearchQuery(trimmed);
    }

    return `${subject} ${trimmed}`;
  }

  protected async generateGroundedLiveResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    searchBroker: SearchBroker,
    sessionKey: string,
  ): Promise<string | null> {
    const toolCall: ToolCall = {
      id: crypto.randomUUID(),
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({
          query: this.buildContextAwareWebSearchQuery(
            latestUserMessage,
            messages,
          ),
        }),
      },
    };

    const toolResult = await this.runWebSearchTool(
      toolCall,
      searchBroker,
      sessionKey,
    );
    const searchContent =
      typeof toolResult.content === "string" ? toolResult.content.trim() : "";
    if (!searchContent || searchContent.startsWith("Web search failed:")) {
      return null;
    }

    const groundedMessages: Message[] = [
      ...messages,
      {
        role: "system",
        content: [
          "Live web search results for the latest user request are attached below.",
          "Use them as the factual grounding for any current or recent claims.",
          "If they are thin or ambiguous, say so briefly instead of inventing details.",
          "Answer directly and keep it concise.",
          `Live web search results:\n${searchContent}`,
        ].join(" "),
      },
    ];

    return await this.generateTrackedResponse(
      this.modelAPI,
      groundedMessages,
      currentModel,
      "chat_tools",
    );
  }

  protected buildForcedWikipediaQuery(text: string): string {
    return text
      .trim()
      .replace(
        /\b(?:look up|lookup|search|find|tell me about|on wikipedia|wikipedia|wiki)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  protected async generateGroundedWikipediaResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    wikipediaAPI: WikipediaAPI,
  ): Promise<string | null> {
    const query =
      this.buildForcedWikipediaQuery(latestUserMessage) ||
      latestUserMessage.trim();
    const toolCall: ToolCall = {
      id: crypto.randomUUID(),
      type: "function",
      function: {
        name: "wikipedia_lookup",
        arguments: JSON.stringify({ query }),
      },
    };

    const toolResult = await runWikipediaTool(toolCall, wikipediaAPI);
    const wikipediaContent =
      typeof toolResult.content === "string" ? toolResult.content.trim() : "";
    if (
      !wikipediaContent ||
      wikipediaContent.startsWith("Wikipedia lookup failed:")
    ) {
      return null;
    }

    const groundedMessages: Message[] = [
      ...messages,
      {
        role: "system",
        content: [
          "Wikipedia lookup results for the latest user request are attached below.",
          "Use them as factual grounding for stable encyclopedia-style claims.",
          "If the result looks like the wrong subject or a disambiguation, say so briefly.",
          "Answer directly and keep it concise.",
          `Wikipedia lookup results:\n${wikipediaContent}`,
        ].join(" "),
      },
    ];

    return await this.generateTrackedResponse(
      this.modelAPI,
      groundedMessages,
      currentModel,
      "chat_tools",
    );
  }

  protected async generateGroundedStockResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    eodhdAPI: EODHDAPI,
  ): Promise<string | null> {
    try {
      const quoteContent = await eodhdAPI.lookupStockQuote(latestUserMessage);
      const groundedMessages: Message[] = [
        ...messages,
        {
          role: "system",
          content: [
            "A dedicated stock quote lookup result is attached below.",
            "Use it as the factual grounding for any price or market-cap claims in your reply.",
            "If the user mainly asked for the current price, lead with the price and keep it brief.",
            "Do not invent extra market data beyond the attached lookup.",
            `Stock quote lookup:\n${quoteContent}`,
          ].join(" "),
        },
      ];

      return await this.generateTrackedResponse(
        this.modelAPI,
        groundedMessages,
        currentModel,
        "chat_tools",
      );
    } catch (error) {
      console.error("Dedicated EODHD stock quote lookup failed:", error);
      return null;
    }
  }

  protected async generateGroundedYahooStockResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    yahooFinanceAPI: YahooFinanceAPI,
  ): Promise<string | null> {
    try {
      const lookupQuery = this.buildContextAwareWebSearchQuery(
        latestUserMessage,
        messages,
      );
      const quoteContent = await yahooFinanceAPI.lookupStockQuote(lookupQuery);
      const groundedMessages: Message[] = [
        ...messages,
        {
          role: "system",
          content: [
            "A Yahoo Finance stock quote lookup result is attached below.",
            "Use it as the factual grounding for stock price, market-cap, volume, valuation, and trading-session claims in your reply.",
            "If the user mainly asked for the current price or recent move, lead with the quote data and keep it brief.",
            "Do not invent extra market data beyond the attached lookup.",
            `Yahoo Finance lookup:\n${quoteContent}`,
          ].join(" "),
        },
      ];

      return await this.generateTrackedResponse(
        this.modelAPI,
        groundedMessages,
        currentModel,
        "chat_tools",
      );
    } catch (error) {
      console.error("Yahoo Finance stock quote lookup failed:", error);
      return null;
    }
  }

  protected shouldIncludeCurrentDateTime(
    text: string,
    _toolMode: boolean = false,
  ): boolean {
    return /\b(time|date|day|today|tonight|tomorrow|yesterday|now|current|latest|recent|this week|this month)\b/i.test(
      text,
    );
  }

  protected canUseWebSearch(searchBroker: SearchBroker): boolean {
    return searchBroker.isConfigured();
  }

  protected getToolsInstruction(): string {
    return [
      "Operate in a bounded observe-act-observe loop: decide whether a tool is needed, inspect its result, and continue until the request is actually complete.",
      "Own the information-gathering step when a missing fact materially affects the answer.",
      "Use web_search for current, recent, niche, or uncertain facts; read_url for a user-supplied page; wikipedia_lookup for stable encyclopedic facts; stock_quote for live market quotes; and the specialist utility tools for calculations, weather, currency, GitHub, papers, reminders, and saved memory.",
      "Use no tool when the request is conversational, opinion-based, creative, or answerable confidently from the supplied context.",
      "Do not call tools speculatively or repeat a lookup that already produced enough evidence.",
      "Do not ask the user to paste facts or do the lookup when an available tool can retrieve them.",
      "If a tool fails or returns thin evidence, inspect the failure and try one sensible alternative when available.",
      "Before the final answer, silently check that every requested lookup or action succeeded; never claim an action succeeded without a successful tool result.",
      "Only create, cancel, remember, or forget something when the user clearly asked for that state change.",
      "When the user asks for a specific filing, document, or deep link, return the exact verified page instead of a generic portal.",
      "When you use a tool, do it silently and answer directly.",
      "Do not mention tool calls, searching, lookups, or sources unless the user explicitly asks.",
      'Do not say things like "based on the latest reporting" or "according to Wikipedia".',
      'Do not dump links, citations, or a "Sources" section by default.',
      "If the results are thin or conflicting, say so briefly instead of faking certainty.",
    ].join(" ");
  }

  protected async runWebSearchTool(
    toolCall: ToolCall,
    searchBroker: SearchBroker,
    sessionKey: string,
  ): Promise<Message> {
    const fallback = (error: string): Message => ({
      role: "tool",
      tool_call_id: toolCall.id,
      content: `Web search failed: ${error}`,
    });

    const parsedArgs = (() => {
      try {
        return JSON.parse(toolCall.function.arguments || "{}") as {
          query?: string;
        };
      } catch {
        return {} as { query?: string };
      }
    })();
    const query = parsedArgs.query?.trim();
    if (!query) {
      return fallback("Missing query.");
    }

    try {
      const response = await searchBroker.search(query);
      await this.saveLastSources(sessionKey, response);
      const results = formatSearchResponseForModel(response, 3_500);
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: results,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown web search error.";
      console.error("Error executing web search tool:", error);
      return fallback(message);
    }
  }

  protected async runReadUrlTool(
    toolCall: ToolCall,
    reader: URLReader,
    searchBroker: SearchBroker,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<Message> {
    const fallback = (error: string): Message => ({
      role: "tool",
      tool_call_id: toolCall.id,
      content: `URL read failed: ${error}`,
    });
    const parsedArgs = (() => {
      try {
        return JSON.parse(toolCall.function.arguments || "{}") as {
          url?: string;
        };
      } catch {
        return {} as { url?: string };
      }
    })();
    const rawUrl = parsedArgs.url?.trim();
    if (!rawUrl) return fallback("Missing URL.");

    let url: string;
    try {
      url = reader.validateUrl(rawUrl).toString();
    } catch (error) {
      return fallback(error instanceof Error ? error.message : "Invalid URL.");
    }

    try {
      const page = await reader.read(url, signal);
      await this.saveLastSources(sessionKey, {
        provider: "url_reader",
        query: url,
        searchedAt: new Date().toISOString(),
        sources: [{ title: page.title || page.url, url: page.url }],
      });
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: `PAGE: ${page.title || page.url}\nURL: ${page.url}\nCONTENT:\n${page.text.slice(0, 3_500)}`,
      };
    } catch (readError) {
      if (searchBroker.isConfigured()) {
        try {
          const response = await searchBroker.search(`\"${url}\"`);
          await this.saveLastSources(sessionKey, response);
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Direct page reading was blocked. Indexed web evidence follows.\n${formatSearchResponseForModel(response, 3_500)}`,
          };
        } catch (searchError) {
          console.error(
            "Error recovering a blocked URL through web search:",
            searchError,
          );
        }
      }
      const message =
        readError instanceof Error
          ? readError.message
          : "Unknown URL reader error.";
      console.error("Error executing URL reader tool:", readError);
      return fallback(message);
    }
  }

  protected getCurrentDateString(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.config.defaultTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  protected getCurrentDateTimeInstruction(promptText: string): string {
    const asksForClockTime = /\b(time|what time|right now)\b/i.test(promptText);
    const timezone = this.config.defaultTimezone;
    const now = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(asksForClockTime
        ? {
            hour: "2-digit" as const,
            minute: "2-digit" as const,
            hour12: false,
          }
        : {}),
    }).format(new Date());

    return asksForClockTime
      ? `Current local date and time is ${now} in ${timezone}. Use this timezone unless the user explicitly asks for another timezone.`
      : `Current local date is ${now} in ${timezone}. Use this date for current, recent, and relative-date questions.`;
  }

  protected async runReminderTool(
    toolCall: ToolCall,
    sessionKey: string,
    chatId: number,
  ): Promise<Message> {
    const args = parseToolArguments<{
      action?: string;
      schedule?: string;
      text?: string;
      id?: string;
    }>(toolCall);
    try {
      if (args.action === "create") {
        const schedule = args.schedule?.trim();
        const text = args.text?.trim();
        if (!schedule || !text)
          return toolFailure(
            toolCall,
            "Reminder action",
            "Create requires schedule and text.",
          );
        return toolSuccess(
          toolCall,
          await this.addReminder(chatId, sessionKey, `${schedule} ${text}`),
        );
      }
      if (args.action === "list") {
        return toolSuccess(
          toolCall,
          (await this.listReminders(sessionKey)) ||
            "No reminders are scheduled.",
        );
      }
      if (args.action === "cancel") {
        if (!args.id?.trim())
          return toolFailure(
            toolCall,
            "Reminder action",
            "Cancel requires a reminder ID.",
          );
        const removed = await this.removeReminder(sessionKey, args.id);
        return removed
          ? toolSuccess(toolCall, `Cancelled reminder ${args.id}: ${removed}`)
          : toolFailure(
              toolCall,
              "Reminder action",
              `No reminder found with ID ${args.id}.`,
            );
      }
      return toolFailure(toolCall, "Reminder action", "Unknown action.");
    } catch (error) {
      return toolFailure(
        toolCall,
        "Reminder action",
        error instanceof Error ? error.message : "Reminder action failed.",
      );
    }
  }

  protected async runMemoryTool(
    toolCall: ToolCall,
    sessionKey: string,
  ): Promise<Message> {
    const args = parseToolArguments<{ action?: string; text?: string }>(
      toolCall,
    );
    const text = args.text?.trim();
    if (!text)
      return toolFailure(
        toolCall,
        "Memory action",
        "Missing memory text or query.",
      );
    try {
      if (args.action === "remember") {
        const id = await this.rememberDurableMemory(sessionKey, text);
        return toolSuccess(toolCall, `Saved durable memory ${id}.`);
      }
      if (args.action === "recall") {
        return toolSuccess(
          toolCall,
          (await this.recallDurableMemory(sessionKey, text)) ||
            "No matching durable memory found.",
        );
      }
      if (args.action === "forget") {
        const removed = await this.forgetSavedMemory(sessionKey, text);
        return removed
          ? toolSuccess(toolCall, `Forgot ${removed}.`)
          : toolFailure(
              toolCall,
              "Memory action",
              "No single matching memory found. Ask the user to identify the exact memory or ID.",
            );
      }
      return toolFailure(toolCall, "Memory action", "Unknown action.");
    } catch (error) {
      return toolFailure(
        toolCall,
        "Memory action",
        error instanceof Error ? error.message : "Memory action failed.",
      );
    }
  }

  protected async runAgentJobTool(
    toolCall: ToolCall,
    sessionKey: string,
    chatId: number,
  ): Promise<Message> {
    const args = parseToolArguments<{
      action?: string;
      goal?: string;
      id?: string;
    }>(toolCall);
    try {
      if (args.action === "create") {
        const goal = args.goal?.trim();
        if (!goal)
          return toolFailure(
            toolCall,
            "Agent job action",
            "Create requires a self-contained goal.",
          );
        const run = await this.createAgentRun(chatId, sessionKey, goal);
        return toolSuccess(
          toolCall,
          `Queued background agent job ${run.id}. It will normally start on the next five-minute cron wake.`,
        );
      }
      if (args.action === "list") {
        return toolSuccess(
          toolCall,
          (await this.listAgentRuns(sessionKey)) ||
            "No background agent jobs found.",
        );
      }
      if (args.action === "cancel") {
        if (!args.id?.trim())
          return toolFailure(
            toolCall,
            "Agent job action",
            "Cancel requires an agent job ID.",
          );
        const run = await this.cancelAgentRun(sessionKey, args.id);
        if (run) {
          await this.publishAgentRunTransition(
            new AgentRunStore(this.redis),
            run,
          ).catch((error) =>
            console.error(
              `Failed to publish cancelled agent job ${run.id}:`,
              error,
            ),
          );
        }
        return run
          ? toolSuccess(toolCall, `Cancelled background agent job ${run.id}.`)
          : toolFailure(
              toolCall,
              "Agent job action",
              `No active agent job found with ID ${args.id}.`,
            );
      }
      return toolFailure(toolCall, "Agent job action", "Unknown action.");
    } catch (error) {
      return toolFailure(
        toolCall,
        "Agent job action",
        error instanceof Error ? error.message : "Agent job action failed.",
      );
    }
  }

  protected getSummaryModel(currentModel: string): string {
    return this.getRoleModel("summary", currentModel);
  }

  protected getRoleModel(role: ModelRole, fallbackModel: string): string {
    const configuredByRole: Record<ModelRole, string | undefined> = {
      utility: this.config.utilityModel,
      summary: this.config.summaryModel,
      research: this.config.researchModel,
      vision: this.config.visionModel,
    };
    const configured = configuredByRole[role];
    if (
      role === "vision" &&
      (!configured || configured.toLowerCase() === "auto")
    ) {
      if (
        this.config.visionModels.includes(fallbackModel) &&
        this.isConfiguredModel(fallbackModel)
      ) {
        return fallbackModel;
      }
      const availableVisionModel = this.config.visionModels.find((model) =>
        this.isConfiguredModel(model),
      );
      if (availableVisionModel) return availableVisionModel;
      console.warn(
        `No configured model in VISION_MODELS is available. Falling back to ${fallbackModel}.`,
      );
      return fallbackModel;
    }
    if (!configured) return fallbackModel;
    const normalized = this.normalizeModelName(configured);
    if (
      this.isConfiguredModel(normalized) &&
      (role !== "vision" ||
        this.config.visionModels.length === 0 ||
        this.config.visionModels.includes(normalized))
    ) {
      return normalized;
    }
    console.warn(
      `Configured ${role} model "${configured}" is not available. Falling back to ${fallbackModel}.`,
    );
    return fallbackModel;
  }

  protected async getMonthlyWebSearchUsage(): Promise<number> {
    const raw = await this.redis.get(this.getMonthlyWebSearchUsageKey());
    const parsed = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  protected getMonthlyWebSearchUsageKey(): string {
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.config.defaultTimezone,
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
    return `web_search_usage:${month}`;
  }

  protected async resolveCurrentModel(
    sessionKey: string,
    storedModel: string | null,
  ): Promise<string> {
    if (storedModel) {
      const normalizedModel = this.normalizeModelName(storedModel);
      if (normalizedModel !== storedModel) {
        await this.redis.set(`model:${sessionKey}`, normalizedModel);
      }

      if (this.isConfiguredModel(normalizedModel)) {
        return normalizedModel;
      }

      console.warn(
        `Stored model "${storedModel}" is no longer configured. Falling back to default model.`,
      );
    }

    if (this.config.defaultModel) {
      const normalizedDefault = this.normalizeModelName(
        this.config.defaultModel,
      );
      if (this.isConfiguredModel(normalizedDefault)) {
        return normalizedDefault;
      }
    }

    if (this.config.openaiModels.length > 0) return this.config.openaiModels[0];
    if (this.config.googleModels.length > 0) return this.config.googleModels[0];
    if (this.config.groqModels.length > 0) return this.config.groqModels[0];
    if (this.config.claudeModels.length > 0) return this.config.claudeModels[0];
    if (this.config.azureModels.length > 0) return this.config.azureModels[0];

    if (this.config.openaiCompatibleUrl) {
      const compatibleApi = new OpenAICompatibleAPI(this.env);
      const compatibleModels = await compatibleApi.getModels();
      if (compatibleModels.length === 0) {
        throw new Error("No OpenAI compatible models are available");
      }
      return compatibleModels[0];
    }

    throw new Error("No valid model configuration found");
  }

  async getCurrentModel(sessionKey: string): Promise<string> {
    try {
      const storedModel = await this.redis.get(`model:${sessionKey}`);
      return await this.resolveCurrentModel(sessionKey, storedModel);
    } catch (error) {
      console.error(
        "Redis model lookup unavailable; using configured default:",
        error,
      );
      return await this.resolveCurrentModel(sessionKey, null);
    }
  }

  protected isConfiguredModel(model: string): boolean {
    return [
      ...this.config.openaiModels,
      ...this.config.googleModels,
      ...this.config.groqModels,
      ...this.config.claudeModels,
      ...this.config.azureModels,
      ...this.config.openaiCompatibleModels,
    ].includes(model);
  }

  async setCurrentModel(sessionKey: string, model: string): Promise<void> {
    // `resolveCurrentModel` silently falls back to the default for anything
    // this rejects, so accepting it here would store a value that reads back
    // as a different model on the very next turn.
    const normalized = this.normalizeModelName(model);
    if (!this.isConfiguredModel(normalized)) {
      throw new Error(`"${model}" is not a configured model.`);
    }
    await this.redis.set(`model:${sessionKey}`, normalized);
    console.log(`Switching to model: ${normalized}`);
    this.modelAPI = await this.initializeModelAPI(sessionKey);
  }

  getAvailableModels(): string[] {
    return this.modelAPI.getAvailableModels();
  }

  isValidModel(model: string): boolean {
    return this.modelAPI.isValidModel(model);
  }

  /**
   * Only models that survive `isConfiguredModel` are offered. A model returned
   * by provider discovery but absent from `OPENAI_COMPATIBLE_MODELS` cannot be
   * kept — `resolveCurrentModel` reverts it on the next turn — so listing it
   * would offer a switch that silently undoes itself.
   */
  async getSelectableModels(): Promise<string[]> {
    const availableModels = [
      ...this.config.openaiModels,
      ...this.config.googleModels,
      ...this.config.groqModels,
      ...this.config.claudeModels,
      ...this.config.azureModels,
    ];
    if (this.config.openaiCompatibleUrl) {
      let discovered = this.config.openaiCompatibleModels;
      try {
        discovered = await new OpenAICompatibleAPI(this.env).getModels();
      } catch (error) {
        console.error(
          "Failed to load OpenAI-compatible models for picker:",
          error,
        );
      }
      const unlisted = discovered.filter(
        (model) => !this.isConfiguredModel(this.normalizeModelName(model)),
      );
      if (unlisted.length > 0) {
        console.warn(
          `Provider offers ${unlisted.length} model(s) missing from OPENAI_COMPATIBLE_MODELS; ` +
            `they cannot be selected until listed: ${unlisted.slice(0, 10).join(", ")}`,
        );
      }
      availableModels.push(...this.config.openaiCompatibleModels);
    }
    return [
      ...new Set(
        availableModels.filter((model) =>
          this.isConfiguredModel(this.normalizeModelName(model)),
        ),
      ),
    ];
  }

  recordModelOperation(
    model: string,
    mode: ModelRequestMode,
    startedAt: number,
    success: boolean,
    error?: unknown,
  ): void {
    this.recordModelUsage(model, mode, startedAt, success, undefined, error);
  }

  async getUsageReport(): Promise<string> {
    const [daily, monthly, monthlySearchUsage] = await Promise.all([
      this.usageTracker.getReport("day"),
      this.usageTracker.getReport("month"),
      this.getMonthlyWebSearchUsage(),
    ]);

    const format = (
      label: string,
      report: Awaited<ReturnType<UsageTracker["getReport"]>>,
    ): string => {
      const averageLatency =
        report.calls > 0 ? Math.round(report.totalLatencyMs / report.calls) : 0;
      return translateMessage("usage_period", {
        label,
        period: report.period,
        calls: report.calls,
        successes: report.successes,
        errors: report.errors,
        tokens: report.totalTokens,
        prompt: report.promptTokens,
        completion: report.completionTokens,
        average: averageLatency,
        p95: report.p95LatencyMs === null ? "n/a" : `${report.p95LatencyMs} ms`,
        searches: report.searchCalls,
      });
    };

    return [
      translateMessage("usage_title"),
      "",
      format(translateMessage("usage_today"), daily),
      "",
      format(translateMessage("usage_month"), monthly),
      "",
      translateMessage("usage_legacy_search", {
        used: monthlySearchUsage,
        cap: this.config.exaMonthlySearchCap,
      }),
    ].join("\n");
  }

  async getLastSources(sessionKey: string): Promise<string | null> {
    const raw = await this.redis.get(lastSourcesKey(sessionKey));
    if (!raw) return null;
    try {
      const response = JSON.parse(raw) as SearchResponse;
      if (!Array.isArray(response.sources) || response.sources.length === 0)
        return null;
      const sources = response.sources
        .slice(0, RUNTIME_BUDGETS.maxSources)
        .map((source, index) => {
          const hostname = (() => {
            try {
              return new URL(source.url).hostname;
            } catch {
              return "unknown host";
            }
          })();
          const published = source.publishedAt
            ? `; published ${source.publishedAt}`
            : "";
          return `${index + 1}. ${source.title} (${hostname}${published})\n${source.url}`;
        })
        .join("\n");
      return translateMessage("source_report", {
        query: response.query,
        provider: response.provider,
        sources,
      });
    } catch (error) {
      console.error("Failed to parse saved sources:", error);
      return null;
    }
  }

  async research(sessionKey: string, question: string): Promise<string> {
    const searchBroker = this.createSearchBroker();
    if (!searchBroker.isConfigured()) {
      throw new Error("No research search provider is configured");
    }

    const queries = this.buildResearchQueries(question);
    const searchResults = await Promise.allSettled(
      queries.map((query) => searchBroker.search(query, 6)),
    );
    const responses = searchResults
      .filter(
        (result): result is PromiseFulfilledResult<SearchResponse> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    await this.assertCurrentTaskActive(sessionKey);
    if (responses.length === 0) {
      throw new Error("Every research search failed");
    }

    const sources = this.rankResearchSources(
      responses.flatMap((response) => response.sources),
    );
    const pages = await Promise.allSettled(
      sources
        .slice(0, RUNTIME_BUDGETS.maxPagesRead)
        .map((source) => this.readPageWithTimeout(source.url)),
    );
    const pageEvidence = pages
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<URLReader["read"]>>
        > => result.status === "fulfilled",
      )
      .map(
        (result) =>
          `PAGE: ${result.value.title || result.value.url}\nURL: ${result.value.url}\n${result.value.text.slice(0, 8_000)}`,
      );
    await this.assertCurrentTaskActive(sessionKey);
    const searchEvidence = responses.map((response) =>
      formatSearchResponseForModel(response, 4_000),
    );
    const combinedResponse: SearchResponse = {
      provider: [
        ...new Set(responses.map((response) => response.provider)),
      ].join(", "),
      query: question,
      searchedAt: new Date().toISOString(),
      sources: sources.slice(0, RUNTIME_BUDGETS.maxSources),
    };
    await this.saveLastSources(sessionKey, combinedResponse);

    const selectedModel = await this.getCurrentModel(sessionKey);
    const currentModel = this.getRoleModel("research", selectedModel);
    const api = await this.getModelAPIForModel(currentModel);
    await this.assertCurrentTaskActive(sessionKey);
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "Produce a concise, evidence-grounded research answer.",
          "Prioritize primary and authoritative sources, distinguish facts from inference, and call out meaningful conflicts or weak evidence.",
          "Do not invent claims beyond the evidence. Do not add a separate source list because the application appends one.",
        ].join(" "),
      },
      {
        role: "user",
        content: `Research question:\n${question}\n\nEvidence:\n${[...searchEvidence, ...pageEvidence].join("\n\n").slice(0, 20_000)}`,
      },
    ];
    const answer = await this.generateTrackedResponse(
      api,
      messages,
      currentModel,
      "research",
    );
    const sourceList = sources
      .slice(0, 5)
      .map((source, index) => `${index + 1}. [${source.title}](${source.url})`)
      .join("\n");
    return `${answer}\n\n${translateMessage("research_sources")}\n${sourceList}`;
  }

  async readUrl(sessionKey: string, url: string): Promise<string> {
    const page = await this.readPageWithTimeout(url);
    await this.assertCurrentTaskActive(sessionKey);
    await Promise.all([
      this.saveLastSources(sessionKey, {
        provider: "url_reader",
        query: url,
        searchedAt: new Date().toISOString(),
        sources: [{ title: page.title || page.url, url: page.url }],
      }),
      this.redis.set(
        lastReadKey(sessionKey),
        JSON.stringify({
          ...page,
          text: page.text.slice(0, 12_000),
          savedAt: new Date().toISOString(),
        }),
        TelegramBotBase.LAST_SOURCES_TTL_SECONDS,
      ),
    ]);

    const selectedModel = await this.getCurrentModel(sessionKey);
    const currentModel = this.getRoleModel("research", selectedModel);
    const api = await this.getModelAPIForModel(currentModel);
    await this.assertCurrentTaskActive(sessionKey);
    return await this.generateTrackedResponse(
      api,
      [
        {
          role: "system",
          content:
            "Summarize the supplied webpage accurately and concisely. Identify the main point, important details, and any obvious limitations. Do not invent missing content.",
        },
        {
          role: "user",
          content: `URL: ${page.url}\nTitle: ${page.title || "Unknown"}\n\nPage text:\n${page.text.slice(0, 18_000)}`,
        },
      ],
      currentModel,
      "research",
    );
  }

  async compareModels(sessionKey: string, question: string): Promise<string> {
    const selectedModel = await this.getCurrentModel(sessionKey);
    const candidates = [
      ...new Set([
        selectedModel,
        this.getRoleModel("utility", selectedModel),
        this.getRoleModel("research", selectedModel),
      ]),
    ].slice(0, 2);
    if (candidates.length < 2) {
      throw new Error(
        "Configure UTILITY_MODEL or RESEARCH_MODEL to a different available model",
      );
    }

    const responses = await Promise.allSettled(
      candidates.map(async (model) => {
        const api = await this.getModelAPIForModel(model);
        const content = await this.generateTrackedResponse(
          api,
          [
            {
              role: "system",
              content:
                "Answer the user directly and independently. Be concise, accurate, and do not refer to another model response.",
            },
            { role: "user", content: question },
          ],
          model,
          "compare",
        );
        return { model, content };
      }),
    );

    const successful = responses
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          model: string;
          content: string;
        }> => result.status === "fulfilled",
      )
      .map((result) => result.value);
    await this.assertCurrentTaskActive(sessionKey);
    if (successful.length === 0)
      throw new Error("Both comparison models failed");
    return successful
      .map((result) => `## ${result.model}\n${result.content}`)
      .join("\n\n");
  }

  protected buildResearchQueries(question: string): string[] {
    const trimmed = question.trim();
    const currentSignals = /\b(latest|current|today|recent|news|now)\b/i.test(
      trimmed,
    );
    return [
      ...new Set([
        trimmed,
        `${trimmed} primary sources`,
        `${trimmed} ${currentSignals ? this.getCurrentDateString() : "analysis evidence"}`,
      ]),
    ].slice(0, 3);
  }

  protected rankResearchSources(sources: SearchSource[]): SearchSource[] {
    const seen = new Set<string>();
    return sources
      .filter((source) => {
        if (seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      })
      .map((source, index) => ({
        source,
        score:
          (source.snippet ? 3 : 0) +
          (source.publishedAt ? 2 : 0) +
          (/\.(gov|edu)(\/|$)/i.test(source.url) ? 4 : 0) -
          index * 0.01,
      }))
      .sort((left, right) => right.score - left.score)
      .map((item) => item.source)
      .slice(0, RUNTIME_BUDGETS.maxSources);
  }

  protected async readPageWithTimeout(
    url: string,
  ): Promise<Awaited<ReturnType<URLReader["read"]>>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      return await new URLReader().read(url, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  protected async saveLastSources(
    sessionKey: string,
    response: SearchResponse,
  ): Promise<void> {
    await this.redis.set(
      lastSourcesKey(sessionKey),
      JSON.stringify({
        ...response,
        sources: response.sources.slice(0, RUNTIME_BUDGETS.maxSources),
      }),
      TelegramBotBase.LAST_SOURCES_TTL_SECONDS,
    );
  }

  async runTextShortcut(
    sessionKey: string,
    task: "translate" | "rewrite" | "summarize",
    text: string,
    target?: string,
  ): Promise<string> {
    const selectedModel = await this.getCurrentModel(sessionKey);
    const model = this.getRoleModel("utility", selectedModel);
    const api = await this.getModelAPIForModel(model);
    const instruction =
      task === "translate"
        ? `Translate the user text into ${target || "English"}. Preserve meaning, tone, names, formatting, and URLs. Return only the translation.`
        : task === "rewrite"
          ? "Rewrite the user text to be clearer and more natural while preserving its meaning and language. Return only the rewritten text."
          : "Summarize the user text concisely. Preserve important facts, decisions, dates, and action items. Return only the summary.";
    return await this.generateTrackedResponse(
      api,
      [
        { role: "system", content: instruction },
        { role: "user", content: text.slice(0, 20_000) },
      ],
      model,
      "utility",
    );
  }
}

export default TelegramChatExecutionBot;
