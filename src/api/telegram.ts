import { Env, getConfig } from '../env';
import { TelegramTypes } from '../../types/telegram';
import OpenAIAPI from './openai_api';
import { ChatCompletionResponse, Message, ToolCall, ToolChoice, ToolDefinition } from './chat_types';
import {
  constantTimeEqual,
  fetchJson,
  sendChatAction,
} from '../utils/helpers';
import { translate, translateMessage } from '../utils/i18n';
import { commands } from '../config/commands';
import { RedisClient } from '../utils/redis';
import { ModelAPIInterface, ModelResponse, ModelUsage } from './model_api_interface';
import GeminiAPI from './gemini';
import GroqAPI from './groq';
import ClaudeAPI from './claude';
import AzureAPI from './azure';
import ImageAnalysisAPI from './image_analyze';
import OpenAICompatibleAPI from './openai_compatible';
import ExaSearchAPI from './exa_search';
import EODHDAPI from './eodhd';
import YahooFinanceAPI from './yahoo_finance';
import WikipediaAPI from './wikipedia';
import { soulMessage } from '../generated/soul';
import { BotSettings, Command, TelegramCommandBot, TelegramStatus } from '../config/command_types';
import { ModelRequestMode, UsageTracker } from '../utils/usage_tracker';
import { formatSearchResponseForModel, SearchBroker } from '../search/search_broker';
import { OpenAIWebSearchProvider } from '../search/providers/openai_web_search';
import { GeminiGroundingProvider } from '../search/providers/gemini_grounding';
import { createJobId, parseDigestInput, parseReminderInput, ScheduledJob, SharedScheduler } from '../scheduling/scheduler';
import {
  convertCurrency,
  formatFeed,
  getGitHubRepository,
  getWeather,
  readFeed,
  searchArxiv,
} from '../utils/structured_utilities';
import { calculateExpression, formatNumber } from '../utils/deterministic_tools';
import { AudioAPI } from './audio';
import { TelegramTransport } from '../telegram/transport';
import { TelegramStreamingReply } from '../telegram/streaming_reply';
import { DashboardAccess } from '../dashboard/dashboard';
import { buildPromptLayout } from '../prompt/prompt_layout';
import {
  activeTopicsKey,
  ambientMessagesKey,
  bookmarksKey,
  botSettingsKey,
  conversationSummaryKey,
  durableMemoryKey,
  feedSubscriptionsKey,
  groupProfileKey,
  isGroupSession,
  lastReadKey,
  lastSourcesKey,
  personCardsKey,
  recentTurnsKey,
  seenMembersKey,
} from '../memory/session_keys';
import { SearchProvider, SearchResponse, SearchSource } from '../search/types';
import { URLReader } from '../web/url_reader';
import { RUNTIME_BUDGETS } from '../config/runtime_budgets';
import { ToolRegistry } from '../tools/tool_registry';
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
} from '../tools/tool_runners';
import {
  AGENT_JOB_TOOL,
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
} from '../tools/tool_definitions';
import { AgentRun, AgentRunStore, AgentWakeResult } from '../agent/agent_run_store';
import { BoxJobService } from '../agent/box/box_job_service';
import type { BoxJob } from '../agent/box/box_job_store';
import { ArtifactGateway } from '../agent/box/artifact_gateway';
import { shouldRouteToBox } from '../agent/box/hybrid_router';
import { BoxScheduleService } from '../agent/box/box_schedule_service';
import type { PromptFiles } from '@upstash/box';
import {
  DurableMemory,
  getMemoryIdentity,
  inferMemoryType,
  normalizeMemoryText,
  parseDurableMemories,
  rankDurableMemories,
} from '../memory/durable_memory';
import {
  type ActiveTopic,
  type PersonCard,
  type SeenMember,
  buildStableMemoryBlock,
  buildVolatileContextBlock,
  describeFreshness,
  formatActiveTopics,
  formatPersonCards,
  parseActiveTopics,
  parseAmbientMessages,
  parsePersonCards,
  parseSeenMembers,
  selectRelevantPromptMemory,
} from '../memory/prompt_memory';

type AppConfig = ReturnType<typeof getConfig>;

interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface FeedSubscription {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

interface ActiveTaskRecord {
  id: string;
  type: string;
  status: 'running' | 'cancelled';
  startedAt: string;
}

interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

interface ExtractedMemoryPayload {
  summary: string;
  group_profile_additions?: string[];
  person_cards?: Array<{
    name: string;
    notes: string[];
  }>;
  active_topics?: Array<{
    topic: string;
    status?: string;
  }>;
}

type StaticProviderId = 'openai' | 'google' | 'groq' | 'claude' | 'azure';

interface ImageCapableAPI {
  analyzeImage(imageUrl: string, prompt: string, model: string): Promise<string>;
}

interface ChatCompletionClient {
  createChatCompletion(
    messages: Message[],
    model?: string,
    options?: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
  ): Promise<ChatCompletionResponse>;
  createStreamingChatCompletion?(
    messages: Message[],
    model: string | undefined,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse>;
}

interface PromptState {
  botSettings: BotSettings;
  groupProfile: string | null;
  personCards: PersonCard[];
  activeTopics: ActiveTopic[];
  conversationSummary: string | null;
  recentTurns: MemoryTurn[];
  ambientMessages: string[];
  seenMembers: SeenMember[];
  durableMemories?: DurableMemory[];
  currentModel: string;
}

type ReplyStyle = BotSettings['replyStyle'];
type ModelRole = 'utility' | 'summary' | 'research' | 'vision';

class TelegramBot implements TelegramCommandBot {
  private static readonly MAX_SEEN_MEMBERS = 50;
  private static readonly MAX_PERSON_CARDS = 18;
  private static readonly MAX_PERSON_NOTES = 5;
  private static readonly MAX_DURABLE_MEMORIES = 100;
  private static readonly MAX_ACTIVE_TOPICS = 6;
  private static readonly MAX_GROUP_PROFILE_CHARS = 2000;
  private static readonly BOT_USERNAME_KEY = 'bot_username';
  private static readonly BOT_USERNAME_TTL_SECONDS = 24 * 60 * 60;
  private static readonly MAX_RECENT_TURNS = 12;
  private static readonly RECENT_TURNS_TO_KEEP = 6;
  private static readonly MAX_RECENT_TURN_CHARS = 9000;
  private static readonly MAX_SUMMARY_CHARS = 3000;
  private static readonly MAX_AMBIENT_MESSAGES = 10;
  private static readonly MAX_AMBIENT_CHARS = 2500;
  private static readonly MAX_SUBJECT_HINT_CHARS = 500;
  private static readonly PROCESSED_UPDATE_TTL_SECONDS = 10 * 60;
  private static readonly LAST_SOURCES_TTL_SECONDS = 24 * 60 * 60;
  private static readonly ACTIVE_TASK_TTL_SECONDS = 15 * 60;
  private static readonly COMMAND_SCHEMA_KEY = 'telegram_commands:v1:fingerprint';
  private static readonly MODEL_MIGRATIONS: Record<string, string> = {
    'GLM-5-Turbo': 'glm-5v-turbo',
    'gemini-3.1-flash-lite-preview': 'gemini-flash-lite-latest',
  };
  private static readonly DEFAULT_SETTINGS: BotSettings = {
    ambientMemory: false,
    replyStyle: 'short',
  };
  private token: string;
  private apiUrl: string;
  private botUsername: string | null = null;
  private whitelistedUsers: string[];
  private whitelistedGroups: string[];
  private systemMessage: string;
  private soulMessage: string;
  private env: Env;
  private readonly config: AppConfig;
  private ctx?: ExecutionContext;
  private commands: Command[];
  private redis: RedisClient;
  private usageTracker: UsageTracker;
  private readonly transport: TelegramTransport;
  private modelAPI: ModelAPIInterface;
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

  getEnv(): Env {
    return this.env;
  }

  async createDashboardLink(sessionKey: string, userId: string): Promise<{ url: string; expiresInMinutes: number }> {
    if (!this.isOwner(userId)) throw new Error('Dashboard access is owner-only.');
    if (!this.config.dashboardBaseUrl) throw new Error('DASHBOARD_BASE_URL is not configured.');
    return await new DashboardAccess(this.redis, this.config.dashboardBaseUrl).createSession(sessionKey, userId);
  }

  async handleDashboardApi(request: Request): Promise<Response> {
    const access = new DashboardAccess(this.redis, this.config.dashboardBaseUrl || new URL(request.url).origin);
    const session = await access.authenticate(request);
    if (!session || !this.isOwner(session.ownerUserId)) {
      return Response.json({ error: 'Unauthorized or expired dashboard session.' }, {
        status: 401,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const today = new Date();
    const trendDates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - (6 - index));
      return date;
    });
    const [status, dailyReports, month, jobs] = await Promise.all([
      this.getStatus(session.sessionKey),
      Promise.all(trendDates.map(date => this.usageTracker.getReport('day', date))),
      this.usageTracker.getReport('month'),
      new SharedScheduler(this.redis).list(session.sessionKey),
    ]);
    const day = dailyReports[dailyReports.length - 1];
    const cacheModels = this.config.openaiCompatibleModels.filter(model => /deepseek/i.test(model));
    const [cacheReports, dailyCacheReports] = await Promise.all([
      Promise.all(cacheModels.map(model => this.usageTracker.getModelCacheReport('month', model))),
      Promise.all(trendDates.map(date => Promise.all(
        cacheModels.map(model => this.usageTracker.getModelCacheReport('day', model, date)),
      ))),
    ]);
    const cacheHitTokens = cacheReports.reduce((sum, report) => sum + report.cacheHitTokens, 0);
    const cacheMissTokens = cacheReports.reduce((sum, report) => sum + report.cacheMissTokens, 0);
    const measuredCacheTokens = cacheHitTokens + cacheMissTokens;

    return Response.json({
      generatedAt: new Date().toISOString(),
      status,
      usage: {
        day,
        month,
        trend: dailyReports.map(report => ({
          date: report.period,
          calls: report.calls,
          errors: report.errors,
          totalTokens: report.totalTokens,
          searchCalls: report.searchCalls,
        })),
        dayAverageLatencyMs: day.calls > 0 ? Math.round(day.totalLatencyMs / day.calls) : 0,
        monthAverageLatencyMs: month.calls > 0 ? Math.round(month.totalLatencyMs / month.calls) : 0,
      },
      cache: {
        hitTokens: cacheHitTokens,
        missTokens: cacheMissTokens,
        hitRate: measuredCacheTokens > 0 ? `${((cacheHitTokens / measuredCacheTokens) * 100).toFixed(1)}%` : 'n/a',
        trend: dailyCacheReports.map((reports, index) => {
          const hits = reports.reduce((sum, report) => sum + report.cacheHitTokens, 0);
          const misses = reports.reduce((sum, report) => sum + report.cacheMissTokens, 0);
          return {
            date: trendDates[index].toISOString().slice(0, 10),
            hitRate: hits + misses > 0 ? Number(((hits / (hits + misses)) * 100).toFixed(1)) : null,
          };
        }),
      },
      jobs: jobs.map(job => ({ id: job.id, type: job.type, nextAt: job.nextAt, recurrence: job.recurrence })),
    }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  private runBackground(label: string, fn: () => Promise<void>): void {
    const promise = fn().catch(error => {
      console.error(`Background task failed (${label}):`, error);
    });
    if (this.ctx) {
      this.ctx.waitUntil(promise);
    }
  }

  private normalizeModelName(model: string): string {
    return TelegramBot.MODEL_MIGRATIONS[model] || model;
  }

  private getProviderIdForModel(model: string): string {
    const staticProvider = this.resolveStaticProvider(model, this.config);
    if (staticProvider) return staticProvider;
    if (model === this.config.dallEModel) return 'openai';
    if (model.startsWith('@cf/')) return 'cloudflare';
    return 'openai_compatible';
  }

  private getErrorCategory(error: unknown): string {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('429') || message.includes('rate limit') || message.includes('quota')) return 'quota';
    if (message.includes('401') || message.includes('403') || message.includes('unauthorized')) return 'auth';
    if (message.includes('timeout') || message.includes('abort')) return 'timeout';
    if (message.includes('400') || message.includes('invalid')) return 'invalid_request';
    if (message.includes('500') || message.includes('502') || message.includes('503')) return 'upstream';
    return 'other';
  }

  private isRetryableModelError(error: unknown): boolean {
    return ['quota', 'auth', 'timeout', 'upstream'].includes(this.getErrorCategory(error));
  }

  private getModelFallbackCandidates(
    failedModel: string,
    mode: ModelRequestMode,
    requireTools = false,
  ): string[] {
    if (mode === 'compare') return [];
    const seen = new Set([failedModel]);
    return this.config.modelFallbacks
      .map(model => this.normalizeModelName(model))
      .filter(model => {
        if (seen.has(model) || !this.isConfiguredModel(model)) return false;
        if (requireTools && !this.isToolCapableModel(model)) return false;
        seen.add(model);
        return true;
      })
      .slice(0, 2);
  }

  private recordModelUsage(
    model: string,
    mode: ModelRequestMode,
    startedAt: number,
    success: boolean,
    usage?: ModelUsage,
    error?: unknown,
    resolvedModel?: string,
  ): void {
    this.runBackground('recordModelUsage', () => this.usageTracker.recordModelCall({
      provider: this.getProviderIdForModel(model),
      model: resolvedModel || model,
      mode,
      latencyMs: Date.now() - startedAt,
      success,
      usage,
      errorCategory: error ? this.getErrorCategory(error) : undefined,
    }));
  }

  private async generateTrackedResponse(
    api: ModelAPIInterface,
    messages: Message[],
    model: string,
    mode: ModelRequestMode,
  ): Promise<string> {
    const attemptModels = [model, ...this.getModelFallbackCandidates(model, mode)];

    let lastError: unknown;
    for (const [index, attemptModel] of attemptModels.entries()) {
      const attemptApi = index === 0 ? api : await this.getModelAPIForModel(attemptModel);
      const startedAt = Date.now();
      try {
        const result: ModelResponse = attemptApi.generateResponseWithMetadata
          ? await attemptApi.generateResponseWithMetadata(messages, attemptModel)
          : { content: await attemptApi.generateResponse(messages, attemptModel), resolvedModel: attemptModel };
        this.recordModelUsage(attemptModel, mode, startedAt, true, result.usage, undefined, result.resolvedModel);
        return result.content;
      } catch (error) {
        this.recordModelUsage(attemptModel, mode, startedAt, false, undefined, error);
        lastError = error;
        if (!this.isRetryableModelError(error) || index === attemptModels.length - 1) throw error;
        console.warn(`Model ${attemptModel} failed for ${mode}; trying a configured compatible fallback.`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All configured models failed');
  }

  private async createTrackedChatCompletion(
    api: ChatCompletionClient,
    messages: Message[],
    model: string,
    mode: ModelRequestMode,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse> {
    const attemptModels = [model, ...this.getModelFallbackCandidates(model, mode, true)];

    let lastError: unknown;
    for (const [index, attemptModel] of attemptModels.entries()) {
      const attemptApi = index === 0
        ? api
        : await this.getModelAPIForModel(attemptModel) as unknown as ChatCompletionClient;
      const startedAt = Date.now();
      try {
        const response = onTextDelta && attemptApi.createStreamingChatCompletion
          ? await attemptApi.createStreamingChatCompletion(messages, attemptModel, options, onTextDelta)
          : await attemptApi.createChatCompletion(messages, attemptModel, options);
        const usage = response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          cacheHitTokens: response.usage.prompt_cache_hit_tokens,
          cacheMissTokens: response.usage.prompt_cache_miss_tokens,
        } : undefined;
        this.recordModelUsage(attemptModel, mode, startedAt, true, usage);
        return response;
      } catch (error) {
        this.recordModelUsage(attemptModel, mode, startedAt, false, undefined, error);
        lastError = error;
        if (!this.isRetryableModelError(error) || index === attemptModels.length - 1) throw error;
        console.warn(`Tool-capable model ${attemptModel} failed; trying a configured tool-capable fallback.`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All configured tool-capable models failed');
  }

  private getContextTTL(): number {
    return this.config.contextTTL;
  }

  private resolveStaticProvider(
    model: string,
    config: AppConfig,
  ): StaticProviderId | null {
    if (config.openaiApiKey && config.openaiModels.includes(model)) return 'openai';
    if (config.googleModelKey && config.googleModels.includes(model)) return 'google';
    if (config.groqApiKey && config.groqModels.includes(model)) return 'groq';
    if (config.claudeApiKey && config.claudeModels.includes(model)) return 'claude';
    if (config.azureApiKey && config.azureModels.includes(model)) return 'azure';
    return null;
  }

  private createStaticProviderAPI(provider: StaticProviderId): ModelAPIInterface {
    switch (provider) {
      case 'openai': return new OpenAIAPI(this.env);
      case 'google': return new GeminiAPI(this.env);
      case 'groq': return new GroqAPI(this.env);
      case 'claude': return new ClaudeAPI(this.env);
      case 'azure': return new AzureAPI(this.env);
    }
  }

  private async getModelAPIForModel(model: string): Promise<ModelAPIInterface> {
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

  private async initializeModelAPI(userId: string): Promise<ModelAPIInterface> {
    const currentModel = await this.getCurrentModel(userId);
    return await this.getModelAPIForModel(currentModel);
  }

  public async executeCommand(commandName: string, chatId: number, sessionKey: string, userId: string, args: string[]): Promise<void> {
    const command = this.commands.find(cmd => cmd.name === commandName);
    if (command) {
      await command.action(chatId, sessionKey, userId, this, args);
    } else {
      console.log(`Unknown command: ${commandName}`);
      await this.sendMessage(chatId, translate('command_not_found'));
    }
  }

  async sendMessage(chatId: number, text: string, options: { parse_mode?: 'Markdown' | 'HTML', reply_markup?: string } = {}): Promise<TelegramTypes.SendMessageResult[]> {
    return await this.transport.sendMessage(chatId, text, options);
  }

  async handleUpdate(update: TelegramTypes.Update): Promise<void> {
    this.runBackground('syncCommandsIfStale', () => this.syncCommandsIfStale());
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      const chatId = update.message.chat.id;
      const chatType = update.message.chat.type;
      const chatTitle = update.message.chat.title || update.message.chat.username || 'Group Chat';
      this.reportChatMigration(update.message);
      const sender = update.message.from;
      const userId = sender?.id?.toString();
      if (!sender || !userId) {
        console.error('User ID is undefined');
        return;
      }
      const senderName = this.getDisplayName(sender);
      const sessionKey = this.getSessionKey(chatId, userId, chatType);

      if (!this.isAuthorized({ userId, chatId, chatType })) {
        await this.sendMessageWithFallback(chatId, translate('unauthorized'));
        return;
      }

      const botSettings = await this.getBotSettings(sessionKey);

      if (chatType !== 'private') {
        this.runBackground('rememberSeenMember', () =>
          this.rememberSeenMember(sessionKey, update.message!.from!),
        );
      }

      if (update.message.voice) {
        if (chatType !== 'private' && !(await this.messageMentionsBot(update.message.caption || '', update.message.caption_entities))) {
          return;
        }
        await this.handleVoiceTranscription(chatId, update.message.voice);
      } else if ('document' in update.message && update.message.document) {
        await this.handleBoxDocument(update.message, chatId, sessionKey, userId, chatType);
      } else if ('photo' in update.message && Array.isArray(update.message.photo) && update.message.photo.length > 0) {
        if (chatType !== 'private' && !(await this.messageMentionsBot(update.message.caption || '', update.message.caption_entities))) {
          return;
        }
        await this.handleImageAnalysis(chatId, sessionKey, update.message as TelegramTypes.Message & { photo: TelegramTypes.PhotoSize[] });
      } else if (update.message.text) {
        if (update.message.text.startsWith('/')) {
          const [rawCommandName, ...args] = update.message.text.slice(1).split(' ');
          const commandTarget = rawCommandName.split('@')[1];
          const botUsername = await this.getBotUsername();
          if (commandTarget && botUsername && commandTarget.toLowerCase() !== botUsername.toLowerCase()) {
            return;
          }
          const commandName = rawCommandName.split('@')[0];
          await this.executeCommand(commandName, chatId, sessionKey, userId, args);
        } else {
          try {
            const mentionsBot = await this.messageMentionsBot(update.message.text, update.message.entities);
            if (chatType !== 'private' && !mentionsBot) {
              if (botSettings.ambientMemory) {
                const ambientEntry = `[Group: ${chatTitle}] ${senderName}: ${update.message.text}`;
                this.runBackground('rememberAmbientMessage', () =>
                  this.rememberAmbientMessage(sessionKey, ambientEntry),
                );
              }
              return;
            }

            const cleanedText = await this.stripBotMention(update.message.text);
            if (chatType !== 'private' && shouldRouteToBox(cleanedText) && await this.boxJobs().canRunInChat(chatId)) {
              await this.startBoxAgentJob(chatId, sessionKey, userId, cleanedText);
              return;
            }
            const replyContext = this.formatReplyContext(update.message, chatTitle);
            const promptText = chatType === 'private'
              ? cleanedText
              : `[Group: ${chatTitle}]\n${senderName}: ${cleanedText}`;
            const shouldInjectCurrentDateTime = this.shouldIncludeCurrentDateTime(cleanedText);

              await sendChatAction(chatId, 'typing', this.env);
              const promptState = await this.loadPromptState(sessionKey, botSettings);
              this.modelAPI = await this.getModelAPIForModel(promptState.currentModel);

              const lastReadContext = await this.getLastReadFollowUpContext(sessionKey, cleanedText);
              const effectiveReplyContext = [replyContext, lastReadContext].filter(Boolean).join('\n\n') || null;
              const messages = this.buildChatMessages({
                promptState,
                promptText,
                replyContext: effectiveReplyContext,
                includeCurrentDateTime: shouldInjectCurrentDateTime,
              });

              const streamingReply = chatType === 'private'
                ? new TelegramStreamingReply(
                    this.transport,
                    chatId,
                    update.message!.message_id,
                    'message_thread_id' in update.message! && typeof update.message!.message_thread_id === 'number'
                      ? update.message!.message_thread_id
                      : undefined,
                  )
                : null;
              const response = await this.generateChatResponse(
                messages,
                promptState.currentModel,
                sessionKey,
                chatId,
                delta => streamingReply?.append(delta) || Promise.resolve(),
              );

              await this.rememberConversation(sessionKey, promptText, response, promptState.currentModel)
                .catch(error => {
                  console.error('Failed to persist conversation before reply:', error);
                });
              if (!(await streamingReply?.complete(response))) {
                await this.sendMessageWithFallback(chatId, response);
              }
          } catch (error) {
            console.error('Error in handleUpdate:', error);
            this.runBackground('notifyHandleUpdateError', async () => {
              await this.sendMessageWithFallback(chatId, this.getUserFacingErrorMessage(error));
            });
          }
        }
      }
    }
  }

  private async handleCallbackQuery(query: TelegramTypes.CallbackQuery): Promise<void> {
    if (!query.message || !query.data) {
      console.log('Invalid callback query');
      return;
    }

    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const sessionKey = this.getSessionKey(chatId, userId, query.message.chat.type);

    try {
      if (!this.isAuthorized({ userId, chatId, chatType: query.message.chat.type })) {
        await this.sendMessageWithFallback(chatId, translate('unauthorized'));
        return;
      }

      console.log('Handling callback query:', query.data);

      if (query.data.startsWith('model_')) {
        const newModel = query.data.split('_')[1];
        console.log('Switching to model:', newModel);
        try {
          await this.clearContext(sessionKey, chatId, userId);
          await this.setCurrentModel(sessionKey, newModel);
          await this.sendMessageWithFallback(chatId, translate('model_changed') + newModel);
        } catch (error) {
          console.error('Error switching model:', error);
          await this.sendMessageWithFallback(chatId, translate('error') + ': ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
      }
    } finally {
      this.answerCallbackQuery(query.id);
    }
  }

  private answerCallbackQuery(callbackQueryId: string): void {
    this.runBackground('answerCallbackQuery', () =>
      fetch(`${this.apiUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
      }).then(() => {
        console.log('Callback query answered');
      }),
    );
  }

  private async handleImageAnalysis(chatId: number, sessionKey: string, message: TelegramTypes.Message & { photo: TelegramTypes.PhotoSize[] }, ): Promise<void> {
    if (!message.photo || message.photo.length === 0) {
      await this.sendMessageWithFallback(chatId, translate('image_analysis_error'));
      return;
    }

    const fileId = message.photo[message.photo.length - 1].file_id;
    const caption = 'caption' in message ? message.caption || '' : '';

    let taskId: string | null = null;
    let progress: TelegramTypes.SendMessageResult[] = [];
    try {
      taskId = await this.beginCancellableTask(sessionKey, 'image analysis');
      await sendChatAction(chatId, 'typing', this.env);
      progress = await this.sendMessageWithFallback(chatId, translateMessage('image_analysis_progress'));

      const fileUrl = await this.getFileUrl(fileId);

      const selectedModel = await this.getCurrentModel(sessionKey);
      const currentModel = this.getRoleModel('vision', selectedModel);
      const provider = this.resolveStaticProvider(currentModel, this.config);

      let imageAnalysisAPI: ImageCapableAPI;
      if (provider === 'openai' || provider === 'google') {
        imageAnalysisAPI = new ImageAnalysisAPI(this.env);
      } else if (this.config.openaiCompatibleUrl) {
        const openaiCompatibleAPI = new OpenAICompatibleAPI(this.env);
        const compatibleModels = await openaiCompatibleAPI.getModels();
        if (!compatibleModels.includes(currentModel)) {
          if (progress[0]?.message_id) await this.replaceProgressMessage(chatId, progress[0].message_id, translate('image_analysis_not_supported'));
          else await this.sendMessageWithFallback(chatId, translate('image_analysis_not_supported'));
          return;
        }
        imageAnalysisAPI = openaiCompatibleAPI;
      } else {
        if (progress[0]?.message_id) await this.replaceProgressMessage(chatId, progress[0].message_id, translate('image_analysis_not_supported'));
        else await this.sendMessageWithFallback(chatId, translate('image_analysis_not_supported'));
        return;
      }

      const startedAt = Date.now();
      let analysisResult: string;
      try {
        analysisResult = await imageAnalysisAPI.analyzeImage(fileUrl, caption, currentModel);
        this.recordModelUsage(currentModel, 'vision', startedAt, true);
      } catch (error) {
        this.recordModelUsage(currentModel, 'vision', startedAt, false, undefined, error);
        throw error;
      }

      await this.assertTaskActive(sessionKey, taskId);
      if (progress[0]?.message_id) await this.replaceProgressMessage(chatId, progress[0].message_id, analysisResult);
      else await this.sendMessageWithFallback(chatId, analysisResult);
    } catch (error) {
      console.error('Error in image analysis:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      const userMessage = translate('image_analysis_error') + ': ' + errorMessage;
      if (progress[0]?.message_id) await this.replaceProgressMessage(chatId, progress[0].message_id, userMessage);
      else await this.sendMessage(chatId, userMessage);
    } finally {
      if (taskId) await this.finishCancellableTask(sessionKey, taskId);
    }
  }

  private async handleBoxDocument(
    message: TelegramTypes.Message,
    chatId: number,
    sessionKey: string,
    userId: string,
    chatType: TelegramTypes.Chat['type'],
    ): Promise<void> {
    const document = message.document;
    if (!document) return;
    const caption = (message.caption || '').trim();
    const explicit = caption.match(/^\/agent(?:@\w+)?(?:\s+([\s\S]*))?$/i)?.[1]?.trim();
    const mentioned = chatType === 'private' || await this.messageMentionsBot(caption, message.caption_entities);
    if (!explicit && !mentioned) return;
    if (chatType === 'private') {
      await this.sendMessageWithFallback(chatId, 'Box agent attachments can only be started from the bound group.');
      return;
    }
    if ((document.file_size ?? 0) > 20 * 1024 * 1024) {
      await this.sendMessageWithFallback(chatId, 'Telegram bot downloads are limited to 20 MB. Provide an accessible URL for this larger input.');
      return;
    }
    try {
      const url = await this.getFileUrl(document.file_id);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Telegram input exceeds the 20 MB download limit.');
      const files: PromptFiles = [{
        data: uint8ToBase64(bytes),
        mediaType: document.mime_type || 'application/octet-stream',
        filename: document.file_name || 'telegram-attachment.bin',
      }];
      const request = explicit || caption.replace(/\/agent(?:@\w+)?/i, '').trim() || `Inspect and process the attached file ${document.file_name || ''}.`;
      await this.startBoxAgentJob(chatId, sessionKey, userId, request, undefined, files);
    } catch (error) {
      await this.sendMessageWithFallback(chatId, this.getUserFacingErrorMessage(error));
    }
  }

  private createSearchBroker(): SearchBroker {
    const searchProviderMap: Record<string, SearchProvider> = {
      exa: new ExaSearchAPI(this.env),
      openai: new OpenAIWebSearchProvider(this.env),
      gemini_grounding: new GeminiGroundingProvider(this.env),
    };
    const searchProviders = this.config.searchProviders
      .map(provider => searchProviderMap[provider])
      .filter((provider): provider is SearchProvider => !!provider);
    return new SearchBroker(
      searchProviders,
      this.redis,
      event => this.runBackground('recordSearchAttempt', () => this.usageTracker.recordSearchCall(
        event.provider,
        event.success,
        { latencyMs: event.latencyMs, fallback: event.fallback, category: event.category },
      )),
      {
        exa: this.config.exaMonthlySearchCap,
        openai: this.config.openaiSearchMonthlyCap,
        gemini_grounding: this.config.geminiSearchMonthlyCap,
      },
    );
  }

  private async handleVoiceTranscription(chatId: number, voice: TelegramTypes.Voice, ): Promise<void> {
    const audioApi = new AudioAPI(this.env);
    if (!audioApi.isConfigured()) {
      await this.sendMessageWithFallback(chatId, translateMessage('voice_unavailable'));
      return;
    }
    if ((voice.file_size || 0) > this.config.maxVoiceFileBytes) {
      await this.sendMessageWithFallback(chatId, translateMessage('voice_too_large', {
        size: Math.round(this.config.maxVoiceFileBytes / 1024 / 1024),
      }));
      return;
    }
    const progress = await this.sendMessageWithFallback(chatId, translateMessage('voice_progress'));
    const startedAt = Date.now();
    try {
      const fileUrl = await this.getFileUrl(voice.file_id);
      const response = await fetch(fileUrl, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > this.config.maxVoiceFileBytes) throw new Error('Voice note exceeds the configured file-size limit.');
      const audio = await response.blob();
      if (audio.size > this.config.maxVoiceFileBytes) throw new Error('Voice note exceeds the configured file-size limit.');
      const transcript = await audioApi.transcribe(audio, 'voice.ogg', AbortSignal.timeout(30_000));
      this.recordModelUsage(audioApi.transcriptionModel, 'transcription', startedAt, true);
      const text = translateMessage('transcript_header', { value: transcript });
      if (progress[0]?.message_id) await this.replaceProgressMessage(chatId, progress[0].message_id, text);
      else await this.sendMessageWithFallback(chatId, text);
    } catch (error) {
      this.recordModelUsage(audioApi.transcriptionModel, 'transcription', startedAt, false, undefined, error);
      const message = `${translate('image_analysis_error')}\n${error instanceof Error ? error.message : translateMessage('transcription_failed')}`;
      if (progress[0]?.message_id) await this.replaceProgressMessage(chatId, progress[0].message_id, message);
      else await this.sendMessageWithFallback(chatId, message);
    }
  }

  private async generateChatResponse(
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
    const toolRegistry = new ToolRegistry([
      {
        definition: WEB_SEARCH_TOOL,
        category: 'search',
        isAvailable: () => canUseWebSearch,
        execute: toolCall => this.runWebSearchTool(toolCall, searchBroker, sessionKey),
      },
      {
        definition: READ_URL_TOOL,
        category: 'knowledge',
        isAvailable: () => true,
        execute: (toolCall, signal) => this.runReadUrlTool(toolCall, new URLReader(), searchBroker, sessionKey, signal),
      },
      {
        definition: WIKIPEDIA_TOOL,
        category: 'knowledge',
        isAvailable: () => true,
        execute: (toolCall, signal) => runWikipediaTool(toolCall, wikipediaAPI, signal),
      },
      {
        definition: STOCK_QUOTE_TOOL,
        category: 'finance',
        isAvailable: () => true,
        execute: toolCall => runStockQuoteTool(toolCall, eodhdAPI, yahooFinanceAPI),
      },
      {
        definition: CALCULATOR_TOOL,
        category: 'utility',
        isAvailable: () => true,
        execute: toolCall => runCalculatorTool(toolCall),
      },
      {
        definition: WEATHER_TOOL,
        category: 'utility',
        isAvailable: () => true,
        execute: (toolCall, signal) => runWeatherTool(toolCall, signal),
      },
      {
        definition: CURRENCY_TOOL,
        category: 'finance',
        isAvailable: () => true,
        execute: (toolCall, signal) => runCurrencyTool(toolCall, signal),
      },
      {
        definition: GITHUB_TOOL,
        category: 'knowledge',
        isAvailable: () => true,
        execute: (toolCall, signal) => runGitHubTool(toolCall, this.config.githubToken, signal),
      },
      {
        definition: ARXIV_TOOL,
        category: 'knowledge',
        isAvailable: () => true,
        execute: (toolCall, signal) => runArxivTool(toolCall, signal),
      },
      {
        definition: REMINDER_TOOL,
        category: 'utility',
        isAvailable: () => allowMutatingTools && chatId !== undefined,
        execute: toolCall => this.runReminderTool(toolCall, sessionKey, chatId!),
      },
      {
        definition: MEMORY_TOOL,
        category: 'memory',
        isAvailable: () => allowMutatingTools,
        execute: toolCall => this.runMemoryTool(toolCall, sessionKey),
      },
    ], 15_000);

    if (!this.isToolCapableModel(currentModel)) {
      return this.generateTrackedResponse(this.modelAPI, messages, currentModel, 'chat');
    }

    const tools = toolRegistry.getDefinitions();
    if (tools.length === 0) {
      return this.generateTrackedResponse(this.modelAPI, messages, currentModel, 'chat');
    }

    const toolEnabledMessages: Message[] = [
      ...messages.slice(0, 1),
      { role: 'system', content: this.getToolsInstruction() },
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
            toolCall => toolRegistry.execute(toolCall),
            currentModel,
            onTextDelta,
          );
          this.recordModelUsage(currentModel, 'chat_tools', startedAt, true, result.usage, undefined, result.resolvedModel);
          return result.content;
        } catch (error) {
          this.recordModelUsage(currentModel, 'chat_tools', startedAt, false, undefined, error);
          throw error;
        }
      }

      const chatCompletionAPI = this.config.openaiCompatibleModels.includes(currentModel)
        ? new OpenAICompatibleAPI(this.env)
        : new OpenAIAPI(this.env);
      const requestMessages: Message[] = [...toolEnabledMessages];
      let completedToolRounds = 0;
      while (true) {
        const completion = await this.createTrackedChatCompletion(
          chatCompletionAPI,
          requestMessages,
          currentModel,
          'chat_tools',
          { tools, toolChoice: 'auto' },
          onTextDelta,
        );
        const assistantMessage = completion.choices[0]?.message;
        if (!assistantMessage) throw new Error('Tool-assisted response did not return an assistant message');

        const toolCalls = assistantMessage.tool_calls || [];
        if (toolCalls.length === 0) {
          const content = assistantMessage.content?.trim();
          if (!content) throw new Error('Tool-assisted response returned no final content');
          return content;
        }
        if (completedToolRounds >= RUNTIME_BUDGETS.maxToolRounds) {
          throw new Error('Tool-assisted response exceeded maximum function-calling rounds');
        }

        const toolResults = await Promise.all(toolCalls.map(call => toolRegistry.execute(call)));
        requestMessages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        }, ...toolResults);
        completedToolRounds += 1;
      }
    } catch (error) {
      console.error(`Tool-assisted response failed for ${currentModel}:`, error);
      for (const fallbackModel of this.getModelFallbackCandidates(currentModel, 'chat_tools', true)) {
        if (attemptedModels.has(fallbackModel)) continue;
        try {
          return await this.generateChatResponse(messages, fallbackModel, sessionKey, chatId, onTextDelta, attemptedModels, allowAgentJobs, allowMutatingTools);
        } catch (fallbackError) {
          console.error(`Tool-capable fallback failed for ${fallbackModel}:`, fallbackError);
        }
      }

      console.error('All tool-capable models failed; falling back to a text-only response.');
      return await this.generateTrackedResponse(this.modelAPI, messages, currentModel, 'chat');
    }
  }

  private isToolCapableModel(currentModel: string): boolean {
    return this.config.openaiModels.includes(currentModel) ||
      this.config.googleModels.includes(currentModel) ||
      this.config.openaiCompatibleModels.includes(currentModel);
  }

  private buildChatMessages(inputs: {
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
      ambientMessages: inputs.promptState.botSettings.ambientMemory ? inputs.promptState.ambientMessages : [],
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
      replyStyle: this.getReplyStyleInstruction(inputs.promptState.botSettings.replyStyle),
      stableMemory: stableMemoryBlock,
      recentTurns: inputs.promptState.recentTurns,
      volatileContext: volatileContextBlock,
      dateTimeContext: inputs.includeCurrentDateTime ? this.getCurrentDateTimeInstruction(inputs.promptText) : null,
      userMessage: inputs.promptText,
    });
  }

  private buildCurrentSubjectHint(
    recentTurns: MemoryTurn[],
    promptText: string,
    replyContext: string | null,
  ): string | null {
    if (!this.hasAmbiguousFollowUpReference(promptText)) {
      return null;
    }

    const sourceTexts = [
      replyContext,
      ...recentTurns.slice(-6).map(turn => turn.content),
    ].filter((text): text is string => !!text);

    const subject = this.extractLikelySubject(sourceTexts);
    if (!subject) {
      return null;
    }

    return [
      `Likely current subject from the immediate thread: ${subject}.`,
      'Resolve pronouns such as they, their, it, and this from the immediate thread first.',
      'Treat older group memory, active topics, and ambient chatter as background only if they conflict.',
    ].join(' ').slice(0, TelegramBot.MAX_SUBJECT_HINT_CHARS);
  }

  private hasAmbiguousFollowUpReference(text: string): boolean {
    return /\b(they|them|their|theirs|it|its|this|that|these|those)\b/i.test(text) &&
      !this.extractLikelySubject([text]);
  }

  private extractLikelySubject(texts: string[]): string | null {
    const candidates = new Map<string, number>();
    const stopPhrases = new Set([
      'Group',
      'Assistant',
      'User',
      'Current',
      'Recent',
      'Memory',
      'Live',
      'Wikipedia',
      'Stock',
      'Not',
      'The',
      'They',
      'So',
      'But',
      'Add',
    ]);

    for (const text of texts.slice().reverse()) {
      const cleaned = text
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/@\w+/g, ' ')
        .replace(/\b[A-Z]{2,5}\d{0,2}\b/g, ' ');
      const matches = cleaned.match(/\b[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3}\b/g) || [];
      for (const rawMatch of matches) {
        const candidate = rawMatch.trim().replace(/[.,:;!?)]$/, '');
        if (
          candidate.length < 3 ||
          stopPhrases.has(candidate) ||
          /^(I|You|We|He|She|It|This|That|There|Here|What|Why|When|Where|How)$/i.test(candidate)
        ) {
          continue;
        }
        const hasCompanySignal = /\b(Semiconductors?|Photonics?|Systems?|Technologies?|Corporation|Corp|Inc|Ltd|AB|AG|NV|PLC|Group|Holdings?)\b/.test(candidate);
        const score = hasCompanySignal ? 4 : candidate.split(/\s+/).length;
        candidates.set(candidate, (candidates.get(candidate) || 0) + score);
      }
    }

    return [...candidates.entries()]
      .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)[0]?.[0] || null;
  }

  private getLatestUserMessageContent(messages: Message[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === 'user' && typeof message.content === 'string') {
        return message.content;
      }
    }
    return '';
  }

  private selectToolNames(text: string, canUseWebSearch: boolean): string[] {
    const selected: string[] = [];
    if (canUseWebSearch && this.shouldForceWebSearch(text)) {
      selected.push('web_search');
    }
    if (this.shouldForceWikipediaLookup(text)) {
      selected.push('wikipedia_lookup');
    }
    if (selected.length === 0) {
      if (canUseWebSearch && /\b(latest|current|today|now|recent|news|price|weather|score|release|update)\b/i.test(text)) {
        selected.push('web_search');
      } else {
        selected.push('wikipedia_lookup');
      }
    }
    return selected;
  }

  private shouldForceStockQuoteLookup(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return /\b(prices?|stock prices?|share prices?|quote|ticker|market cap)\b/i.test(normalized) &&
      (/\b(now|right now|current|currently|latest|today|live|check|recent|recently|this week|this month)\b/i.test(normalized) ||
        /\$[a-z]{1,10}(?:\.[a-z]{1,8})?\b/i.test(text));
  }

  private shouldForceWebSearch(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const financePrompt =
      /\b(prices?|stock prices?|share prices?|quote|ticker|market cap)\b/i.test(normalized) &&
      (/\b(now|right now|current|currently|latest|today|live|check|recent|recently|this week|this month)\b/i.test(normalized) || /\$[a-z]{1,10}\b/i.test(text));
    const currentEventsPrompt =
      /\b(news|breaking|latest|today|what happened|weather|forecast|score|result|results)\b/i.test(normalized) &&
      /\b(now|right now|current|currently|latest|today|live|breaking)\b/i.test(normalized);
    const explicitWebPrompt =
      /\b(google|find online|check online|web search|use (?:your )?search(?: tool)?)\b/i.test(normalized);
    const genericLookupWithWebSignals =
      /\b(search|look up|lookup)\b/i.test(normalized) &&
      /\b(latest|current|today|tonight|yesterday|recent|breaking|news|happened|situation|instagram|post|tweet|twitter|x\.com|tiktok|reddit|article|source|sources)\b/i.test(normalized);

    return financePrompt || currentEventsPrompt || explicitWebPrompt || genericLookupWithWebSignals;
  }

  private shouldForceWikipediaLookup(text: string): boolean {
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
    ].some(pattern => pattern.test(normalized));
    const webOrCurrentSignals =
      /\b(latest|current|today|tonight|tomorrow|yesterday|now|recent|breaking|news|weather|forecast|score|result|results|price|stock|market|version|release|update|happened|situation|instagram|post|tweet|twitter|x\.com|tiktok|reddit|article|source|sources|google|online|web search|search tool)\b/i.test(normalized);

    return stableLookupPrompt && !webOrCurrentSignals;
  }

  private buildForcedWebSearchQuery(text: string): string {
    const trimmed = text.trim();
    if (/\$[a-z]{1,10}\b/i.test(trimmed)) {
      return `${trimmed} stock price`;
    }
    return trimmed;
  }

  private buildContextAwareWebSearchQuery(text: string, messages: Message[]): string {
    const trimmed = text.trim();
    if (!this.hasAmbiguousFollowUpReference(trimmed) || /\$[a-z]{1,10}\b/i.test(trimmed)) {
      return this.buildForcedWebSearchQuery(trimmed);
    }

    const previousMessages = messages
      .slice(0, -1)
      .map(message => typeof message.content === 'string' ? message.content : '')
      .filter(Boolean);
    const subject = this.extractLikelySubject(previousMessages);
    if (!subject) {
      return this.buildForcedWebSearchQuery(trimmed);
    }

    return `${subject} ${trimmed}`;
  }

  private async generateGroundedLiveResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    searchBroker: SearchBroker,
    sessionKey: string,
  ): Promise<string | null> {
    const toolCall: ToolCall = {
      id: crypto.randomUUID(),
      type: 'function',
      function: {
        name: 'web_search',
        arguments: JSON.stringify({
          query: this.buildContextAwareWebSearchQuery(latestUserMessage, messages),
        }),
      },
    };

    const toolResult = await this.runWebSearchTool(toolCall, searchBroker, sessionKey);
    const searchContent = typeof toolResult.content === 'string' ? toolResult.content.trim() : '';
    if (!searchContent || searchContent.startsWith('Web search failed:')) {
      return null;
    }

    const groundedMessages: Message[] = [
      ...messages,
      {
        role: 'system',
        content: [
          'Live web search results for the latest user request are attached below.',
          'Use them as the factual grounding for any current or recent claims.',
          'If they are thin or ambiguous, say so briefly instead of inventing details.',
          'Answer directly and keep it concise.',
          `Live web search results:\n${searchContent}`,
        ].join(' '),
      },
    ];

    return await this.generateTrackedResponse(this.modelAPI, groundedMessages, currentModel, 'chat_tools');
  }

  private buildForcedWikipediaQuery(text: string): string {
    return text
      .trim()
      .replace(/\b(?:look up|lookup|search|find|tell me about|on wikipedia|wikipedia|wiki)\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async generateGroundedWikipediaResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    wikipediaAPI: WikipediaAPI,
  ): Promise<string | null> {
    const query = this.buildForcedWikipediaQuery(latestUserMessage) || latestUserMessage.trim();
    const toolCall: ToolCall = {
      id: crypto.randomUUID(),
      type: 'function',
      function: {
        name: 'wikipedia_lookup',
        arguments: JSON.stringify({ query }),
      },
    };

    const toolResult = await runWikipediaTool(toolCall, wikipediaAPI);
    const wikipediaContent = typeof toolResult.content === 'string' ? toolResult.content.trim() : '';
    if (!wikipediaContent || wikipediaContent.startsWith('Wikipedia lookup failed:')) {
      return null;
    }

    const groundedMessages: Message[] = [
      ...messages,
      {
        role: 'system',
        content: [
          'Wikipedia lookup results for the latest user request are attached below.',
          'Use them as factual grounding for stable encyclopedia-style claims.',
          'If the result looks like the wrong subject or a disambiguation, say so briefly.',
          'Answer directly and keep it concise.',
          `Wikipedia lookup results:\n${wikipediaContent}`,
        ].join(' '),
      },
    ];

    return await this.generateTrackedResponse(this.modelAPI, groundedMessages, currentModel, 'chat_tools');
  }

  private async generateGroundedStockResponse(
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
          role: 'system',
          content: [
            'A dedicated stock quote lookup result is attached below.',
            'Use it as the factual grounding for any price or market-cap claims in your reply.',
            'If the user mainly asked for the current price, lead with the price and keep it brief.',
            'Do not invent extra market data beyond the attached lookup.',
            `Stock quote lookup:\n${quoteContent}`,
          ].join(' '),
        },
      ];

      return await this.generateTrackedResponse(this.modelAPI, groundedMessages, currentModel, 'chat_tools');
    } catch (error) {
      console.error('Dedicated EODHD stock quote lookup failed:', error);
      return null;
    }
  }

  private async generateGroundedYahooStockResponse(
    messages: Message[],
    currentModel: string,
    latestUserMessage: string,
    yahooFinanceAPI: YahooFinanceAPI,
  ): Promise<string | null> {
    try {
      const lookupQuery = this.buildContextAwareWebSearchQuery(latestUserMessage, messages);
      const quoteContent = await yahooFinanceAPI.lookupStockQuote(lookupQuery);
      const groundedMessages: Message[] = [
        ...messages,
        {
          role: 'system',
          content: [
            'A Yahoo Finance stock quote lookup result is attached below.',
            'Use it as the factual grounding for stock price, market-cap, volume, valuation, and trading-session claims in your reply.',
            'If the user mainly asked for the current price or recent move, lead with the quote data and keep it brief.',
            'Do not invent extra market data beyond the attached lookup.',
            `Yahoo Finance lookup:\n${quoteContent}`,
          ].join(' '),
        },
      ];

      return await this.generateTrackedResponse(this.modelAPI, groundedMessages, currentModel, 'chat_tools');
    } catch (error) {
      console.error('Yahoo Finance stock quote lookup failed:', error);
      return null;
    }
  }

  private shouldIncludeCurrentDateTime(text: string, _toolMode: boolean = false): boolean {
    return /\b(time|date|day|today|tonight|tomorrow|yesterday|now|current|latest|recent|this week|this month)\b/i.test(text);
  }

  private canUseWebSearch(searchBroker: SearchBroker): boolean {
    return searchBroker.isConfigured();
  }

  private getToolsInstruction(): string {
    return [
      'Operate in a bounded observe-act-observe loop: decide whether a tool is needed, inspect its result, and continue until the request is actually complete.',
      'Own the information-gathering step when a missing fact materially affects the answer.',
      'Use web_search for current, recent, niche, or uncertain facts; read_url for a user-supplied page; wikipedia_lookup for stable encyclopedic facts; stock_quote for live market quotes; and the specialist utility tools for calculations, weather, currency, GitHub, papers, reminders, and saved memory.',
      'Use no tool when the request is conversational, opinion-based, creative, or answerable confidently from the supplied context.',
      'Do not call tools speculatively or repeat a lookup that already produced enough evidence.',
      'Do not ask the user to paste facts or do the lookup when an available tool can retrieve them.',
      'If a tool fails or returns thin evidence, inspect the failure and try one sensible alternative when available.',
      'Before the final answer, silently check that every requested lookup or action succeeded; never claim an action succeeded without a successful tool result.',
      'Only create, cancel, remember, or forget something when the user clearly asked for that state change.',
      'When the user asks for a specific filing, document, or deep link, return the exact verified page instead of a generic portal.',
      'When you use a tool, do it silently and answer directly.',
      'Do not mention tool calls, searching, lookups, or sources unless the user explicitly asks.',
      'Do not say things like "based on the latest reporting" or "according to Wikipedia".',
      'Do not dump links, citations, or a "Sources" section by default.',
      'If the results are thin or conflicting, say so briefly instead of faking certainty.',
    ].join(' ');
  }

  private async runWebSearchTool(toolCall: ToolCall, searchBroker: SearchBroker, sessionKey: string): Promise<Message> {
    const fallback = (error: string): Message => ({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: `Web search failed: ${error}`,
    });

    const parsedArgs = (() => {
      try {
        return JSON.parse(toolCall.function.arguments || '{}') as { query?: string };
      } catch {
        return {} as { query?: string };
      }
    })();
    const query = parsedArgs.query?.trim();
    if (!query) {
      return fallback('Missing query.');
    }

    try {
      const response = await searchBroker.search(query);
      await this.saveLastSources(sessionKey, response);
      const results = formatSearchResponseForModel(response, 3_500);
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: results,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown web search error.';
      console.error('Error executing web search tool:', error);
      return fallback(message);
    }
  }

  private async runReadUrlTool(
    toolCall: ToolCall,
    reader: URLReader,
    searchBroker: SearchBroker,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<Message> {
    const fallback = (error: string): Message => ({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: `URL read failed: ${error}`,
    });
    const parsedArgs = (() => {
      try {
        return JSON.parse(toolCall.function.arguments || '{}') as { url?: string };
      } catch {
        return {} as { url?: string };
      }
    })();
    const rawUrl = parsedArgs.url?.trim();
    if (!rawUrl) return fallback('Missing URL.');

    let url: string;
    try {
      url = reader.validateUrl(rawUrl).toString();
    } catch (error) {
      return fallback(error instanceof Error ? error.message : 'Invalid URL.');
    }

    try {
      const page = await reader.read(url, signal);
      await this.saveLastSources(sessionKey, {
        provider: 'url_reader',
        query: url,
        searchedAt: new Date().toISOString(),
        sources: [{ title: page.title || page.url, url: page.url }],
      });
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `PAGE: ${page.title || page.url}\nURL: ${page.url}\nCONTENT:\n${page.text.slice(0, 3_500)}`,
      };
    } catch (readError) {
      if (searchBroker.isConfigured()) {
        try {
          const response = await searchBroker.search(`\"${url}\"`);
          await this.saveLastSources(sessionKey, response);
          return {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Direct page reading was blocked. Indexed web evidence follows.\n${formatSearchResponseForModel(response, 3_500)}`,
          };
        } catch (searchError) {
          console.error('Error recovering a blocked URL through web search:', searchError);
        }
      }
      const message = readError instanceof Error ? readError.message : 'Unknown URL reader error.';
      console.error('Error executing URL reader tool:', readError);
      return fallback(message);
    }
  }

  private getCurrentDateString(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private getCurrentDateTimeInstruction(promptText: string): string {
    const asksForClockTime = /\b(time|what time|right now)\b/i.test(promptText);
    const now = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(asksForClockTime ? {
        hour: '2-digit' as const,
        minute: '2-digit' as const,
        hour12: false,
      } : {}),
    }).format(new Date());

    return asksForClockTime
      ? `Current local date and time is ${now} GMT+8 (Asia/Kuala_Lumpur). Use this timezone unless the user explicitly asks for another timezone.`
      : `Current local date is ${now} in Asia/Kuala_Lumpur. Use this date for current, recent, and relative-date questions.`;
  }

  private async runReminderTool(toolCall: ToolCall, sessionKey: string, chatId: number): Promise<Message> {
    const args = parseToolArguments<{ action?: string; schedule?: string; text?: string; id?: string }>(toolCall);
    try {
      if (args.action === 'create') {
        const schedule = args.schedule?.trim();
        const text = args.text?.trim();
        if (!schedule || !text) return toolFailure(toolCall, 'Reminder action', 'Create requires schedule and text.');
        return toolSuccess(toolCall, await this.addReminder(chatId, sessionKey, `${schedule} ${text}`));
      }
      if (args.action === 'list') {
        return toolSuccess(toolCall, await this.listReminders(sessionKey) || 'No reminders are scheduled.');
      }
      if (args.action === 'cancel') {
        if (!args.id?.trim()) return toolFailure(toolCall, 'Reminder action', 'Cancel requires a reminder ID.');
        const removed = await this.removeReminder(sessionKey, args.id);
        return removed
          ? toolSuccess(toolCall, `Cancelled reminder ${args.id}: ${removed}`)
          : toolFailure(toolCall, 'Reminder action', `No reminder found with ID ${args.id}.`);
      }
      return toolFailure(toolCall, 'Reminder action', 'Unknown action.');
    } catch (error) {
      return toolFailure(toolCall, 'Reminder action', error instanceof Error ? error.message : 'Reminder action failed.');
    }
  }

  private async runMemoryTool(toolCall: ToolCall, sessionKey: string): Promise<Message> {
    const args = parseToolArguments<{ action?: string; text?: string }>(toolCall);
    const text = args.text?.trim();
    if (!text) return toolFailure(toolCall, 'Memory action', 'Missing memory text or query.');
    try {
      if (args.action === 'remember') {
        const id = await this.rememberDurableMemory(sessionKey, text);
        return toolSuccess(toolCall, `Saved durable memory ${id}.`);
      }
      if (args.action === 'recall') {
        return toolSuccess(toolCall, await this.recallDurableMemory(sessionKey, text) || 'No matching durable memory found.');
      }
      if (args.action === 'forget') {
        const removed = await this.forgetSavedMemory(sessionKey, text);
        return removed
          ? toolSuccess(toolCall, `Forgot ${removed}.`)
          : toolFailure(toolCall, 'Memory action', 'No single matching memory found. Ask the user to identify the exact memory or ID.');
      }
      return toolFailure(toolCall, 'Memory action', 'Unknown action.');
    } catch (error) {
      return toolFailure(toolCall, 'Memory action', error instanceof Error ? error.message : 'Memory action failed.');
    }
  }

  private async runAgentJobTool(toolCall: ToolCall, sessionKey: string, chatId: number): Promise<Message> {
    const args = parseToolArguments<{ action?: string; goal?: string; id?: string }>(toolCall);
    try {
      if (args.action === 'create') {
        const goal = args.goal?.trim();
        if (!goal) return toolFailure(toolCall, 'Agent job action', 'Create requires a self-contained goal.');
        const run = await this.createAgentRun(chatId, sessionKey, goal);
        return toolSuccess(toolCall, `Queued background agent job ${run.id}. It will normally start on the next five-minute cron wake.`);
      }
      if (args.action === 'list') {
        return toolSuccess(toolCall, await this.listAgentRuns(sessionKey) || 'No background agent jobs found.');
      }
      if (args.action === 'cancel') {
        if (!args.id?.trim()) return toolFailure(toolCall, 'Agent job action', 'Cancel requires an agent job ID.');
        const run = await this.cancelAgentRun(sessionKey, args.id);
        if (run) {
          await this.publishAgentRunTransition(new AgentRunStore(this.redis), run)
            .catch(error => console.error(`Failed to publish cancelled agent job ${run.id}:`, error));
        }
        return run
          ? toolSuccess(toolCall, `Cancelled background agent job ${run.id}.`)
          : toolFailure(toolCall, 'Agent job action', `No active agent job found with ID ${args.id}.`);
      }
      return toolFailure(toolCall, 'Agent job action', 'Unknown action.');
    } catch (error) {
      return toolFailure(toolCall, 'Agent job action', error instanceof Error ? error.message : 'Agent job action failed.');
    }
  }

  private getProcessedUpdateKey(updateId: number): string {
    return `processed_update:${updateId}`;
  }

  private async markUpdateAsProcessed(updateId: number): Promise<boolean> {
    try {
      return await this.redis.setIfNotExists(
        this.getProcessedUpdateKey(updateId),
        '1',
        TelegramBot.PROCESSED_UPDATE_TTL_SECONDS,
      );
    } catch (error) {
      console.error('Redis update deduplication unavailable; processing update in degraded mode:', error);
      return true;
    }
  }

  private getSummaryModel(currentModel: string): string {
    return this.getRoleModel('summary', currentModel);
  }

  private getRoleModel(role: ModelRole, fallbackModel: string): string {
    const configuredByRole: Record<ModelRole, string | undefined> = {
      utility: this.config.utilityModel,
      summary: this.config.summaryModel,
      research: this.config.researchModel,
      vision: this.config.visionModel,
    };
    const configured = configuredByRole[role];
    if (role === 'vision' && (!configured || configured.toLowerCase() === 'auto')) {
      if (this.config.visionModels.includes(fallbackModel) && this.isConfiguredModel(fallbackModel)) {
        return fallbackModel;
      }
      const availableVisionModel = this.config.visionModels.find(model => this.isConfiguredModel(model));
      if (availableVisionModel) return availableVisionModel;
      console.warn(`No configured model in VISION_MODELS is available. Falling back to ${fallbackModel}.`);
      return fallbackModel;
    }
    if (!configured) return fallbackModel;
    const normalized = this.normalizeModelName(configured);
    if (this.isConfiguredModel(normalized) && (role !== 'vision' || this.config.visionModels.length === 0 || this.config.visionModels.includes(normalized))) {
      return normalized;
    }
    console.warn(`Configured ${role} model "${configured}" is not available. Falling back to ${fallbackModel}.`);
    return fallbackModel;
  }

  private async getMonthlyWebSearchUsage(): Promise<number> {
    const raw = await this.redis.get(this.getMonthlyWebSearchUsageKey());
    const parsed = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private getMonthlyWebSearchUsageKey(): string {
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    return `web_search_usage:${month}`;
  }

  private async getFileUrl(fileId: string): Promise<string> {
    const data = await fetchJson<{ ok: boolean; result: { file_path: string } }>(`https://api.telegram.org/bot${this.token}/getFile?file_id=${fileId}`, {}, 'Failed to get file URL');
    if (data.ok) {
      return `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`;
    }
    throw new Error('Failed to get file URL');
  }


  private async resolveCurrentModel(sessionKey: string, storedModel: string | null): Promise<string> {
    if (storedModel) {
      const normalizedModel = this.normalizeModelName(storedModel);
      if (normalizedModel !== storedModel) {
        await this.redis.set(`model:${sessionKey}`, normalizedModel);
      }

      if (this.isConfiguredModel(normalizedModel)) {
        return normalizedModel;
      }

      console.warn(`Stored model "${storedModel}" is no longer configured. Falling back to default model.`);
    }

    if (this.config.defaultModel) {
      const normalizedDefault = this.normalizeModelName(this.config.defaultModel);
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
        throw new Error('No OpenAI compatible models are available');
      }
      return compatibleModels[0];
    }

    throw new Error('No valid model configuration found');
  }

  async getCurrentModel(sessionKey: string): Promise<string> {
    try {
      const storedModel = await this.redis.get(`model:${sessionKey}`);
      return await this.resolveCurrentModel(sessionKey, storedModel);
    } catch (error) {
      console.error('Redis model lookup unavailable; using configured default:', error);
      return await this.resolveCurrentModel(sessionKey, null);
    }
  }

  private isConfiguredModel(model: string): boolean {
    return [
      ...this.config.openaiModels,
      ...this.config.googleModels,
      ...this.config.groqModels,
      ...this.config.claudeModels,
      ...this.config.azureModels,
      ...this.config.openaiCompatibleModels,
    ].includes(model);
  }

  private parseBotSettings(raw: string | null): BotSettings {
    const defaultSettings = this.getDefaultBotSettings();
    if (!raw) {
      return defaultSettings;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<BotSettings>;
      return {
        ambientMemory: typeof parsed.ambientMemory === 'boolean' ? parsed.ambientMemory : defaultSettings.ambientMemory,
        replyStyle: parsed.replyStyle === 'short' || parsed.replyStyle === 'normal' || parsed.replyStyle === 'long'
          ? parsed.replyStyle
          : defaultSettings.replyStyle,
      };
    } catch (error) {
      console.error('Error parsing bot settings:', error);
      return defaultSettings;
    }
  }

  private getDefaultBotSettings(): BotSettings {
    return {
      ...TelegramBot.DEFAULT_SETTINGS,
      ambientMemory: this.config.ambientMemoryDefault,
    };
  }

  private parseRecentTurnsRaw(raw: string | null): MemoryTurn[] {
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as MemoryTurn[];
      return parsed.filter(turn =>
        turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string',
      );
    } catch (error) {
      console.error('Error parsing recent turns:', error);
      return [];
    }
  }

  private parseDurableMemoriesRaw(raw: string | null): DurableMemory[] {
    return parseDurableMemories(raw);
  }

  private async loadPromptState(sessionKey: string, initialBotSettings?: BotSettings): Promise<PromptState> {
    try {
      return await this.loadPromptStateFromRedis(sessionKey, initialBotSettings);
    } catch (error) {
      console.error('Redis prompt state unavailable; continuing without stored memory:', error);
      return {
        botSettings: initialBotSettings || (isGroupSession(sessionKey) ? this.getDefaultBotSettings() : TelegramBot.DEFAULT_SETTINGS),
        groupProfile: null,
        personCards: [],
        activeTopics: [],
        conversationSummary: null,
        recentTurns: [],
        ambientMessages: [],
        seenMembers: [],
        durableMemories: [],
        currentModel: await this.resolveCurrentModel(sessionKey, null),
      };
    }
  }

  private async loadPromptStateFromRedis(sessionKey: string, initialBotSettings?: BotSettings): Promise<PromptState> {
    const isGroup = isGroupSession(sessionKey);
    const commonKeys = [
      `model:${sessionKey}`,
      conversationSummaryKey(sessionKey),
      recentTurnsKey(sessionKey),
      durableMemoryKey(sessionKey),
    ];

    const groupKeys = isGroup
      ? [
          ...(initialBotSettings ? [] : [botSettingsKey(sessionKey)]),
          groupProfileKey(sessionKey),
          personCardsKey(sessionKey),
          activeTopicsKey(sessionKey),
          seenMembersKey(sessionKey),
        ]
      : [];

    const rawValues = await this.redis.getMany([...commonKeys, ...groupKeys]);
    const storedModel = rawValues[0] ?? null;
    const rawSummary = rawValues[1] ?? null;
    const rawRecentTurns = rawValues[2] ?? null;
    const rawDurableMemories = rawValues[3] ?? null;
    let offset = 4;
    const rawBotSettings = initialBotSettings ? null : (rawValues[offset++] ?? null);
    const rawGroupProfile = isGroup ? (rawValues[offset++] ?? null) : null;
    const rawPersonCards = isGroup ? (rawValues[offset++] ?? null) : null;
    const rawActiveTopics = isGroup ? (rawValues[offset++] ?? null) : null;
    const rawSeenMembers = isGroup ? (rawValues[offset++] ?? null) : null;

    const botSettings = isGroup
      ? (initialBotSettings ?? this.parseBotSettings(rawBotSettings ?? null))
      : TelegramBot.DEFAULT_SETTINGS;

    const rawAmbientMessages = isGroup && botSettings.ambientMemory
      ? (await this.redis.getMany([ambientMessagesKey(sessionKey)]))[0]
      : null;

    return {
      botSettings,
      groupProfile: isGroup ? ((rawGroupProfile ?? null) as string | null) : null,
      personCards: isGroup ? parsePersonCards(rawPersonCards ?? null) : [],
      activeTopics: isGroup ? parseActiveTopics(rawActiveTopics ?? null) : [],
      conversationSummary: (rawSummary ?? null) as string | null,
      recentTurns: this.parseRecentTurnsRaw(rawRecentTurns ?? null),
      ambientMessages: isGroup && botSettings.ambientMemory ? parseAmbientMessages(rawAmbientMessages) : [],
      seenMembers: isGroup ? parseSeenMembers(rawSeenMembers ?? null) : [],
      durableMemories: this.parseDurableMemoriesRaw(rawDurableMemories ?? null),
      currentModel: await this.resolveCurrentModel(sessionKey, storedModel ?? null),
    };
  }

  async setCurrentModel(sessionKey: string, model: string): Promise<void> {
    await this.redis.set(`model:${sessionKey}`, model);
    console.log(`Switching to model: ${model}`);
    this.modelAPI = await this.initializeModelAPI(sessionKey);
  }

  getAvailableModels(): string[] {
    return this.modelAPI.getAvailableModels();
  }

  isValidModel(model: string): boolean {
    return this.modelAPI.isValidModel(model);
  }

  async clearContext(sessionKey: string, chatId: number, userId?: string): Promise<void> {
    await this.redis.del(`context:${sessionKey}`);
    await this.redis.del(recentTurnsKey(sessionKey));
    await this.redis.del(conversationSummaryKey(sessionKey));
    await this.redis.del(ambientMessagesKey(sessionKey));
    await this.redis.del(activeTopicsKey(sessionKey));
    await this.sendMessageWithFallback(chatId, translate('new_conversation'));
  }

  async getGroupProfile(sessionKey: string): Promise<string | null> {
    if (!isGroupSession(sessionKey)) {
      return null;
    }

    return await this.redis.get(groupProfileKey(sessionKey));
  }

  async setGroupProfile(sessionKey: string, profile: string): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      throw new Error('Group profile is only available in group chats.');
    }

    await this.redis.set(
      groupProfileKey(sessionKey),
      profile.trim(),
      this.getContextTTL(),
    );
  }

  async getSelectableModels(): Promise<string[]> {
    const availableModels = [
      ...this.config.openaiModels,
      ...this.config.googleModels,
      ...this.config.groqModels,
      ...this.config.claudeModels,
      ...this.config.azureModels,
    ];
    if (this.config.openaiCompatibleUrl) {
      try {
        availableModels.push(...await new OpenAICompatibleAPI(this.env).getModels());
      } catch (error) {
        console.error('Failed to load OpenAI-compatible models for picker:', error);
        availableModels.push(...this.config.openaiCompatibleModels);
      }
    }
    return [...new Set(availableModels)];
  }

  async appendGroupProfile(sessionKey: string, note: string): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      throw new Error('Group profile is only available in group chats.');
    }

    await this.redis.withLock(groupProfileKey(sessionKey), async () => {
      const existingProfile = await this.getGroupProfile(sessionKey);
      const updatedProfile = existingProfile
        ? `${existingProfile}\n- ${note.trim()}`
        : `- ${note.trim()}`;
      await this.redis.set(
        groupProfileKey(sessionKey),
        updatedProfile,
        this.getContextTTL(),
      );
    });
  }

  async clearGroupProfile(sessionKey: string): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      throw new Error('Group profile is only available in group chats.');
    }

    await this.redis.del(groupProfileKey(sessionKey));
  }

  async getFormattedPersonCards(sessionKey: string): Promise<string | null> {
    const cards = await this.getPersonCards(sessionKey);
    if (cards.length === 0) {
      return null;
    }
    return cards
      .map(card => {
        const freshness = describeFreshness(card.lastUpdatedAt);
        return `${card.name} [${freshness}]\n${card.notes.map(n => `  - ${n}`).join('\n')}`;
      })
      .join('\n\n');
  }

  async getFormattedActiveTopics(sessionKey: string): Promise<string | null> {
    const topics = await this.getActiveTopics(sessionKey);
    if (topics.length === 0) {
      return null;
    }
    return topics
      .map(topic => {
        const status = topic.status ? ` (${topic.status})` : '';
        const freshness = describeFreshness(topic.lastUpdatedAt);
        return `- ${topic.topic}${status} [${freshness}]`;
      })
      .join('\n');
  }

  async getFormattedSummary(sessionKey: string): Promise<string | null> {
    return await this.getConversationSummary(sessionKey);
  }

  async rememberDurableMemory(sessionKey: string, text: string): Promise<string> {
    const normalizedText = text.trim().replace(/\s+/g, ' ').slice(0, 500);
    if (!normalizedText) throw new Error('Memory text is empty');

    return await this.redis.withLock(durableMemoryKey(sessionKey), async () => {
      const memories = await this.getDurableMemories(sessionKey);
      const duplicate = memories.find(memory => normalizeMemoryText(memory.text) === normalizeMemoryText(normalizedText));
      if (duplicate) return duplicate.id;

      const identity = getMemoryIdentity(normalizedText);
      const correction = identity
        ? memories.find(memory => getMemoryIdentity(memory.text) === identity)
        : undefined;
      if (correction) {
        correction.text = normalizedText;
        correction.type = inferMemoryType(normalizedText);
        correction.updatedAt = new Date().toISOString();
        await this.setDurableMemories(sessionKey, memories);
        return correction.id;
      }

      const now = new Date().toISOString();
      const memory: DurableMemory = {
        id: crypto.randomUUID().slice(0, 8),
        scope: isGroupSession(sessionKey) ? 'group' : 'private',
        type: inferMemoryType(normalizedText),
        text: normalizedText,
        createdAt: now,
        updatedAt: now,
      };
      memories.push(memory);
      await this.setDurableMemories(sessionKey, memories.slice(-TelegramBot.MAX_DURABLE_MEMORIES));
      return memory.id;
    });
  }

  async recallDurableMemory(sessionKey: string, query: string): Promise<string | null> {
    const memories = await this.getDurableMemories(sessionKey);
    if (memories.length === 0) return null;
    const ranked = rankDurableMemories(memories, query, 10);
    if (ranked.length === 0) return null;
    return ranked.map(memory => `- [${memory.id}] (${memory.type}) ${memory.text}`).join('\n');
  }

  async forgetSavedMemory(sessionKey: string, query: string): Promise<string | null> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;
    return await this.redis.withLock(durableMemoryKey(sessionKey), async () => {
      const memories = await this.getDurableMemories(sessionKey);
      const exactId = memories.find(memory => memory.id.toLowerCase() === normalized);
      const textMatches = memories.filter(memory => memory.text.toLowerCase().includes(normalized));
      const target = exactId || (textMatches.length === 1 ? textMatches[0] : undefined);
      if (!target) return null;
      await this.setDurableMemories(sessionKey, memories.filter(memory => memory.id !== target.id));
      return `[${target.id}] ${target.text}`;
    });
  }

  private async getDurableMemories(sessionKey: string): Promise<DurableMemory[]> {
    return this.parseDurableMemoriesRaw(await this.redis.get(durableMemoryKey(sessionKey)));
  }

  private async setDurableMemories(sessionKey: string, memories: DurableMemory[]): Promise<void> {
    await this.redis.set(durableMemoryKey(sessionKey), JSON.stringify(memories));
  }


  async deletePersonCard(sessionKey: string, name: string): Promise<boolean> {
    if (!isGroupSession(sessionKey)) {
      return false;
    }

    return await this.redis.withLock(personCardsKey(sessionKey), async () => {
      const cards = await this.getPersonCards(sessionKey);
      const lowerName = name.toLowerCase();
      const filtered = cards.filter(card => card.name.toLowerCase() !== lowerName);
      if (filtered.length === cards.length) {
        return false;
      }
      await this.setPersonCards(sessionKey, filtered);
      return true;
    });
  }

  async getBotSettings(sessionKey: string): Promise<BotSettings> {
    if (!isGroupSession(sessionKey)) {
      return TelegramBot.DEFAULT_SETTINGS;
    }

    try {
      const raw = await this.redis.get(botSettingsKey(sessionKey));
      return this.parseBotSettings(raw);
    } catch (error) {
      console.error('Redis bot settings unavailable; using defaults:', error);
      return this.getDefaultBotSettings();
    }
  }

  async setBotSettings(sessionKey: string, settings: Partial<BotSettings>): Promise<BotSettings> {
    if (!isGroupSession(sessionKey)) {
      throw new Error('Bot settings are only available in group chats.');
    }

    return await this.redis.withLock(botSettingsKey(sessionKey), async () => {
      const current = await this.getBotSettings(sessionKey);
      const merged: BotSettings = {
        ambientMemory: settings.ambientMemory ?? current.ambientMemory,
        replyStyle: settings.replyStyle ?? current.replyStyle,
      };

      await this.redis.set(
        botSettingsKey(sessionKey),
        JSON.stringify(merged),
        this.getContextTTL(),
      );

      return merged;
    });
  }

  async summarizeHistory(sessionKey: string): Promise<string> {
    this.modelAPI = await this.initializeModelAPI(sessionKey);

    const conversationSummary = await this.getConversationSummary(sessionKey);
    const recentTurns = await this.getRecentTurns(sessionKey);
    const groupProfile = await this.getGroupProfile(sessionKey);
    const personCards = await this.getPersonCards(sessionKey);
    const activeTopics = await this.getActiveTopics(sessionKey);
    if (!conversationSummary && recentTurns.length === 0 && !groupProfile && personCards.length === 0 && activeTopics.length === 0) {
      return translate('no_history');
    }

    const currentModel = await this.getCurrentModel(sessionKey);
    console.log(`Summarizing history with model: ${currentModel}`);

    let messages: Message[] = [
      { role: 'system' as const, content: `Summarize the following conversation in English:` },
      ...(groupProfile ? [{ role: 'system' as const, content: `Persistent group profile for this chat:\n${groupProfile}` }] : []),
      ...(personCards.length > 0 ? [{ role: 'system' as const, content: `Person cards:\n${formatPersonCards(personCards)}` }] : []),
      ...(activeTopics.length > 0 ? [{ role: 'system' as const, content: `Active topics:\n${formatActiveTopics(activeTopics)}` }] : []),
      ...(conversationSummary ? [{ role: 'system' as const, content: `Rolling memory summary:\n${conversationSummary}` }] : []),
      ...recentTurns,
      ...(recentTurns.length === 0 ? [{ role: 'user' as const, content: 'No recent chat history available.' }] : [])
    ];

    const summary = await this.generateTrackedResponse(this.modelAPI, messages, currentModel, 'summary');
    return `${translate('history_summary')}\n\n${summary}`;
  }

  /**
   * Telegram converts a basic group to a supergroup on its own, and the
   * supergroup gets an id unrelated to the old one. Any WHITELISTED_GROUPS
   * entry then stops matching and the bot simply goes quiet in a chat that
   * looks unchanged, so say so loudly rather than leaving it to be guessed.
   *
   * The whitelist is deliberately not rewritten here: it is an authorization
   * boundary, and it should not repoint itself in response to an inbound
   * message.
   */
  private reportChatMigration(message: TelegramTypes.Message): void {
    const migratedTo = message.migrate_to_chat_id;
    if (migratedTo !== undefined) {
      console.error(
        `Telegram group ${message.chat.id} has migrated to supergroup ${migratedTo}. ` +
        `Update WHITELISTED_GROUPS to "${migratedTo}" or the bot will stop answering there.`,
      );
      return;
    }
    const migratedFrom = message.migrate_from_chat_id;
    if (migratedFrom !== undefined && !this.isGroupWhitelisted(message.chat.id)) {
      console.error(
        `Received traffic from supergroup ${message.chat.id}, migrated from group ${migratedFrom}, ` +
        'which is not in WHITELISTED_GROUPS. Update it to restore access.',
      );
    }
  }

  isUserWhitelisted(userId: string): boolean {
    return this.whitelistedUsers.includes(userId);
  }

  isGroupWhitelisted(chatId: number): boolean {
    return this.whitelistedGroups.includes(String(chatId));
  }

  /**
   * A user is authorized if they are individually whitelisted, or if they are
   * speaking inside a whitelisted group. A group grant is scoped to that group:
   * it does not carry over into private chats, which have no group to check.
   */
  isAuthorized(input: { userId: string; chatId: number; chatType: TelegramTypes.Chat['type'] }): boolean {
    // Deny by default. An unset whitelist previously authorized every Telegram
    // user who could reach the webhook.
    if (this.whitelistedUsers.length === 0 && this.whitelistedGroups.length === 0) {
      console.error(
        'Neither WHITELISTED_USERS nor WHITELISTED_GROUPS is configured; denying every request. ' +
        'Set WHITELISTED_USERS to numeric Telegram user IDs and/or WHITELISTED_GROUPS to numeric group chat IDs.',
      );
      return false;
    }
    if (this.isUserWhitelisted(input.userId)) return true;
    return input.chatType !== 'private' && this.isGroupWhitelisted(input.chatId);
  }

  isOwner(userId: string): boolean {
    // Ownership must be stated, never inferred. Inferring it from a
    // single-entry whitelist meant adding a second user silently revoked it.
    const configuredOwner = this.config.ownerUserId;
    return !!configuredOwner && configuredOwner === userId;
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
      this.usageTracker.getReport('day'),
      this.usageTracker.getReport('month'),
      this.getMonthlyWebSearchUsage(),
    ]);

    const format = (label: string, report: Awaited<ReturnType<UsageTracker['getReport']>>): string => {
      const averageLatency = report.calls > 0 ? Math.round(report.totalLatencyMs / report.calls) : 0;
      return translateMessage('usage_period', {
        label, period: report.period, calls: report.calls, successes: report.successes, errors: report.errors,
        tokens: report.totalTokens, prompt: report.promptTokens, completion: report.completionTokens,
        average: averageLatency, p95: report.p95LatencyMs === null ? 'n/a' : `${report.p95LatencyMs} ms`,
        searches: report.searchCalls,
      });
    };

    return [
      translateMessage('usage_title'),
      '',
      format(translateMessage('usage_today'), daily),
      '',
      format(translateMessage('usage_month'), monthly),
      '',
      translateMessage('usage_legacy_search', { used: monthlySearchUsage, cap: this.config.exaMonthlySearchCap }),
    ].join('\n');
  }

  async getCacheReport(sessionKey: string): Promise<string> {
    const currentModel = await this.getCurrentModel(sessionKey);
    const deepSeekModels = this.config.openaiCompatibleModels.filter(model => /deepseek/i.test(model));
    const models = deepSeekModels.length > 0 ? deepSeekModels : [currentModel];
    const reports = await Promise.all(models.flatMap(model => [
      this.usageTracker.getModelCacheReport('day', model),
      this.usageTracker.getModelCacheReport('month', model),
    ]));

    const lines = [translateMessage('cache_title')];
    for (const report of reports) {
      const measuredTokens = report.cacheHitTokens + report.cacheMissTokens;
      const hitRate = measuredTokens > 0 ? ((report.cacheHitTokens / measuredTokens) * 100).toFixed(1) : 'n/a';
      lines.push('', translateMessage('cache_period', {
        model: report.model, period: report.period, calls: report.calls, prompt: report.promptTokens,
        hits: report.cacheHitTokens, misses: report.cacheMissTokens,
        rate: `${hitRate}${hitRate === 'n/a' ? '' : '%'}`,
      }));
    }
    return lines.join('\n');
  }

  async getLastSources(sessionKey: string): Promise<string | null> {
    const raw = await this.redis.get(lastSourcesKey(sessionKey));
    if (!raw) return null;
    try {
      const response = JSON.parse(raw) as SearchResponse;
      if (!Array.isArray(response.sources) || response.sources.length === 0) return null;
      const sources = response.sources.slice(0, RUNTIME_BUDGETS.maxSources).map((source, index) => {
          const hostname = (() => {
            try { return new URL(source.url).hostname; } catch { return 'unknown host'; }
          })();
          const published = source.publishedAt ? `; published ${source.publishedAt}` : '';
          return `${index + 1}. ${source.title} (${hostname}${published})\n${source.url}`;
        }).join('\n');
      return translateMessage('source_report', { query: response.query, provider: response.provider, sources });
    } catch (error) {
      console.error('Failed to parse saved sources:', error);
      return null;
    }
  }

  async research(sessionKey: string, question: string): Promise<string> {
    const searchBroker = this.createSearchBroker();
    if (!searchBroker.isConfigured()) {
      throw new Error('No research search provider is configured');
    }

    const queries = this.buildResearchQueries(question);
    const searchResults = await Promise.allSettled(queries.map(query => searchBroker.search(query, 6)));
    const responses = searchResults
      .filter((result): result is PromiseFulfilledResult<SearchResponse> => result.status === 'fulfilled')
      .map(result => result.value);
    await this.assertCurrentTaskActive(sessionKey);
    if (responses.length === 0) {
      throw new Error('Every research search failed');
    }

    const sources = this.rankResearchSources(responses.flatMap(response => response.sources));
    const pages = await Promise.allSettled(
      sources.slice(0, RUNTIME_BUDGETS.maxPagesRead).map(source => this.readPageWithTimeout(source.url)),
    );
    const pageEvidence = pages
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<URLReader['read']>>> => result.status === 'fulfilled')
      .map(result => `PAGE: ${result.value.title || result.value.url}\nURL: ${result.value.url}\n${result.value.text.slice(0, 8_000)}`);
    await this.assertCurrentTaskActive(sessionKey);
    const searchEvidence = responses.map(response => formatSearchResponseForModel(response, 4_000));
    const combinedResponse: SearchResponse = {
      provider: [...new Set(responses.map(response => response.provider))].join(', '),
      query: question,
      searchedAt: new Date().toISOString(),
      sources: sources.slice(0, RUNTIME_BUDGETS.maxSources),
    };
    await this.saveLastSources(sessionKey, combinedResponse);

    const selectedModel = await this.getCurrentModel(sessionKey);
    const currentModel = this.getRoleModel('research', selectedModel);
    const api = await this.getModelAPIForModel(currentModel);
    await this.assertCurrentTaskActive(sessionKey);
    const messages: Message[] = [
      {
        role: 'system',
        content: [
          'Produce a concise, evidence-grounded research answer.',
          'Prioritize primary and authoritative sources, distinguish facts from inference, and call out meaningful conflicts or weak evidence.',
          'Do not invent claims beyond the evidence. Do not add a separate source list because the application appends one.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Research question:\n${question}\n\nEvidence:\n${[...searchEvidence, ...pageEvidence].join('\n\n').slice(0, 20_000)}`,
      },
    ];
    const answer = await this.generateTrackedResponse(api, messages, currentModel, 'research');
    const sourceList = sources.slice(0, 5).map((source, index) => `${index + 1}. [${source.title}](${source.url})`).join('\n');
    return `${answer}\n\n${translateMessage('research_sources')}\n${sourceList}`;
  }

  async readUrl(sessionKey: string, url: string): Promise<string> {
    const page = await this.readPageWithTimeout(url);
    await this.assertCurrentTaskActive(sessionKey);
    await Promise.all([
      this.saveLastSources(sessionKey, {
        provider: 'url_reader',
        query: url,
        searchedAt: new Date().toISOString(),
        sources: [{ title: page.title || page.url, url: page.url }],
      }),
      this.redis.set(
        lastReadKey(sessionKey),
        JSON.stringify({ ...page, text: page.text.slice(0, 12_000), savedAt: new Date().toISOString() }),
        TelegramBot.LAST_SOURCES_TTL_SECONDS,
      ),
    ]);

    const selectedModel = await this.getCurrentModel(sessionKey);
    const currentModel = this.getRoleModel('research', selectedModel);
    const api = await this.getModelAPIForModel(currentModel);
    await this.assertCurrentTaskActive(sessionKey);
    return await this.generateTrackedResponse(api, [
      {
        role: 'system',
        content: 'Summarize the supplied webpage accurately and concisely. Identify the main point, important details, and any obvious limitations. Do not invent missing content.',
      },
      {
        role: 'user',
        content: `URL: ${page.url}\nTitle: ${page.title || 'Unknown'}\n\nPage text:\n${page.text.slice(0, 18_000)}`,
      },
    ], currentModel, 'research');
  }

  async compareModels(sessionKey: string, question: string): Promise<string> {
    const selectedModel = await this.getCurrentModel(sessionKey);
    const candidates = [...new Set([
      selectedModel,
      this.getRoleModel('utility', selectedModel),
      this.getRoleModel('research', selectedModel),
    ])].slice(0, 2);
    if (candidates.length < 2) {
      throw new Error('Configure UTILITY_MODEL or RESEARCH_MODEL to a different available model');
    }

    const responses = await Promise.allSettled(candidates.map(async model => {
      const api = await this.getModelAPIForModel(model);
      const content = await this.generateTrackedResponse(api, [
        { role: 'system', content: 'Answer the user directly and independently. Be concise, accurate, and do not refer to another model response.' },
        { role: 'user', content: question },
      ], model, 'compare');
      return { model, content };
    }));

    const successful = responses
      .filter((result): result is PromiseFulfilledResult<{ model: string; content: string }> => result.status === 'fulfilled')
      .map(result => result.value);
    await this.assertCurrentTaskActive(sessionKey);
    if (successful.length === 0) throw new Error('Both comparison models failed');
    return successful.map(result => `## ${result.model}\n${result.content}`).join('\n\n');
  }

  async addBookmark(sessionKey: string, rawUrl: string, title?: string): Promise<void> {
    const url = new URLReader().validateUrl(rawUrl).toString();
    await this.redis.withLock(bookmarksKey(sessionKey), async () => {
      const bookmarks = await this.getBookmarks(sessionKey);
      const existing = bookmarks.find(bookmark => bookmark.url === url);
      if (existing) {
        if (title?.trim()) existing.title = title.trim().slice(0, 200);
      } else {
        bookmarks.push({
          id: crypto.randomUUID().slice(0, 8),
          url,
          title: title?.trim().slice(0, 200) || new URL(url).hostname,
          createdAt: new Date().toISOString(),
        });
      }
      await this.redis.set(bookmarksKey(sessionKey), JSON.stringify(bookmarks.slice(-50)));
    });
  }

  async listBookmarks(sessionKey: string): Promise<string | null> {
    const bookmarks = await this.getBookmarks(sessionKey);
    if (bookmarks.length === 0) return null;
    return bookmarks.map((bookmark, index) => `${index + 1}. [${bookmark.id}] ${bookmark.title}\n${bookmark.url}`).join('\n\n');
  }

  async removeBookmark(sessionKey: string, query: string): Promise<string | null> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;
    return await this.redis.withLock(bookmarksKey(sessionKey), async () => {
      const bookmarks = await this.getBookmarks(sessionKey);
      const matches = bookmarks.filter(bookmark => bookmark.id.toLowerCase() === normalized || bookmark.title.toLowerCase().includes(normalized));
      if (matches.length !== 1) return null;
      const target = matches[0];
      await this.redis.set(bookmarksKey(sessionKey), JSON.stringify(bookmarks.filter(bookmark => bookmark.id !== target.id)));
      return `${target.title} (${target.url})`;
    });
  }

  private async getBookmarks(sessionKey: string): Promise<Bookmark[]> {
    const raw = await this.redis.get(bookmarksKey(sessionKey));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Bookmark[];
      return Array.isArray(parsed) ? parsed.filter(bookmark => bookmark && typeof bookmark.id === 'string' && typeof bookmark.url === 'string' && typeof bookmark.title === 'string') : [];
    } catch {
      return [];
    }
  }

  private buildResearchQueries(question: string): string[] {
    const trimmed = question.trim();
    const currentSignals = /\b(latest|current|today|recent|news|now)\b/i.test(trimmed);
    return [...new Set([
      trimmed,
      `${trimmed} primary sources`,
      `${trimmed} ${currentSignals ? this.getCurrentDateString() : 'analysis evidence'}`,
    ])].slice(0, 3);
  }

  private rankResearchSources(sources: SearchSource[]): SearchSource[] {
    const seen = new Set<string>();
    return sources
      .filter(source => {
        if (seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      })
      .map((source, index) => ({
        source,
        score: (source.snippet ? 3 : 0) + (source.publishedAt ? 2 : 0) + (/\.(gov|edu)(\/|$)/i.test(source.url) ? 4 : 0) - index * 0.01,
      }))
      .sort((left, right) => right.score - left.score)
      .map(item => item.source)
      .slice(0, RUNTIME_BUDGETS.maxSources);
  }

  private async readPageWithTimeout(url: string): Promise<Awaited<ReturnType<URLReader['read']>>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      return await new URLReader().read(url, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async saveLastSources(sessionKey: string, response: SearchResponse): Promise<void> {
    await this.redis.set(
      lastSourcesKey(sessionKey),
      JSON.stringify({ ...response, sources: response.sources.slice(0, RUNTIME_BUDGETS.maxSources) }),
      TelegramBot.LAST_SOURCES_TTL_SECONDS,
    );
  }

  async isUserGroupAdmin(chatId: number, userId: string): Promise<boolean> {
    const result = await fetchJson<TelegramTypes.GetChatMemberResult>(`${this.apiUrl}/getChatMember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        user_id: parseInt(userId),
      }),
    }, 'Failed to get chat member');
    if (!result.ok) {
      throw new Error('Failed to get chat member');
    }
    return result.result.status === 'creator' || result.result.status === 'administrator';
  }

  async syncCommands(): Promise<void> {
    await this.setMenuButton();
    await this.redis.set(TelegramBot.COMMAND_SCHEMA_KEY, this.getCommandSchemaFingerprint());
  }

  private async syncCommandsIfStale(): Promise<void> {
    if (await this.getCommandMenuStatus() === 'current') return;
    await this.redis.withLock(TelegramBot.COMMAND_SCHEMA_KEY, async () => {
      if (await this.getCommandMenuStatus() === 'stale') await this.syncCommands();
    }, { ttlSeconds: 30, retries: 1 });
  }

  async beginCancellableTask(sessionKey: string, type: string): Promise<string> {
    const record: ActiveTaskRecord = {
      id: crypto.randomUUID(),
      type: type.slice(0, 40),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await this.redis.set(this.getActiveTaskKey(sessionKey), JSON.stringify(record), TelegramBot.ACTIVE_TASK_TTL_SECONDS);
    return record.id;
  }

  async assertTaskActive(sessionKey: string, taskId: string): Promise<void> {
    const record = await this.getActiveTask(sessionKey);
    if (!record || record.id !== taskId || record.status === 'cancelled') throw new Error(translateMessage('task_cancelled'));
  }

  private async assertCurrentTaskActive(sessionKey: string): Promise<void> {
    const record = await this.getActiveTask(sessionKey);
    if (record?.status === 'cancelled') throw new Error(translateMessage('task_cancelled'));
  }

  async finishCancellableTask(sessionKey: string, taskId: string): Promise<void> {
    await this.redis.withLock(this.getActiveTaskKey(sessionKey), async () => {
      const record = await this.getActiveTask(sessionKey);
      if (record?.id === taskId) await this.redis.del(this.getActiveTaskKey(sessionKey));
    });
  }

  async cancelActiveTask(sessionKey: string): Promise<string | null> {
    return await this.redis.withLock(this.getActiveTaskKey(sessionKey), async () => {
      const record = await this.getActiveTask(sessionKey);
      if (!record || record.status !== 'running') return null;
      await this.redis.set(
        this.getActiveTaskKey(sessionKey),
        JSON.stringify({ ...record, status: 'cancelled' } satisfies ActiveTaskRecord),
        TelegramBot.ACTIVE_TASK_TTL_SECONDS,
      );
      return record.type;
    });
  }

  private async getActiveTask(sessionKey: string): Promise<ActiveTaskRecord | null> {
    const raw = await this.redis.get(this.getActiveTaskKey(sessionKey));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as ActiveTaskRecord;
      return record && typeof record.id === 'string' && typeof record.type === 'string' &&
        (record.status === 'running' || record.status === 'cancelled') ? record : null;
    } catch {
      return null;
    }
  }

  async getStatus(sessionKey: string): Promise<TelegramStatus> {
    const settings = await this.getBotSettings(sessionKey);
    const [currentModel, groupProfile, summary, recentTurns, ambientMessages, seenMembers, personCards, activeTopics] = await Promise.all([
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
      this.getRoleModel('summary', currentModel),
      this.getRoleModel('research', currentModel),
      this.getRoleModel('vision', currentModel),
      ...this.config.modelFallbacks,
    ];
    const modelProviders = Array.from(new Set(roleModels.map(model => this.getProviderIdForModel(model))));
    const [modelProviderHealth, searchProviderHealth, searchQuotas, commandMenuStatus] = await Promise.all([
      this.usageTracker.getProviderHealth('model', modelProviders).catch(() => []),
      this.usageTracker.getProviderHealth('search', this.config.searchProviders).catch(() => []),
      this.getSearchQuotaStatus().catch(() => []),
      this.getCommandMenuStatus(),
    ]);

    return {
      currentModel,
      summaryModel: this.getRoleModel('summary', currentModel),
      researchModel: this.getRoleModel('research', currentModel),
      visionModel: this.getRoleModel('vision', currentModel),
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

  private async getCommandMenuStatus(): Promise<'current' | 'stale'> {
    return await this.redis.get(TelegramBot.COMMAND_SCHEMA_KEY) === this.getCommandSchemaFingerprint()
      ? 'current'
      : 'stale';
  }

  private getCommandSchemaFingerprint(): string {
    const schema = this.commands
      .map(command => `${command.name}:${command.description}`)
      .sort()
      .join('|');
    let hash = 2166136261;
    for (let index = 0; index < schema.length; index += 1) {
      hash ^= schema.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  private async getSearchQuotaStatus(): Promise<Array<{ provider: string; used: number; cap: number | null }>> {
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    return await Promise.all(this.config.searchProviders.map(async provider => {
      const cap = provider === 'exa'
        ? this.config.exaMonthlySearchCap
        : provider === 'openai'
          ? this.config.openaiSearchMonthlyCap
          : provider === 'gemini_grounding'
            ? this.config.geminiSearchMonthlyCap
            : null;
      const [current, legacy] = await Promise.all([
        this.redis.get(`search_usage:v1:${provider}:${month}`),
        provider === 'exa' ? this.redis.get(`web_search_usage:${month}`) : Promise.resolve(null),
      ]);
      return {
        provider,
        used: (Number.parseInt(current || '0', 10) || 0) + (Number.parseInt(legacy || '0', 10) || 0),
        cap,
      };
    }));
  }

  async runTextShortcut(
    sessionKey: string,
    task: 'translate' | 'rewrite' | 'summarize',
    text: string,
    target?: string,
  ): Promise<string> {
    const selectedModel = await this.getCurrentModel(sessionKey);
    const model = this.getRoleModel('utility', selectedModel);
    const api = await this.getModelAPIForModel(model);
    const instruction = task === 'translate'
      ? `Translate the user text into ${target || 'English'}. Preserve meaning, tone, names, formatting, and URLs. Return only the translation.`
      : task === 'rewrite'
        ? 'Rewrite the user text to be clearer and more natural while preserving its meaning and language. Return only the rewritten text.'
        : 'Summarize the user text concisely. Preserve important facts, decisions, dates, and action items. Return only the summary.';
    return await this.generateTrackedResponse(api, [
      { role: 'system', content: instruction },
      { role: 'user', content: text.slice(0, 20_000) },
    ], model, 'utility');
  }

  async addReminder(chatId: number, sessionKey: string, input: string): Promise<string> {
    const parsed = parseReminderInput(input);
    if (parsed.dueAt <= Date.now()) throw new Error(translateMessage('reminder_in_past'));
    const job: ScheduledJob = {
      id: createJobId(),
      type: 'reminder',
      chatId,
      sessionKey,
      nextAt: parsed.dueAt,
      createdAt: Date.now(),
      recurrence: parsed.recurrence,
      payload: { text: parsed.text.slice(0, 2_000) },
    };
    await new SharedScheduler(this.redis).schedule(job);
    return translateMessage('reminder_set', {
      id: job.id,
      time: this.formatScheduledTime(job.nextAt),
      recurrence: job.recurrence ? ` (${job.recurrence})` : '',
    });
  }

  async createAgentRun(chatId: number, sessionKey: string, goal: string): Promise<AgentRun> {
    return await new AgentRunStore(this.redis).create({ chatId, sessionKey, goal });
  }

  private boxJobs(): BoxJobService {
    return new BoxJobService(this.env, this.redis, {
      sendMessage: async (chatId, text) => await this.sendMessageWithFallback(chatId, text),
      sendDocument: async (chatId, documentUrl, filename, caption) => {
        await this.transport.sendDocument(chatId, documentUrl, filename, caption);
      },
    });
  }

  private artifactGateway(): ArtifactGateway {
    return new ArtifactGateway(this.env, this.redis);
  }

  private boxSchedules(): BoxScheduleService {
    return new BoxScheduleService(this.env, this.redis, async (chatId, text) => await this.sendMessageWithFallback(chatId, text));
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

  async handleBoxArtifactUpload(request: Request, artifactId: string): Promise<Response> {
    return await this.artifactGateway().upload(request, artifactId);
  }

  async handleArtifactDownload(request: Request, artifactId: string): Promise<Response> {
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
    const queued = await this.boxJobs().queue({ chatId, sessionKey, userId, request, requestedRoute, files });
    await this.sendMessageWithFallback(
      chatId,
      `Queued Box job ${queued.job.id} (${queued.job.route}, ${queued.job.model}).\nUse /agent status ${queued.job.id} or /agent cancel ${queued.job.id}.`,
    );
    this.runBackground(`provisionBoxJob:${queued.job.id}`, queued.provision);
  }

  async runQuickChat(chatId: number, sessionKey: string, _userId: string, request: string): Promise<void> {
    const promptState = await this.loadPromptState(sessionKey);
    this.modelAPI = await this.getModelAPIForModel(promptState.currentModel);
    const response = await this.generateChatResponse(
      this.buildChatMessages({ promptState, promptText: request, replyContext: null, includeCurrentDateTime: this.shouldIncludeCurrentDateTime(request) }),
      promptState.currentModel,
      sessionKey,
      chatId,
    );
    await this.rememberConversation(sessionKey, request, response, promptState.currentModel);
    await this.sendMessageWithFallback(chatId, response);
  }

  async getBoxAgentStatus(chatId: number, userId: string, jobId?: string): Promise<string> {
    const result = await this.boxJobs().getStatus(chatId, userId, this.isOwner(userId), jobId);
    const jobs = Array.isArray(result) ? result : [result];
    if (jobs.length === 0) return 'No Box jobs found in this chat.';
    return jobs.map(job => this.formatBoxJobStatus(job)).join('\n\n');
  }

  async cancelBoxAgentJob(chatId: number, userId: string, jobId: string): Promise<string> {
    const job = await this.boxJobs().cancel(chatId, userId, this.isOwner(userId), jobId);
    return `Canceled Box job ${job.id}.`;
  }

  async approveBoxAgentJob(chatId: number, userId: string, jobId: string, nonce: string): Promise<string> {
    if (!this.isOwner(userId)) throw new Error('Only the bot owner can approve Box actions.');
    const job = await this.boxJobs().approve(chatId, userId, jobId, nonce);
    return `Approved Box job ${job.id}; the protected action is resuming.`;
  }

  async createBoxAgentSchedule(chatId: number, userId: string, cron: string, prompt: string, requestedRoute?: string): Promise<string> {
    const record = await this.boxSchedules().create({ chatId, ownerUserId: userId, cron, prompt, requestedRoute });
    return `Created Box schedule ${record.id}: ${record.cron} UTC (${record.route}, ${record.status}).`;
  }

  async listBoxAgentSchedules(chatId: number, userId: string): Promise<string> {
    const records = await this.boxSchedules().list(chatId, userId);
    if (records.length === 0) return 'No Box schedules found in this chat.';
    return records.map(record => `${record.id}: ${record.status}\n${record.cron} UTC · ${record.route}\n${record.prompt.slice(0, 300)}\nRuns: ${record.totalRuns}, failures: ${record.totalFailures}`).join('\n\n');
  }

  async changeBoxAgentSchedule(chatId: number, userId: string, id: string, action: 'pause' | 'resume' | 'delete'): Promise<string> {
    const record = await this.boxSchedules().change(chatId, userId, id, action);
    return `Box schedule ${record.id}: ${record.status}.`;
  }

  async getArtifactLink(chatId: number, userId: string, artifactId: string): Promise<string> {
    const result = await this.artifactGateway().getDownloadForUser({
      artifactId,
      chatId,
      userId,
      owner: this.isOwner(userId),
    });
    return `${result.artifact.filename}\nDownload link (24 hours): ${result.url}`;
  }

  private formatBoxJobStatus(job: BoxJob): string {
    const cost = job.cost ? `\nCost: $${job.cost.totalUsd.toFixed(4)}` : '';
    const detail = job.status === 'succeeded' ? job.result : job.error || job.terminalReason;
    return `${job.id}: ${job.status}\nRoute: ${job.route} (${job.model})${detail ? `\n${detail.replace(/\s+/g, ' ').slice(0, 400)}` : ''}${cost}`;
  }

  async listAgentRuns(sessionKey: string): Promise<string | null> {
    const runs = await new AgentRunStore(this.redis).list(sessionKey);
    if (runs.length === 0) return null;
    return runs.slice(0, 10).map(run => {
      const detail = run.status === 'completed' && run.result
        ? ` — ${run.result.replace(/\s+/g, ' ').slice(0, 160)}`
        : run.status === 'failed' && run.lastError
          ? ` — ${run.lastError.replace(/\s+/g, ' ').slice(0, 160)}`
          : '';
      const phase = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
        ? run.status
        : `${run.phase}, wake ${run.wakeCount}/${run.maxWakes}`;
      const current = run.phase === 'executing' && run.plan[run.currentStep]
        ? `\n  Current: ${run.plan[run.currentStep].title}`
        : '';
      return `- ${run.id}: ${phase}\n  ${run.goal}${current}${detail}`;
    }).join('\n');
  }

  async cancelAgentRun(sessionKey: string, id: string): Promise<AgentRun | null> {
    return await new AgentRunStore(this.redis).cancel(sessionKey, id);
  }

  async listReminders(sessionKey: string): Promise<string | null> {
    const jobs = (await new SharedScheduler(this.redis).list(sessionKey)).filter(job => job.type === 'reminder');
    if (jobs.length === 0) return null;
    return jobs.map(job => `- ${job.id}: ${job.payload.text}\n  ${this.formatScheduledTime(job.nextAt)}${job.recurrence ? ` (${job.recurrence})` : ''}`).join('\n');
  }

  async removeReminder(sessionKey: string, id: string): Promise<string | null> {
    const job = await new SharedScheduler(this.redis).cancel(sessionKey, id, 'reminder');
    return job?.type === 'reminder' ? job.payload.text || job.id : null;
  }

  async addFeedSubscription(sessionKey: string, url: string): Promise<string> {
    const feed = await readFeed(url, 1, AbortSignal.timeout(10_000));
    const subscriptions = await this.getFeedSubscriptions(sessionKey);
    const normalizedUrl = new URL(url).toString();
    const existing = subscriptions.find(subscription => subscription.url === normalizedUrl);
    if (existing) return existing.id;
    const subscription: FeedSubscription = {
      id: createJobId(),
      url: normalizedUrl,
      title: feed.title || new URL(normalizedUrl).hostname,
      createdAt: new Date().toISOString(),
    };
    subscriptions.push(subscription);
    await this.redis.set(feedSubscriptionsKey(sessionKey), JSON.stringify(subscriptions.slice(-10)));
    return subscription.id;
  }

  async listFeedSubscriptions(sessionKey: string): Promise<string | null> {
    const subscriptions = await this.getFeedSubscriptions(sessionKey);
    return subscriptions.length > 0
      ? subscriptions.map(item => `- ${item.id}: ${item.title}\n  ${item.url}`).join('\n')
      : null;
  }

  async removeFeedSubscription(sessionKey: string, id: string): Promise<string | null> {
    const subscriptions = await this.getFeedSubscriptions(sessionKey);
    const target = subscriptions.find(item => item.id.toLowerCase() === id.trim().toLowerCase());
    if (!target) return null;
    await this.redis.set(feedSubscriptionsKey(sessionKey), JSON.stringify(subscriptions.filter(item => item.id !== target.id)));
    return target.title;
  }

  async addDigest(chatId: number, sessionKey: string, input: string): Promise<string> {
    const parsed = parseDigestInput(input);
    if (parsed.mode === 'feeds' && (await this.getFeedSubscriptions(sessionKey)).length === 0) {
      throw new Error(translateMessage('follow_feed_first'));
    }
    const job: ScheduledJob = {
      id: createJobId(), type: 'digest', chatId, sessionKey,
      nextAt: parsed.dueAt, createdAt: Date.now(), recurrence: parsed.recurrence,
      payload: { mode: parsed.mode, ...(parsed.query ? { query: parsed.query.slice(0, 500) } : {}) },
    };
    await new SharedScheduler(this.redis).schedule(job);
    return translateMessage('digest_scheduled', {
      id: job.id, time: this.formatScheduledTime(job.nextAt), recurrence: job.recurrence || '', mode: parsed.mode,
    });
  }

  async listDigests(sessionKey: string): Promise<string | null> {
    const jobs = (await new SharedScheduler(this.redis).list(sessionKey)).filter(job => job.type === 'digest');
    return jobs.length > 0
      ? jobs.map(job => `- ${job.id}: ${job.payload.mode}${job.payload.query ? ` ${job.payload.query}` : ''}\n  ${this.formatScheduledTime(job.nextAt)} (${job.recurrence})`).join('\n')
      : null;
  }

  async removeDigest(sessionKey: string, id: string): Promise<string | null> {
    const job = await new SharedScheduler(this.redis).cancel(sessionKey, id, 'digest');
    return job?.type === 'digest' ? `${job.payload.mode}${job.payload.query ? ` ${job.payload.query}` : ''}` : null;
  }

  async processScheduledTasks(): Promise<number> {
    let processed = 0;
    try {
      processed += await new SharedScheduler(this.redis).drainDue(async job => {
        if (job.type === 'reminder') {
          await this.sendMessageWithFallback(job.chatId, translateMessage('reminder_alert', { value: job.payload.text }));
          return;
        }
        await this.processDigestJob(job);
      });
    } catch (error) {
      console.error('Scheduled reminders/digests drain failed:', error);
    }
    try {
      processed += await new AgentRunStore(this.redis).retirePending();
    } catch (error) {
      console.error('Legacy agent-run retirement failed:', error);
    }
    try {
      processed += await this.boxJobs().recoverTerminalSideEffects();
    } catch (error) {
      console.error('Box terminal side-effect recovery failed:', error);
    }
    try {
      const boundChatId = await this.boxJobs().getBoundChatId();
      if (boundChatId !== null) processed += await this.boxSchedules().recoverDeliveries(boundChatId);
    } catch (error) {
      console.error('Box schedule delivery recovery failed:', error);
    }
    return processed;
  }

  private async processDueAgentRuns(): Promise<number> {
    const store = new AgentRunStore(this.redis);
    return await store.drainDue(
      async run => {
        await this.ensureAgentProgressMessage(store, run);
        return await this.executeAgentRunWake(run);
      },
      Date.now(),
      async run => this.publishAgentRunTransition(store, run),
    );
  }

  private async executeAgentRunWake(run: AgentRun): Promise<AgentWakeResult> {
    const promptState = await this.loadPromptState(run.sessionKey);
    const model = promptState.currentModel;
    this.modelAPI = await this.getModelAPIForModel(model);

    if (run.phase === 'planning') {
      const response = await this.generateTrackedResponse(this.modelAPI, [
        {
          role: 'system',
          content: [
            'Create a short execution plan for a persistent background agent.',
            'Return only <agent-plan>{"steps":["step 1","step 2"]}</agent-plan>.',
            'Use one to five concrete steps. Each step must fit inside one bounded model-and-tool session.',
            'Make steps independently useful and ordered. Do not include final answer synthesis as a step.',
            'Do not perform the work yet and do not include hidden reasoning.',
          ].join(' '),
        },
        { role: 'user', content: `Goal: ${run.goal}` },
      ], model, 'agent_plan');
      return {
        type: 'planned',
        plan: this.parseAgentPlan(response),
        observation: 'Created a bounded execution plan.',
      };
    }

    if (run.phase === 'finalizing') {
      const response = await this.generateTrackedResponse(this.modelAPI, [
        {
          role: 'system',
          content: [
            'Produce the final user-facing deliverable for this completed background job.',
            'Use the persisted observations as the factual record. Do not invent work that was not completed.',
            'Return only the deliverable, with no progress preamble, internal state, or reasoning trace.',
          ].join(' '),
        },
        {
          role: 'user',
          content: `Goal:\n${run.goal}\n\nCompleted plan:\n${this.formatAgentPlan(run)}\n\nObservations:\n${this.formatAgentObservations(run)}`,
        },
      ], model, 'agent_step');
      return { type: 'completed', result: response };
    }

    const step = run.plan[run.currentStep];
    if (!step) {
      return { type: 'blocked', error: 'The persisted plan has no current executable step.' };
    }
    const messages: Message[] = [
      {
        role: 'system',
        content: [
          'Execute exactly one saved background-agent step using the available read-only tools when useful.',
          'Do not create reminders, change memory, queue jobs, contact third parties, spend money, or mutate external state.',
          'Do not redo completed plan steps. Use prior observations as your starting evidence.',
          'After the step, return only one of these envelopes:',
          '<agent-step>{"status":"advanced","observation":"compact factual work product"}</agent-step>',
          '<agent-step>{"status":"complete","observation":"compact factual work product","final_answer":"finished deliverable"}</agent-step>',
          '<agent-step>{"status":"blocked","observation":"specific blocker"}</agent-step>.',
          'Use complete only if the entire goal is already fulfilled. Use blocked only when another wake cannot make progress.',
          'The observation must preserve useful evidence, conclusions, links, numbers, and unresolved uncertainty without chain-of-thought.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Job: ${run.id}`,
          `Goal: ${run.goal}`,
          `Current step (${run.currentStep + 1}/${run.plan.length}): ${step.title}`,
          `Full plan:\n${this.formatAgentPlan(run)}`,
          `Persisted observations:\n${this.formatAgentObservations(run)}`,
          this.getCurrentDateTimeInstruction('current date and time'),
        ].join('\n\n'),
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

  private parseAgentPlan(response: string): string[] {
    const tagged = response.match(/<agent-plan>\s*([\s\S]*?)\s*<\/agent-plan>/i)?.[1];
    for (const candidate of [tagged, response]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate.trim()) as { steps?: unknown };
        if (Array.isArray(parsed.steps)) {
          const steps = parsed.steps.filter((step): step is string => typeof step === 'string' && !!step.trim());
          if (steps.length > 0) return steps.slice(0, 5);
        }
      } catch {
        // Fall through to line-based recovery for providers that add formatting.
      }
    }
    const recovered = response.split('\n')
      .map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
      .filter(line => line.length >= 4 && !/^<\/?agent-plan/i.test(line))
      .slice(0, 5);
    return recovered.length > 0
      ? recovered
      : ['Gather the evidence needed for the goal', 'Analyze the evidence and resolve uncertainties', 'Prepare the requested deliverable'];
  }

  private parseAgentStepResponse(response: string): AgentWakeResult {
    const tagged = response.match(/<agent-step>\s*([\s\S]*?)\s*<\/agent-step>/i)?.[1];
    for (const candidate of [tagged, response]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate.trim()) as {
          status?: string;
          observation?: string;
          final_answer?: string;
        };
        const observation = parsed.observation?.trim();
        if (parsed.status === 'complete' && parsed.final_answer?.trim()) {
          return { type: 'completed', result: parsed.final_answer.trim(), observation };
        }
        if (parsed.status === 'blocked') {
          return { type: 'blocked', error: observation || 'The current step reported a blocker.' };
        }
        if (parsed.status === 'advanced' && observation) {
          return { type: 'advanced', observation };
        }
      } catch {
        // A useful plain-text step result can still be persisted safely.
      }
    }
    const recovered = response.replace(/<\/?agent-step>/gi, '').trim();
    if (!recovered) throw new Error('Agent step returned no usable observation.');
    return { type: 'advanced', observation: recovered };
  }

  private formatAgentPlan(run: AgentRun): string {
    if (run.plan.length === 0) return 'Not planned yet.';
    return run.plan.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`).join('\n');
  }

  private formatAgentObservations(run: AgentRun): string {
    if (run.observations.length === 0) return 'None yet.';
    return run.observations.slice(-10)
      .map(item => `- ${item.stepId}: ${item.summary.slice(0, 1_500)}`)
      .join('\n');
  }

  private async ensureAgentProgressMessage(store: AgentRunStore, run: AgentRun): Promise<void> {
    const text = this.renderAgentRunProgress(run, true);
    if (run.progressMessageId) {
      await this.replaceProgressMessage(run.chatId, run.progressMessageId, text).catch(error => {
        console.error(`Failed to update running agent job ${run.id}:`, error);
      });
      return;
    }
    const sent = await this.sendMessageWithFallback(run.chatId, text);
    if (sent[0]?.message_id) await store.setProgressMessage(run.id, sent[0].message_id);
  }

  private async publishAgentRunTransition(store: AgentRunStore, run: AgentRun): Promise<void> {
    const latest = await store.getForSession(run.sessionKey, run.id) || run;
    const text = this.renderAgentRunProgress(latest, false);
    if (latest.progressMessageId) {
      await this.replaceProgressMessage(latest.chatId, latest.progressMessageId, text);
    } else {
      const sent = await this.sendMessageWithFallback(latest.chatId, text);
      if (sent[0]?.message_id) await store.setProgressMessage(latest.id, sent[0].message_id);
    }
    if (latest.status === 'completed' && latest.result) {
      const promptText = `[Background agent job ${latest.id}] ${latest.goal}`;
      const selectedModel = await this.getCurrentModel(latest.sessionKey);
      await this.rememberConversation(latest.sessionKey, promptText, latest.result, selectedModel)
        .catch(error => console.error(`Failed to persist agent job ${latest.id} conversation:`, error));
    }
  }

  private renderAgentRunProgress(run: AgentRun, working: boolean): string {
    const header = `Background job ${run.id}`;
    if (run.status === 'completed') return `${header} completed:\n\n${run.result || 'Completed without a result.'}`;
    if (run.status === 'failed') return `${header} failed after ${run.wakeCount} wakes.\n\n${run.lastError || 'Unknown failure.'}`;
    if (run.status === 'cancelled') return `${header} cancelled.`;
    if (run.phase === 'planning') return `${header}\nPlanning the work${working ? '…' : '.'}`;
    if (run.phase === 'finalizing') return `${header}\nAll ${run.plan.length} steps complete. ${working ? 'Preparing the final answer…' : 'Final answer queued for the next wake.'}`;
    const step = run.plan[run.currentStep];
    const done = run.plan.filter(item => item.status === 'completed').length;
    return [
      header,
      `Progress: ${done}/${run.plan.length} steps complete`,
      step ? `${working ? 'Working on' : 'Next'}: ${step.title}` : 'Preparing final answer',
      working ? '' : `Eligible for the next cron wake after: ${this.formatScheduledTime(run.nextAt)}`,
    ].filter(Boolean).join('\n');
  }

  private formatScheduledTime(timestamp: number): string {
    return new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(timestamp));
  }

  private async processDigestJob(job: ScheduledJob): Promise<void> {
    const mode = job.payload.mode;
    let body: string;
    if (mode === 'feeds') {
      const subscriptions = (await this.getFeedSubscriptions(job.sessionKey)).slice(0, RUNTIME_BUDGETS.maxConcurrentOutboundRequests);
      if (subscriptions.length === 0) throw new Error('No feed subscriptions remain.');
      const results = await Promise.allSettled(subscriptions.map(async subscription => ({
        subscription,
        feed: await readFeed(subscription.url, 3, AbortSignal.timeout(10_000)),
      })));
      const sections = results.flatMap(result => result.status === 'fulfilled'
        ? [`${result.value.subscription.title}\n${formatFeed(result.value.feed)}`]
        : []);
      if (sections.length === 0) throw new Error('All subscribed feeds failed.');
      body = sections.join('\n\n');
    } else if (mode === 'search') {
      body = formatSearchResponseForModel(await this.createSearchBroker().search(job.payload.query || '', 5), 3_500);
    } else if (mode === 'stock') {
      body = await new YahooFinanceAPI().lookupStockQuote(job.payload.query || '');
    } else {
      throw new Error(`Unknown digest mode: ${mode}`);
    }
    await this.sendMessageWithFallback(job.chatId, translateMessage('digest_header', { mode, value: body }));
  }

  private async getFeedSubscriptions(sessionKey: string): Promise<FeedSubscription[]> {
    const raw = await this.redis.get(feedSubscriptionsKey(sessionKey));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as FeedSubscription[];
      return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string' && typeof item.url === 'string' && typeof item.title === 'string') : [];
    } catch {
      return [];
    }
  }

  async handleWebhook(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Fail closed. Without a configured secret this endpoint accepted forged
    // updates from anyone who knew the URL.
    const webhookSecret = this.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      console.error(
        'TELEGRAM_WEBHOOK_SECRET is not configured; refusing all webhook traffic. ' +
        'Set it as a Wrangler secret and register the same value as Telegram\'s webhook secret token.',
      );
      return new Response('Forbidden', { status: 403 });
    }
    const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
    if (!constantTimeEqual(headerSecret, webhookSecret)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const update: TelegramTypes.Update = await request.json();
      const shouldProcess = await this.markUpdateAsProcessed(update.update_id);
      if (!shouldProcess) {
        return new Response('OK', { status: 200 });
      }

      const processUpdate = this.handleUpdate(update).catch(error => {
        console.error('Error processing webhook:', error);
      });

      if (this.ctx) {
        this.ctx.waitUntil(processUpdate);
      } else {
        await processUpdate;
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Error processing webhook:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async sendPhoto(chatId: number, photo: string | Uint8Array, options: { caption?: string } = {}): Promise<void> {
    await this.transport.sendPhoto(chatId, photo, options.caption);
  }

  async synthesizeSpeech(text: string): Promise<Uint8Array> {
    const audioApi = new AudioAPI(this.env);
    const startedAt = Date.now();
    try {
      const audio = await audioApi.synthesize(text, AbortSignal.timeout(30_000));
      this.recordModelUsage(audioApi.ttsModel, 'tts', startedAt, true);
      return audio;
    } catch (error) {
      this.recordModelUsage(audioApi.ttsModel, 'tts', startedAt, false, undefined, error);
      throw error;
    }
  }

  async sendVoice(chatId: number, voice: Uint8Array, caption?: string): Promise<void> {
    await this.transport.sendVoice(chatId, voice, caption);
  }

  async setWebhook(url: string): Promise<void> {
    // Registering without a secret token would produce a webhook whose every
    // delivery `handleWebhook` then rejects. Fail here, where it is diagnosable.
    const webhookSecret = this.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET must be set before registering the Telegram webhook.');
    }
    const setWebhookUrl = `${this.apiUrl}/setWebhook`;
    const result = await fetchJson<{ ok: boolean; description?: string }>(setWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, secret_token: webhookSecret }),
    }, 'Failed to set webhook');
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }
  }

  async sendMessageWithFallback(chatId: number, text: string): Promise<TelegramTypes.SendMessageResult[]> {
    return await this.transport.sendMessageWithFallback(chatId, text);
  }

  async replaceProgressMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.transport.replaceProgressMessage(chatId, messageId, text);
  }

  private getUserFacingErrorMessage(error: unknown, ): string {
    const fallback = translate('error');
    if (!(error instanceof Error)) {
      return fallback;
    }

    const message = error.message.toLowerCase();
    if (
      message.includes('429') ||
      message.includes('too many requests') ||
      message.includes('rate limit') ||
      message.includes('fair usage policy') ||
      message.includes('quota exceeded') ||
      message.includes('resource_exhausted')
    ) {
      return `${fallback}\nThe current AI provider is temporarily rate-limiting this bot. Try again later.`;
    }

    if (
      message.includes('unavailable') ||
      message.includes('high demand') ||
      message.includes('service unavailable')
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
  private async setMenuButton(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: this.commands.map(command => ({
          command: command.name,
          description: translate(command.description),
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to set the Telegram command menu: ${response.statusText}`);
    }
  }

  private getSessionKey(chatId: number, userId: string, chatType: TelegramTypes.Chat['type']): string {
    if (chatType === 'private') {
      return userId;
    }
    return `group:${chatId}`;
  }

  private getUserIdFromSessionKey(sessionKey: string): string {
    if (sessionKey.startsWith('group:')) {
      return sessionKey;
    }
    const parts = sessionKey.split(':');
    return parts[parts.length - 1];
  }

  private getDisplayName(user: TelegramTypes.User): string {
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return user.username || fullName || user.id.toString();
  }

  private formatReplyContext(message: TelegramTypes.Message, chatTitle: string): string | null {
    const repliedMessage = message.reply_to_message;
    if (!repliedMessage) {
      return null;
    }

    const repliedSender = repliedMessage.from ? this.getDisplayName(repliedMessage.from) : 'Unknown';
    const repliedText = repliedMessage.text || repliedMessage.caption;
    if (!repliedText) {
      return `[Group: ${chatTitle}]\nThis message is replying to ${repliedSender}, but the original message had no readable text.`;
    }

    const normalizedText = repliedText.replace(/\s+/g, ' ').trim();
    return `[Group: ${chatTitle}]\nThis message is directly replying to ${repliedSender}: ${normalizedText}`;
  }

  private async getSeenMembers(sessionKey: string): Promise<SeenMember[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(seenMembersKey(sessionKey));
    return parseSeenMembers(raw);
  }

  private async rememberSeenMember(sessionKey: string, user: TelegramTypes.User): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.withLock(seenMembersKey(sessionKey), async () => {
      const seenMembers = await this.getSeenMembers(sessionKey);
      const now = new Date().toISOString();
      const displayName = this.getDisplayName(user);
      const existingIndex = seenMembers.findIndex(member => member.userId === user.id.toString());

      if (existingIndex >= 0) {
        const existingMember = seenMembers[existingIndex];
        existingMember.displayName = displayName;
        existingMember.username = user.username;
        existingMember.lastSeenAt = now;
        seenMembers.splice(existingIndex, 1);
        seenMembers.push(existingMember);
      } else {
        seenMembers.push({
          userId: user.id.toString(),
          displayName,
          username: user.username,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }

      while (seenMembers.length > TelegramBot.MAX_SEEN_MEMBERS) {
        seenMembers.shift();
      }

      await this.redis.set(
        seenMembersKey(sessionKey),
        JSON.stringify(seenMembers),
        this.getContextTTL(),
      );
    });
  }

  private async getPersonCards(sessionKey: string): Promise<PersonCard[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(personCardsKey(sessionKey));
    return parsePersonCards(raw);
  }

  private async setPersonCards(sessionKey: string, personCards: PersonCard[]): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.set(
      personCardsKey(sessionKey),
      JSON.stringify(personCards),
      this.getContextTTL(),
    );
  }

  private async getActiveTopics(sessionKey: string): Promise<ActiveTopic[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(activeTopicsKey(sessionKey));
    return parseActiveTopics(raw);
  }

  private async setActiveTopics(sessionKey: string, topics: ActiveTopic[]): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.set(
      activeTopicsKey(sessionKey),
      JSON.stringify(topics),
      this.getContextTTL(),
    );
  }

  private getActiveTaskKey(sessionKey: string): string {
    return `active_task:v1:${sessionKey}`;
  }

  private async getLastReadFollowUpContext(sessionKey: string, promptText: string): Promise<string | null> {
    if (!/\b(this|that|the|previous|last)\s+(page|article|link|url|site)\b|\bwhat does it say\b/i.test(promptText)) {
      return null;
    }
    const raw = await this.redis.get(lastReadKey(sessionKey));
    if (!raw) return null;
    try {
      const page = JSON.parse(raw) as { url?: string; title?: string; text?: string };
      if (!page.url || !page.text) return null;
      return `Previously read page:\nURL: ${page.url}\nTitle: ${page.title || 'Unknown'}\nContent excerpt:\n${page.text.slice(0, 3_000)}`;
    } catch (error) {
      console.error('Failed to parse last read page:', error);
      return null;
    }
  }

  private async getBotUsername(): Promise<string | null> {
    if (this.botUsername) {
      return this.botUsername;
    }

    try {
      const cached = await this.redis.get(TelegramBot.BOT_USERNAME_KEY);
      if (cached) {
        this.botUsername = cached;
        return cached;
      }
    } catch (error) {
      console.error('Error reading cached bot username:', error);
    }

    try {
      const data = await fetchJson<{ ok: boolean; result?: { username?: string } }>(`${this.apiUrl}/getMe`, {}, 'Failed to get bot info');
      if (!data.ok) {
        throw new Error('Failed to get bot info');
      }
      const username = data.result?.username || null;
      this.botUsername = username;
      if (username) {
        this.runBackground('cacheBotUsername', () =>
          this.redis.set(TelegramBot.BOT_USERNAME_KEY, username, TelegramBot.BOT_USERNAME_TTL_SECONDS),
        );
      }
      return username;
    } catch (error) {
      console.error('Error fetching bot username:', error);
      return null;
    }
  }

  private async messageMentionsBot(text: string, entities?: TelegramTypes.MessageEntity[]): Promise<boolean> {
    const botUsername = await this.getBotUsername();
    if (!botUsername) {
      return false;
    }

    if (entities && entities.length > 0) {
      const loweredBotMention = `@${botUsername.toLowerCase()}`;
      for (const entity of entities) {
        if (entity.type !== 'mention') {
          continue;
        }

        const entityText = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
        if (entityText === loweredBotMention) {
          return true;
        }
      }
    }

    const mentionRegex = new RegExp(`(^|\\s)@${botUsername}(?=\\s|$|[,.!?;:])`, 'i');
    return mentionRegex.test(text);
  }

  private async stripBotMention(text: string): Promise<string> {
    const botUsername = await this.getBotUsername();
    if (!botUsername) {
      return text.trim();
    }

    const mentionRegex = new RegExp(`(^|\\s)@${botUsername}(?=\\s|$|[,.!?;:])`, 'ig');
    return text.replace(mentionRegex, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  private async getRecentTurns(sessionKey: string): Promise<MemoryTurn[]> {
    const raw = await this.redis.get(recentTurnsKey(sessionKey));
    return this.parseRecentTurnsRaw(raw);
  }

  private async setRecentTurns(sessionKey: string, turns: MemoryTurn[]): Promise<void> {
    await this.redis.set(
      recentTurnsKey(sessionKey),
      JSON.stringify(turns),
      this.getContextTTL(),
    );
  }

  private async getConversationSummary(sessionKey: string): Promise<string | null> {
    return await this.redis.get(conversationSummaryKey(sessionKey));
  }

  private async setConversationSummary(sessionKey: string, summary: string): Promise<void> {
    await this.redis.set(
      conversationSummaryKey(sessionKey),
      summary,
      this.getContextTTL(),
    );
  }

  private async getAmbientMessages(sessionKey: string): Promise<string[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(ambientMessagesKey(sessionKey));
    return parseAmbientMessages(raw);
  }

  private async setAmbientMessages(sessionKey: string, messages: string[]): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.set(
      ambientMessagesKey(sessionKey),
      JSON.stringify(messages),
      this.getContextTTL(),
    );
  }

  private async rememberAmbientMessage(sessionKey: string, message: string): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    if (!this.shouldStoreAmbientMessage(message)) {
      return;
    }

    await this.redis.withLock(ambientMessagesKey(sessionKey), async () => {
      const ambientMessages = await this.getAmbientMessages(sessionKey);
      ambientMessages.push(this.truncateAmbientMessage(message));

      while (
        ambientMessages.length > TelegramBot.MAX_AMBIENT_MESSAGES ||
        ambientMessages.reduce((total, item) => total + item.length, 0) > TelegramBot.MAX_AMBIENT_CHARS
      ) {
        ambientMessages.shift();
      }

      await this.setAmbientMessages(sessionKey, ambientMessages);
    });
  }

  private async rememberConversation(
    sessionKey: string,
    userContent: string,
    assistantContent: string,
    currentModel: string,
  ): Promise<void> {
    let turnsToSummarize: MemoryTurn[] = [];
    await this.redis.withLock(
      recentTurnsKey(sessionKey),
      async () => {
        const recentTurns = await this.getRecentTurns(sessionKey);
        recentTurns.push(
          { role: 'user', content: userContent },
          { role: 'assistant', content: assistantContent },
        );

        const needsCompaction =
          recentTurns.length > TelegramBot.MAX_RECENT_TURNS ||
          this.getRecentTurnCharCount(recentTurns) > TelegramBot.MAX_RECENT_TURN_CHARS;

        if (needsCompaction) {
          turnsToSummarize = recentTurns.slice(0, Math.max(0, recentTurns.length - TelegramBot.RECENT_TURNS_TO_KEEP));
          const turnsToKeep = recentTurns.slice(-TelegramBot.RECENT_TURNS_TO_KEEP);
          await this.setRecentTurns(sessionKey, turnsToKeep);
        } else {
          await this.setRecentTurns(sessionKey, recentTurns);
        }

        await this.redis.del(`context:${sessionKey}`);
      },
      { ttlSeconds: 30 },
    );

    if (turnsToSummarize.length > 0) {
      this.runBackground('compactConversationMemory', () =>
        this.compactConversationMemory(currentModel, turnsToSummarize, sessionKey),
      );
    }
  }

  private async compactConversationMemory(
    currentModel: string,
    turnsToSummarize: MemoryTurn[],
    sessionKey: string,
  ): Promise<void> {
    const updatedSummary = await this.updateConversationSummary(currentModel, turnsToSummarize, sessionKey);
    if (updatedSummary) {
      await this.setConversationSummary(sessionKey, updatedSummary);
    }
  }

  private async updateConversationSummary(
    currentModel: string,
    turnsToSummarize: MemoryTurn[],
    sessionKey: string,
  ): Promise<string | null> {
    try {
      const summaryModel = this.getSummaryModel(currentModel);
      const summaryApi = await this.getModelAPIForModel(summaryModel);
      const isGroup = isGroupSession(sessionKey);
      const summaryKeys = [
        conversationSummaryKey(sessionKey),
        ...(isGroup
          ? [
              groupProfileKey(sessionKey),
              personCardsKey(sessionKey),
              activeTopicsKey(sessionKey),
              ambientMessagesKey(sessionKey),
            ]
          : []),
      ];
      const rawValues = await this.redis.getMany(summaryKeys);
      let offset = 0;
      const existingSummary = rawValues[offset++] ?? null;
      const existingGroupProfile = isGroup ? (rawValues[offset++] ?? null) : null;
      const existingPersonCards = isGroup ? parsePersonCards(rawValues[offset++] ?? null) : [];
      const existingActiveTopics = isGroup ? parseActiveTopics(rawValues[offset++] ?? null) : [];
      const ambientMessages = isGroup ? parseAmbientMessages(rawValues[offset++] ?? null) : [];

      const transcript = turnsToSummarize
        .map(turn => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`)
        .join('\n');

      const extractionMessages: Message[] = [
        {
          role: 'system',
          content: [
            'Extract durable Telegram group memory and return strict JSON only.',
            `Return an object with keys: "summary", "group_profile_additions", "person_cards", "active_topics".`,
            `"summary" must be a concise rolling summary under ${TelegramBot.MAX_SUMMARY_CHARS} characters.`,
            '"group_profile_additions" must be an array of short durable group facts, jokes, norms, relationships, or preferences worth remembering.',
            '"person_cards" must be an array of objects shaped like {"name":"...", "notes":["...", "..."]} with only durable or repeated social facts.',
            '"active_topics" must be an array of objects shaped like {"topic":"...", "status":"..."} for ongoing threads or current plans. Set status to "resolved" for topics that have concluded, been answered, or are no longer active.',
            'Do not invent facts. Ignore one-off noise. Prefer durable social context, nicknames, recurring dynamics, unresolved plans, and active arguments.',
            'If there is nothing worth adding for a section, return an empty array for that section.',
          ].join(' '),
        },
        ...(existingSummary ? [{
          role: 'user' as const,
          content: `Existing summary:\n${existingSummary}`,
        }] : []),
        ...(existingGroupProfile ? [{
          role: 'user' as const,
          content: `Existing persistent group profile:\n${existingGroupProfile}`,
        }] : []),
        ...(existingPersonCards.length > 0 ? [{
          role: 'user' as const,
          content: `Existing person cards:\n${JSON.stringify(existingPersonCards)}`,
        }] : []),
        ...(existingActiveTopics.length > 0 ? [{
          role: 'user' as const,
          content: `Existing active topics:\n${JSON.stringify(existingActiveTopics)}`,
        }] : []),
        ...(ambientMessages.length > 0 ? [{
          role: 'user' as const,
          content: `Overheard group chatter (not addressed to the bot — use for context, people, and topic extraction only):\n${ambientMessages.join('\n')}`,
        }] : []),
        {
          role: 'user',
          content: `New turns to merge into the summary:\n${transcript}`,
        },
      ];

      const extractionResponse = await this.generateTrackedResponse(summaryApi, extractionMessages, summaryModel, 'memory_extract');
      const extractedMemory = this.parseExtractedMemory(extractionResponse);
      if (!extractedMemory) {
        return await this.fallbackConversationSummary(summaryApi, summaryModel, transcript, existingSummary);
      }

      await this.applyExtractedMemory(sessionKey, extractedMemory);

      if (isGroup && ambientMessages.length > 0) {
        this.runBackground('clearAmbientAfterExtraction', () =>
          this.redis.del(ambientMessagesKey(sessionKey)),
        );
      }

      return extractedMemory.summary.slice(0, TelegramBot.MAX_SUMMARY_CHARS).trim();
    } catch (error) {
      console.error('Error updating conversation summary:', error);
      return null;
    }
  }

  private async fallbackConversationSummary(
    summaryApi: ModelAPIInterface,
    summaryModel: string,
    transcript: string,
    existingSummary: string | null,
  ): Promise<string | null> {
    try {
      const summaryMessages: Message[] = [
        {
          role: 'system',
          content: `Compress conversation memory for a Telegram chat. Keep only durable context: people, nicknames, preferences, running jokes, unresolved threads, decisions, and important recent topics. Keep it concise and under ${TelegramBot.MAX_SUMMARY_CHARS} characters. Do not write fluff.`,
        },
        ...(existingSummary ? [{
          role: 'user' as const,
          content: `Existing summary:\n${existingSummary}`,
        }] : []),
        {
          role: 'user',
          content: `New turns to merge into the summary:\n${transcript}`,
        },
      ];

      const summary = await this.generateTrackedResponse(summaryApi, summaryMessages, summaryModel, 'summary');
      return summary.slice(0, TelegramBot.MAX_SUMMARY_CHARS).trim();
    } catch (error) {
      console.error('Error in fallback conversation summary:', error);
      return null;
    }
  }

  private parseExtractedMemory(raw: string): ExtractedMemoryPayload | null {
    try {
      const normalized = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(normalized) as ExtractedMemoryPayload;
      if (!parsed || typeof parsed.summary !== 'string') {
        return null;
      }
      return {
        summary: parsed.summary.trim(),
        group_profile_additions: Array.isArray(parsed.group_profile_additions)
          ? parsed.group_profile_additions.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
          : [],
        person_cards: Array.isArray(parsed.person_cards)
          ? parsed.person_cards
            .filter(card => card && typeof card.name === 'string' && Array.isArray(card.notes))
            .map(card => ({
              name: card.name.trim(),
              notes: card.notes.filter(note => typeof note === 'string').map(note => note.trim()).filter(Boolean),
            }))
            .filter(card => card.name && card.notes.length > 0)
          : [],
        active_topics: Array.isArray(parsed.active_topics)
          ? parsed.active_topics
            .filter(topic => topic && typeof topic.topic === 'string')
            .map(topic => ({
              topic: topic.topic.trim(),
              status: typeof topic.status === 'string' ? topic.status.trim() : undefined,
            }))
            .filter(topic => topic.topic)
          : [],
      };
    } catch (error) {
      console.error('Error parsing extracted memory payload:', error);
      return null;
    }
  }

  private async applyExtractedMemory(sessionKey: string, extractedMemory: ExtractedMemoryPayload): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    if (extractedMemory.group_profile_additions && extractedMemory.group_profile_additions.length > 0) {
      await this.mergeGroupProfileAdditions(sessionKey, extractedMemory.group_profile_additions);
    }

    if (extractedMemory.person_cards && extractedMemory.person_cards.length > 0) {
      await this.mergePersonCards(sessionKey, extractedMemory.person_cards);
    }

    if (extractedMemory.active_topics && extractedMemory.active_topics.length > 0) {
      await this.mergeActiveTopics(sessionKey, extractedMemory.active_topics);
    }
  }

  private async mergeGroupProfileAdditions(sessionKey: string, additions: string[]): Promise<void> {
    await this.redis.withLock(groupProfileKey(sessionKey), async () => {
      const existingProfile = (await this.getGroupProfile(sessionKey)) || '';
      const existingLines = new Set(
        existingProfile
          .split('\n')
          .map(line => line.replace(/^-+\s*/, '').trim().toLowerCase())
          .filter(Boolean),
      );

      const newLines = additions
        .map(item => item.trim())
        .filter(item => item && !existingLines.has(item.toLowerCase()));

      if (newLines.length === 0) {
        return;
      }

      const appended = newLines.map(item => `- ${item}`).join('\n');
      let updatedProfile = existingProfile ? `${existingProfile}\n${appended}` : appended;

      if (updatedProfile.length > TelegramBot.MAX_GROUP_PROFILE_CHARS) {
        const lines = updatedProfile.split('\n').filter(Boolean);
        while (lines.length > 1 && lines.join('\n').length > TelegramBot.MAX_GROUP_PROFILE_CHARS) {
          lines.shift();
        }
        updatedProfile = lines.join('\n');
      }

      await this.redis.set(
        groupProfileKey(sessionKey),
        updatedProfile.trim(),
        this.getContextTTL(),
      );
    });
  }

  private async mergePersonCards(
    sessionKey: string,
    incomingCards: NonNullable<ExtractedMemoryPayload['person_cards']>,
  ): Promise<void> {
    await this.redis.withLock(personCardsKey(sessionKey), async () => {
      const existingCards = await this.getPersonCards(sessionKey);
      const now = new Date().toISOString();
      const cardMap = new Map(existingCards.map(card => [card.name.toLowerCase(), { ...card }]));

      for (const incomingCard of incomingCards) {
        const key = incomingCard.name.toLowerCase();
        const existing = cardMap.get(key);
        if (existing) {
          const mergedNotes = [...existing.notes];
          for (const note of incomingCard.notes) {
            if (!mergedNotes.some(existingNote => existingNote.toLowerCase() === note.toLowerCase())) {
              mergedNotes.push(note);
            }
          }
          existing.notes = mergedNotes.slice(-TelegramBot.MAX_PERSON_NOTES);
          existing.lastUpdatedAt = now;
          existing.name = incomingCard.name;
        } else {
          cardMap.set(key, {
            name: incomingCard.name,
            notes: incomingCard.notes.slice(-TelegramBot.MAX_PERSON_NOTES),
            lastUpdatedAt: now,
          });
        }
      }

      const mergedCards = Array.from(cardMap.values())
        .sort((a, b) => new Date(a.lastUpdatedAt).getTime() - new Date(b.lastUpdatedAt).getTime())
        .slice(-TelegramBot.MAX_PERSON_CARDS);
      await this.setPersonCards(sessionKey, mergedCards);
    });
  }

  private async mergeActiveTopics(
    sessionKey: string,
    incomingTopics: NonNullable<ExtractedMemoryPayload['active_topics']>,
  ): Promise<void> {
    await this.redis.withLock(activeTopicsKey(sessionKey), async () => {
      const existingTopics = await this.getActiveTopics(sessionKey);
      const now = new Date().toISOString();
      const topicMap = new Map(existingTopics.map(topic => [topic.topic.toLowerCase(), { ...topic }]));

      for (const incomingTopic of incomingTopics) {
        const key = incomingTopic.topic.toLowerCase();
        const existing = topicMap.get(key);
        if (existing) {
          existing.status = incomingTopic.status || existing.status;
          existing.lastUpdatedAt = now;
          existing.topic = incomingTopic.topic;
        } else {
          topicMap.set(key, {
            topic: incomingTopic.topic,
            status: incomingTopic.status,
            lastUpdatedAt: now,
          });
        }
      }

      const mergedTopics = Array.from(topicMap.values())
        .filter(topic => topic.status?.toLowerCase() !== 'resolved')
        .sort((a, b) => new Date(a.lastUpdatedAt).getTime() - new Date(b.lastUpdatedAt).getTime())
        .slice(-TelegramBot.MAX_ACTIVE_TOPICS);
      await this.setActiveTopics(sessionKey, mergedTopics);
    });
  }

  private getRecentTurnCharCount(turns: MemoryTurn[]): number {
    return turns.reduce((total, turn) => total + turn.content.length, 0);
  }

  private truncateAmbientMessage(message: string): string {
    const trimmed = message.trim();
    if (trimmed.length <= 280) {
      return trimmed;
    }
    return `${trimmed.slice(0, 277)}...`;
  }

  private shouldStoreAmbientMessage(message: string): boolean {
    const trimmed = message.trim();
    if (trimmed.length < 12) {
      return false;
    }

    const lower = trimmed.toLowerCase();
    const fillerPatterns = [
      /^(ha)+$/i,
      /^(ja)+$/i,
      /^(lol|lmao|lmfao|rofl|bruh|bro|test|testing|gg|wp|ok|oks?|k|nice|same)$/i,
      /^(hmm+|hmmm+|hahaha+|ahaha+|hehe+|wkwk+|xd+)$/i,
    ];
    if (fillerPatterns.some(pattern => pattern.test(lower))) {
      return false;
    }

    const contentOnly = trimmed.replace(/\s+/g, '');
    if (/^[\p{P}\p{S}]+$/u.test(contentOnly)) {
      return false;
    }

    const alphaNumericCount = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
    return alphaNumericCount >= 8;
  }

  private getReplyStyleInstruction(replyStyle: ReplyStyle): string {
    switch (replyStyle) {
      case 'short':
        return 'Reply style for this chat: keep responses compact and punchy. Prefer 1-2 short paragraphs or a few short lines. Do not turn simple answers into essays.';
      case 'long':
        return 'Reply style for this chat: provide fuller answers with more context when helpful, but stay readable and avoid bloated filler.';
      default:
        return 'Reply style for this chat: keep responses natural and fairly short. Prefer 2 short paragraphs max unless the user clearly asks for depth.';
    }
  }
}

export default TelegramBot;

function uint8ToBase64(bytes: Uint8Array): string {
  let result = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(result);
}
