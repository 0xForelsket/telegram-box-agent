import { Env, getConfig } from "../../env";
import { TelegramTypes } from "../../../types/telegram";
import OpenAIAPI from "../openai_api";
import {
  ChatCompletionResponse,
  Message,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../chat_types";
import { translate } from "../../utils/i18n";
import { commands } from "../../config/commands";
import { RedisClient } from "../../utils/redis";
import { ModelAPIInterface, ModelUsage } from "../model_api_interface";
import EODHDAPI from "../eodhd";
import YahooFinanceAPI from "../yahoo_finance";
import WikipediaAPI from "../wikipedia";
import { soulMessage } from "../../generated/soul";
import {
  BotSettings,
  Command,
  TelegramCommandBot,
  TelegramStatus,
} from "../../config/command_types";
import { ModelRequestMode, UsageTracker } from "../../utils/usage_tracker";
import { SearchBroker } from "../../search/search_broker";
import { ScheduledJob } from "../../scheduling/scheduler";
import { TelegramTransport } from "../../telegram/transport";
import { SearchResponse, SearchSource } from "../../search/types";
import { URLReader } from "../../web/url_reader";
import {
  AgentRun,
  AgentRunStore,
  AgentWakeResult,
} from "../../agent/agent_run_store";
import { BoxJobService } from "../../agent/box/box_job_service";
import type { BoxJob } from "../../agent/box/box_job_store";
import type { BoxRouteDecision } from "../../agent/box/hybrid_router";
import { ArtifactGateway } from "../../agent/box/artifact_gateway";
import { BoxScheduleService } from "../../agent/box/box_schedule_service";
import type { PromptFiles } from "@upstash/box";
import { DurableMemory } from "../../memory/durable_memory";
import {
  type ActiveTopic,
  type PersonCard,
  type SeenMember,
} from "../../memory/prompt_memory";

import {
  type ActiveTaskRecord,
  type AppConfig,
  type Bookmark,
  type ChatCompletionClient,
  type ExtractedMemoryPayload,
  type FeedSubscription,
  type MemoryTurn,
  type ModelRole,
  type PromptState,
  type ReplyStyle,
  type StaticProviderId,
} from "./types";

export abstract class TelegramBotBase implements TelegramCommandBot {
  protected static readonly MAX_SEEN_MEMBERS = 50;
  protected static readonly MAX_PERSON_CARDS = 18;
  protected static readonly MAX_PERSON_NOTES = 5;
  protected static readonly MAX_DURABLE_MEMORIES = 100;
  protected static readonly MAX_ACTIVE_TOPICS = 6;
  protected static readonly MAX_GROUP_PROFILE_CHARS = 2000;
  protected static readonly BOT_USERNAME_KEY = "bot_username";
  protected static readonly BOT_USERNAME_TTL_SECONDS = 24 * 60 * 60;
  protected static readonly MAX_RECENT_TURNS = 12;
  protected static readonly RECENT_TURNS_TO_KEEP = 6;
  protected static readonly MAX_RECENT_TURN_CHARS = 9000;
  protected static readonly MAX_SUMMARY_CHARS = 3000;
  protected static readonly MAX_AMBIENT_MESSAGES = 10;
  protected static readonly MAX_AMBIENT_CHARS = 2500;
  protected static readonly MAX_SUBJECT_HINT_CHARS = 500;
  protected static readonly PROCESSED_UPDATE_TTL_SECONDS = 10 * 60;
  protected static readonly LAST_SOURCES_TTL_SECONDS = 24 * 60 * 60;
  protected static readonly ACTIVE_TASK_TTL_SECONDS = 15 * 60;
  protected static readonly COMMAND_SCHEMA_KEY =
    "telegram_commands:v1:fingerprint";
  protected static readonly MODEL_MIGRATIONS: Record<string, string> = {
    "GLM-5-Turbo": "glm-5v-turbo",
    "gemini-3.1-flash-lite-preview": "gemini-flash-lite-latest",
  };
  protected static readonly DEFAULT_SETTINGS: BotSettings = {
    ambientMemory: false,
    replyStyle: "short",
  };
  protected token: string;
  protected apiUrl: string;
  protected botUsername: string | null = null;
  protected whitelistedUsers: string[];
  protected whitelistedGroups: string[];
  protected systemMessage: string;
  protected soulMessage: string;
  protected env: Env;
  protected readonly config: AppConfig;
  protected ctx?: ExecutionContext;
  protected commands: Command[];
  protected redis: RedisClient;
  protected usageTracker: UsageTracker;
  protected readonly transport: TelegramTransport;
  protected modelAPI: ModelAPIInterface;

  constructor(env: Env, ctx?: ExecutionContext) {
    const config = getConfig(env);
    this.config = config;
    this.token = config.telegramBotToken;
    this.apiUrl = `https://api.telegram.org/bot${this.token}`;
    this.whitelistedUsers = config.whitelistedUsers;
    this.whitelistedGroups = config.whitelistedGroups;
    this.systemMessage = config.systemInitMessage;
    this.soulMessage = soulMessage;
    this.env = env;
    this.ctx = ctx;
    this.commands = commands;
    this.redis = new RedisClient(env);
    this.usageTracker = new UsageTracker(this.redis);
    this.transport = new TelegramTransport(this.apiUrl);
    this.modelAPI = new OpenAIAPI(env);
  }

  abstract getEnv(): Env;

  abstract createDashboardLink(
    sessionKey: string,
    userId: string,
  ): Promise<{ url: string; expiresInMinutes: number }>;

  abstract handleDashboardApi(request: Request): Promise<Response>;

  protected abstract runBackground(
    label: string,
    fn: () => Promise<void>,
  ): void;

  protected abstract normalizeModelName(model: string): string;

  protected abstract getProviderIdForModel(model: string): string;

  protected abstract getErrorCategory(error: unknown): string;

  protected abstract isRetryableModelError(error: unknown): boolean;

  protected abstract getModelFallbackCandidates(
    failedModel: string,
    mode: ModelRequestMode,
    requireTools?: boolean,
  ): string[];

  protected abstract recordModelUsage(
    model: string,
    mode: ModelRequestMode,
    startedAt: number,
    success: boolean,
    usage?: ModelUsage,
    error?: unknown,
    resolvedModel?: string,
  ): void;

  protected abstract generateTrackedResponse(
    api: ModelAPIInterface,
    messages: Message[],
    model: string,
    mode: ModelRequestMode,
  ): Promise<string>;

  protected abstract createTrackedChatCompletion(
    api: ChatCompletionClient,
    messages: Message[],
    model: string,
    mode: ModelRequestMode,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse>;

  protected abstract getContextTTL(): number;

  protected abstract resolveStaticProvider(
    model: string,
    config: AppConfig,
  ): StaticProviderId | null;

  protected abstract createStaticProviderAPI(
    provider: StaticProviderId,
  ): ModelAPIInterface;

  protected abstract getModelAPIForModel(
    model: string,
  ): Promise<ModelAPIInterface>;

  protected abstract initializeModelAPI(
    userId: string,
  ): Promise<ModelAPIInterface>;

  public abstract executeCommand(
    commandName: string,
    chatId: number,
    sessionKey: string,
    userId: string,
    args: string[],
  ): Promise<void>;

  abstract sendMessage(
    chatId: number,
    text: string,
    options?: { parse_mode?: "Markdown" | "HTML"; reply_markup?: string },
  ): Promise<TelegramTypes.SendMessageResult[]>;

  abstract handleUpdate(update: TelegramTypes.Update): Promise<void>;

  protected abstract handleCallbackQuery(
    query: TelegramTypes.CallbackQuery,
  ): Promise<void>;

  protected abstract answerCallbackQuery(callbackQueryId: string): void;

  protected abstract handleImageAnalysis(
    chatId: number,
    sessionKey: string,
    message: TelegramTypes.Message & { photo: TelegramTypes.PhotoSize[] },
  ): Promise<void>;

  protected abstract handleBoxDocument(
    message: TelegramTypes.Message,
    chatId: number,
    sessionKey: string,
    userId: string,
    chatType: TelegramTypes.Chat["type"],
  ): Promise<void>;

  protected abstract createSearchBroker(): SearchBroker;

  protected abstract handleVoiceTranscription(
    chatId: number,
    voice: TelegramTypes.Voice,
  ): Promise<void>;

  protected abstract generateChatResponse(
    messages: Message[],
    currentModel: string,
    sessionKey: string,
    chatId?: number,
    onTextDelta?: (delta: string) => Promise<void>,
    attemptedModels?: Set<string>,
    allowAgentJobs?: boolean,
    allowMutatingTools?: boolean,
  ): Promise<string>;

  protected abstract isToolCapableModel(currentModel: string): boolean;

  protected abstract buildChatMessages(inputs: {
    promptState: PromptState;
    promptText: string;
    replyContext: string | null;
    includeCurrentDateTime: boolean;
  }): Message[];

  protected abstract buildCurrentSubjectHint(
    recentTurns: MemoryTurn[],
    promptText: string,
    replyContext: string | null,
  ): string | null;

  protected abstract hasAmbiguousFollowUpReference(text: string): boolean;

  protected abstract extractLikelySubject(texts: string[]): string | null;

  protected abstract getLatestUserMessageContent(messages: Message[]): string;

  protected abstract selectToolNames(
    text: string,
    canUseWebSearch: boolean,
  ): string[];

  protected abstract shouldForceStockQuoteLookup(text: string): boolean;

  protected abstract shouldForceWebSearch(text: string): boolean;

  protected abstract shouldForceWikipediaLookup(text: string): boolean;

  protected abstract buildForcedWebSearchQuery(text: string): string;

  protected abstract buildContextAwareWebSearchQuery(
    text: string,
    messages: Message[],
  ): string;

  protected abstract generateGroundedLiveResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    searchBroker: SearchBroker,
    sessionKey: string,
  ): Promise<string | null>;

  protected abstract buildForcedWikipediaQuery(text: string): string;

  protected abstract generateGroundedWikipediaResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    wikipediaAPI: WikipediaAPI,
  ): Promise<string | null>;

  protected abstract generateGroundedStockResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    eodhdAPI: EODHDAPI,
  ): Promise<string | null>;

  protected abstract generateGroundedYahooStockResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    yahooFinanceAPI: YahooFinanceAPI,
  ): Promise<string | null>;

  protected abstract shouldIncludeCurrentDateTime(
    text: string,
    _toolMode?: boolean,
  ): boolean;

  protected abstract canUseWebSearch(searchBroker: SearchBroker): boolean;

  protected abstract getToolsInstruction(): string;

  protected abstract runWebSearchTool(
    toolCall: ToolCall,
    searchBroker: SearchBroker,
    sessionKey: string,
  ): Promise<Message>;

  protected abstract runReadUrlTool(
    toolCall: ToolCall,
    reader: URLReader,
    searchBroker: SearchBroker,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<Message>;

  protected abstract getCurrentDateString(): string;

  protected abstract getCurrentDateTimeInstruction(promptText: string): string;

  protected abstract runReminderTool(
    toolCall: ToolCall,
    sessionKey: string,
    chatId: number,
  ): Promise<Message>;

  protected abstract runMemoryTool(
    toolCall: ToolCall,
    sessionKey: string,
  ): Promise<Message>;

  protected abstract runAgentJobTool(
    toolCall: ToolCall,
    sessionKey: string,
    chatId: number,
  ): Promise<Message>;

  protected abstract getProcessedUpdateKey(updateId: number): string;

  protected abstract markUpdateAsProcessed(updateId: number): Promise<boolean>;

  protected abstract getSummaryModel(currentModel: string): string;

  protected abstract getRoleModel(
    role: ModelRole,
    fallbackModel: string,
  ): string;

  protected abstract getMonthlyWebSearchUsage(): Promise<number>;

  protected abstract getMonthlyWebSearchUsageKey(): string;

  protected abstract getFileUrl(fileId: string): Promise<string>;

  protected abstract resolveCurrentModel(
    sessionKey: string,
    storedModel: string | null,
  ): Promise<string>;

  abstract getCurrentModel(sessionKey: string): Promise<string>;

  protected abstract isConfiguredModel(model: string): boolean;

  protected abstract parseBotSettings(raw: string | null): BotSettings;

  protected abstract getDefaultBotSettings(): BotSettings;

  protected abstract parseRecentTurnsRaw(raw: string | null): MemoryTurn[];

  protected abstract parseDurableMemoriesRaw(
    raw: string | null,
  ): DurableMemory[];

  protected abstract loadPromptState(
    sessionKey: string,
    initialBotSettings?: BotSettings,
  ): Promise<PromptState>;

  protected abstract loadPromptStateFromRedis(
    sessionKey: string,
    initialBotSettings?: BotSettings,
  ): Promise<PromptState>;

  abstract setCurrentModel(sessionKey: string, model: string): Promise<void>;

  abstract getAvailableModels(): string[];

  abstract isValidModel(model: string): boolean;

  abstract clearContext(
    sessionKey: string,
    chatId: number,
    userId?: string,
  ): Promise<void>;

  abstract getGroupProfile(sessionKey: string): Promise<string | null>;

  abstract setGroupProfile(sessionKey: string, profile: string): Promise<void>;

  abstract getSelectableModels(): Promise<string[]>;

  abstract appendGroupProfile(sessionKey: string, note: string): Promise<void>;

  abstract clearGroupProfile(sessionKey: string): Promise<void>;

  abstract getFormattedPersonCards(sessionKey: string): Promise<string | null>;

  abstract getFormattedActiveTopics(sessionKey: string): Promise<string | null>;

  abstract getFormattedSummary(sessionKey: string): Promise<string | null>;

  abstract rememberDurableMemory(
    sessionKey: string,
    text: string,
  ): Promise<string>;

  abstract recallDurableMemory(
    sessionKey: string,
    query: string,
  ): Promise<string | null>;

  abstract forgetSavedMemory(
    sessionKey: string,
    query: string,
  ): Promise<string | null>;

  protected abstract getDurableMemories(
    sessionKey: string,
  ): Promise<DurableMemory[]>;

  protected abstract setDurableMemories(
    sessionKey: string,
    memories: DurableMemory[],
  ): Promise<void>;

  abstract deletePersonCard(sessionKey: string, name: string): Promise<boolean>;

  abstract getBotSettings(sessionKey: string): Promise<BotSettings>;

  abstract setBotSettings(
    sessionKey: string,
    settings: Partial<BotSettings>,
  ): Promise<BotSettings>;

  abstract summarizeHistory(sessionKey: string): Promise<string>;

  protected abstract reportChatMigration(message: TelegramTypes.Message): void;

  abstract isUserWhitelisted(userId: string): boolean;

  abstract isGroupWhitelisted(chatId: number): boolean;

  abstract isAuthorized(input: {
    userId: string;
    chatId: number;
    chatType: TelegramTypes.Chat["type"];
  }): boolean;

  abstract isOwner(userId: string): boolean;

  abstract recordModelOperation(
    model: string,
    mode: ModelRequestMode,
    startedAt: number,
    success: boolean,
    error?: unknown,
  ): void;

  abstract getUsageReport(): Promise<string>;

  abstract getCacheReport(sessionKey: string): Promise<string>;

  abstract getLastSources(sessionKey: string): Promise<string | null>;

  abstract research(sessionKey: string, question: string): Promise<string>;

  abstract readUrl(sessionKey: string, url: string): Promise<string>;

  abstract compareModels(sessionKey: string, question: string): Promise<string>;

  abstract addBookmark(
    sessionKey: string,
    rawUrl: string,
    title?: string,
  ): Promise<void>;

  abstract listBookmarks(sessionKey: string): Promise<string | null>;

  abstract removeBookmark(
    sessionKey: string,
    query: string,
  ): Promise<string | null>;

  protected abstract getBookmarks(sessionKey: string): Promise<Bookmark[]>;

  protected abstract buildResearchQueries(question: string): string[];

  protected abstract rankResearchSources(
    sources: SearchSource[],
  ): SearchSource[];

  protected abstract readPageWithTimeout(
    url: string,
  ): Promise<Awaited<ReturnType<URLReader["read"]>>>;

  protected abstract saveLastSources(
    sessionKey: string,
    response: SearchResponse,
  ): Promise<void>;

  abstract isUserGroupAdmin(chatId: number, userId: string): Promise<boolean>;

  abstract syncCommands(): Promise<void>;

  protected abstract syncCommandsIfStale(): Promise<void>;

  abstract beginCancellableTask(
    sessionKey: string,
    type: string,
  ): Promise<string>;

  abstract assertTaskActive(sessionKey: string, taskId: string): Promise<void>;

  protected abstract assertCurrentTaskActive(sessionKey: string): Promise<void>;

  abstract finishCancellableTask(
    sessionKey: string,
    taskId: string,
  ): Promise<void>;

  abstract cancelActiveTask(sessionKey: string): Promise<string | null>;

  protected abstract getActiveTask(
    sessionKey: string,
  ): Promise<ActiveTaskRecord | null>;

  abstract getStatus(sessionKey: string): Promise<TelegramStatus>;

  protected abstract getCommandMenuStatus(): Promise<"current" | "stale">;

  protected abstract getCommandSchemaFingerprint(): string;

  protected abstract getSearchQuotaStatus(): Promise<
    Array<{ provider: string; used: number; cap: number | null }>
  >;

  abstract runTextShortcut(
    sessionKey: string,
    task: "translate" | "rewrite" | "summarize",
    text: string,
    target?: string,
  ): Promise<string>;

  abstract addReminder(
    chatId: number,
    sessionKey: string,
    input: string,
  ): Promise<string>;

  abstract createAgentRun(
    chatId: number,
    sessionKey: string,
    goal: string,
  ): Promise<AgentRun>;

  protected abstract boxJobs(): BoxJobService;

  protected abstract artifactGateway(): ArtifactGateway;

  protected abstract boxSchedules(): BoxScheduleService;

  abstract handleBoxCompletion(request: Request): Promise<Response>;

  abstract handleBoxScheduleCompletion(request: Request): Promise<Response>;

  abstract handleBoxProgress(request: Request): Promise<Response>;

  abstract handleBoxActionRequest(request: Request): Promise<Response>;

  abstract handleBoxActionResult(request: Request): Promise<Response>;

  abstract approveBrokeredAction(
    chatId: number,
    userId: string,
    actionId: string,
    nonce: string,
  ): Promise<string>;

  abstract denyBrokeredAction(
    chatId: number,
    userId: string,
    actionId: string,
  ): Promise<string>;

  abstract listBrokeredActions(chatId: number, userId: string): Promise<string>;

  abstract handleBoxArtifactAuthorization(request: Request): Promise<Response>;

  abstract handleBoxArtifactUpload(
    request: Request,
    artifactId: string,
  ): Promise<Response>;

  abstract handleArtifactDownload(
    request: Request,
    artifactId: string,
  ): Promise<Response>;

  abstract enableBoxForChat(chatId: number, sessionKey: string): Promise<void>;

  abstract startBoxAgentJob(
    chatId: number,
    sessionKey: string,
    userId: string,
    request: string,
    requestedRoute?: string,
    files?: PromptFiles,
    routeDecision?: BoxRouteDecision,
  ): Promise<void>;

  abstract runQuickChat(
    chatId: number,
    sessionKey: string,
    _userId: string,
    request: string,
  ): Promise<void>;

  abstract getBoxAgentStatus(
    chatId: number,
    userId: string,
    jobId?: string,
  ): Promise<string>;

  abstract cancelBoxAgentJob(
    chatId: number,
    userId: string,
    jobId: string,
  ): Promise<string>;

  abstract approveBoxAgentJob(
    chatId: number,
    userId: string,
    jobId: string,
    nonce: string,
  ): Promise<string>;

  abstract createBoxAgentSchedule(
    chatId: number,
    userId: string,
    cron: string,
    prompt: string,
    requestedRoute?: string,
  ): Promise<string>;

  abstract listBoxAgentSchedules(
    chatId: number,
    userId: string,
  ): Promise<string>;

  abstract changeBoxAgentSchedule(
    chatId: number,
    userId: string,
    id: string,
    action: "pause" | "resume" | "delete",
  ): Promise<string>;

  abstract listArtifacts(chatId: number, userId: string): Promise<string>;

  abstract getArtifactLink(
    chatId: number,
    userId: string,
    artifactId: string,
  ): Promise<string>;

  protected abstract formatBoxJobStatus(job: BoxJob): string;

  abstract listAgentRuns(sessionKey: string): Promise<string | null>;

  abstract cancelAgentRun(
    sessionKey: string,
    id: string,
  ): Promise<AgentRun | null>;

  abstract listReminders(sessionKey: string): Promise<string | null>;

  abstract removeReminder(
    sessionKey: string,
    id: string,
  ): Promise<string | null>;

  abstract addFeedSubscription(
    sessionKey: string,
    url: string,
  ): Promise<string>;

  abstract listFeedSubscriptions(sessionKey: string): Promise<string | null>;

  abstract removeFeedSubscription(
    sessionKey: string,
    id: string,
  ): Promise<string | null>;

  abstract addDigest(
    chatId: number,
    sessionKey: string,
    input: string,
  ): Promise<string>;

  abstract listDigests(sessionKey: string): Promise<string | null>;

  abstract removeDigest(sessionKey: string, id: string): Promise<string | null>;

  abstract processScheduledTasks(): Promise<number>;

  protected abstract processDueAgentRuns(): Promise<number>;

  protected abstract executeAgentRunWake(
    run: AgentRun,
  ): Promise<AgentWakeResult>;

  protected abstract parseAgentPlan(response: string): string[];

  protected abstract parseAgentStepResponse(response: string): AgentWakeResult;

  protected abstract formatAgentPlan(run: AgentRun): string;

  protected abstract formatAgentObservations(run: AgentRun): string;

  protected abstract ensureAgentProgressMessage(
    store: AgentRunStore,
    run: AgentRun,
  ): Promise<void>;

  protected abstract publishAgentRunTransition(
    store: AgentRunStore,
    run: AgentRun,
  ): Promise<void>;

  protected abstract renderAgentRunProgress(
    run: AgentRun,
    working: boolean,
  ): string;

  protected abstract formatScheduledTime(timestamp: number): string;

  protected abstract processDigestJob(job: ScheduledJob): Promise<void>;

  protected abstract getFeedSubscriptions(
    sessionKey: string,
  ): Promise<FeedSubscription[]>;

  abstract handleWebhook(request: Request): Promise<Response>;

  abstract sendPhoto(
    chatId: number,
    photo: string | Uint8Array,
    options?: { caption?: string },
  ): Promise<void>;

  abstract synthesizeSpeech(text: string): Promise<Uint8Array>;

  abstract sendVoice(
    chatId: number,
    voice: Uint8Array,
    caption?: string,
  ): Promise<void>;

  abstract setWebhook(url: string): Promise<void>;

  abstract sendMessageWithFallback(
    chatId: number,
    text: string,
  ): Promise<TelegramTypes.SendMessageResult[]>;

  abstract replaceProgressMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void>;

  protected abstract getUserFacingErrorMessage(error: unknown): string;

  protected abstract setMenuButton(): Promise<void>;

  protected abstract getSessionKey(
    chatId: number,
    userId: string,
    chatType: TelegramTypes.Chat["type"],
  ): string;

  protected abstract getUserIdFromSessionKey(sessionKey: string): string;

  protected abstract getDisplayName(user: TelegramTypes.User): string;

  protected abstract formatReplyContext(
    message: TelegramTypes.Message,
    chatTitle: string,
  ): string | null;

  protected abstract getSeenMembers(sessionKey: string): Promise<SeenMember[]>;

  protected abstract rememberSeenMember(
    sessionKey: string,
    user: TelegramTypes.User,
  ): Promise<void>;

  protected abstract getPersonCards(sessionKey: string): Promise<PersonCard[]>;

  protected abstract setPersonCards(
    sessionKey: string,
    personCards: PersonCard[],
  ): Promise<void>;

  protected abstract getActiveTopics(
    sessionKey: string,
  ): Promise<ActiveTopic[]>;

  protected abstract setActiveTopics(
    sessionKey: string,
    topics: ActiveTopic[],
  ): Promise<void>;

  protected abstract getActiveTaskKey(sessionKey: string): string;

  protected abstract getLastReadFollowUpContext(
    sessionKey: string,
    promptText: string,
  ): Promise<string | null>;

  protected abstract getBotUsername(): Promise<string | null>;

  protected abstract messageMentionsBot(
    text: string,
    entities?: TelegramTypes.MessageEntity[],
  ): Promise<boolean>;

  protected abstract stripBotMention(text: string): Promise<string>;

  protected abstract getRecentTurns(sessionKey: string): Promise<MemoryTurn[]>;

  protected abstract setRecentTurns(
    sessionKey: string,
    turns: MemoryTurn[],
  ): Promise<void>;

  protected abstract getConversationSummary(
    sessionKey: string,
  ): Promise<string | null>;

  protected abstract setConversationSummary(
    sessionKey: string,
    summary: string,
  ): Promise<void>;

  protected abstract getAmbientMessages(sessionKey: string): Promise<string[]>;

  protected abstract setAmbientMessages(
    sessionKey: string,
    messages: string[],
  ): Promise<void>;

  protected abstract rememberAmbientMessage(
    sessionKey: string,
    message: string,
  ): Promise<void>;

  protected abstract rememberConversation(
    sessionKey: string,
    userContent: string,
    assistantContent: string,
    currentModel: string,
  ): Promise<void>;

  protected abstract compactConversationMemory(
    currentModel: string,
    turnsToSummarize: MemoryTurn[],
    sessionKey: string,
  ): Promise<void>;

  protected abstract updateConversationSummary(
    currentModel: string,
    turnsToSummarize: MemoryTurn[],
    sessionKey: string,
  ): Promise<string | null>;

  protected abstract fallbackConversationSummary(
    summaryApi: ModelAPIInterface,
    summaryModel: string,
    transcript: string,
    existingSummary: string | null,
  ): Promise<string | null>;

  protected abstract parseExtractedMemory(
    raw: string,
  ): ExtractedMemoryPayload | null;

  protected abstract applyExtractedMemory(
    sessionKey: string,
    extractedMemory: ExtractedMemoryPayload,
  ): Promise<void>;

  protected abstract mergeGroupProfileAdditions(
    sessionKey: string,
    additions: string[],
  ): Promise<void>;

  protected abstract mergePersonCards(
    sessionKey: string,
    incomingCards: NonNullable<ExtractedMemoryPayload["person_cards"]>,
  ): Promise<void>;

  protected abstract mergeActiveTopics(
    sessionKey: string,
    incomingTopics: NonNullable<ExtractedMemoryPayload["active_topics"]>,
  ): Promise<void>;

  protected abstract getRecentTurnCharCount(turns: MemoryTurn[]): number;

  protected abstract truncateAmbientMessage(message: string): string;

  protected abstract shouldStoreAmbientMessage(message: string): boolean;

  protected abstract getReplyStyleInstruction(replyStyle: ReplyStyle): string;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)),
    );
  }
  return btoa(result);
}
