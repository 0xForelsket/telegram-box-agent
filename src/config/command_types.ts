import { Env } from '../env';
import { TelegramTypes } from '../../types/telegram';
import { TranslationKey } from '../utils/i18n';
import { ModelRequestMode } from '../utils/usage_tracker';
import { ProviderHealth } from '../utils/usage_tracker';

export interface BotSettings {
  ambientMemory: boolean;
  replyStyle: 'short' | 'normal' | 'long';
}

export interface TelegramStatus {
  currentModel: string;
  summaryModel: string;
  researchModel: string;
  visionModel: string;
  ambientMemory: boolean;
  replyStyle: BotSettings['replyStyle'];
  hasGroupProfile: boolean;
  hasSummary: boolean;
  recentTurnCount: number;
  ambientMessageCount: number;
  seenMemberCount: number;
  personCardCount: number;
  activeTopicCount: number;
  searchProviders: string[];
  webSearchAvailable: boolean;
  modelFallbacks: string[];
  modelProviderHealth: ProviderHealth[];
  searchProviderHealth: ProviderHealth[];
  searchQuotas: Array<{ provider: string; used: number; cap: number | null }>;
  commandMenuStatus: 'current' | 'stale';
}

export interface TelegramCommandBot {
  getEnv(): Env;
  sendMessage(
    chatId: number,
    text: string,
    options?: { parse_mode?: 'Markdown' | 'HTML'; reply_markup?: string },
  ): Promise<TelegramTypes.SendMessageResult[]>;
  sendMessageWithFallback(chatId: number, text: string): Promise<TelegramTypes.SendMessageResult[]>;
  replaceProgressMessage(chatId: number, messageId: number, text: string): Promise<void>;
  isUserGroupAdmin(chatId: number, userId: string): Promise<boolean>;
  isOwner(userId: string): boolean;
  getUsageReport(): Promise<string>;
  getCacheReport(sessionKey: string): Promise<string>;
  createDashboardLink(sessionKey: string, userId: string): Promise<{ url: string; expiresInMinutes: number }>;
  getLastSources(sessionKey: string): Promise<string | null>;
  research(sessionKey: string, question: string): Promise<string>;
  readUrl(sessionKey: string, url: string): Promise<string>;
  compareModels(sessionKey: string, question: string): Promise<string>;
  addBookmark(sessionKey: string, url: string, title?: string): Promise<void>;
  listBookmarks(sessionKey: string): Promise<string | null>;
  removeBookmark(sessionKey: string, query: string): Promise<string | null>;
  getSelectableModels(): Promise<string[]>;
  runTextShortcut(sessionKey: string, task: 'translate' | 'rewrite' | 'summarize', text: string, target?: string): Promise<string>;
  addReminder(chatId: number, sessionKey: string, input: string): Promise<string>;
  listReminders(sessionKey: string): Promise<string | null>;
  removeReminder(sessionKey: string, id: string): Promise<string | null>;
  addFeedSubscription(sessionKey: string, url: string): Promise<string>;
  listFeedSubscriptions(sessionKey: string): Promise<string | null>;
  removeFeedSubscription(sessionKey: string, id: string): Promise<string | null>;
  addDigest(chatId: number, sessionKey: string, input: string): Promise<string>;
  listDigests(sessionKey: string): Promise<string | null>;
  removeDigest(sessionKey: string, id: string): Promise<string | null>;
  recordModelOperation(
    model: string,
    mode: ModelRequestMode,
    startedAt: number,
    success: boolean,
    error?: unknown,
  ): void;
  clearContext(sessionKey: string, chatId: number, userId?: string): Promise<void>;
  summarizeHistory(sessionKey: string): Promise<string>;
  getGroupProfile(sessionKey: string): Promise<string | null>;
  setGroupProfile(sessionKey: string, profile: string): Promise<void>;
  appendGroupProfile(sessionKey: string, note: string): Promise<void>;
  clearGroupProfile(sessionKey: string): Promise<void>;
  syncCommands(): Promise<void>;
  getStatus(sessionKey: string): Promise<TelegramStatus>;
  setBotSettings(sessionKey: string, settings: Partial<BotSettings>): Promise<BotSettings>;
  getFormattedPersonCards(sessionKey: string): Promise<string | null>;
  getFormattedActiveTopics(sessionKey: string): Promise<string | null>;
  getFormattedSummary(sessionKey: string): Promise<string | null>;
  rememberDurableMemory(sessionKey: string, text: string): Promise<string>;
  recallDurableMemory(sessionKey: string, query: string): Promise<string | null>;
  forgetSavedMemory(sessionKey: string, query: string): Promise<string | null>;
  deletePersonCard(sessionKey: string, name: string): Promise<boolean>;
  sendPhoto(chatId: number, photo: string | Uint8Array, options?: { caption?: string }): Promise<void>;
  synthesizeSpeech(text: string): Promise<Uint8Array>;
  sendVoice(chatId: number, voice: Uint8Array, caption?: string): Promise<void>;
  beginCancellableTask(sessionKey: string, type: string): Promise<string>;
  assertTaskActive(sessionKey: string, taskId: string): Promise<void>;
  finishCancellableTask(sessionKey: string, taskId: string): Promise<void>;
  cancelActiveTask(sessionKey: string): Promise<string | null>;
  enableBoxForChat(chatId: number, sessionKey: string): Promise<void>;
  startBoxAgentJob(
    chatId: number,
    sessionKey: string,
    userId: string,
    request: string,
    requestedRoute?: string,
  ): Promise<void>;
  runQuickChat(chatId: number, sessionKey: string, userId: string, request: string): Promise<void>;
  getBoxAgentStatus(chatId: number, userId: string, jobId?: string): Promise<string>;
  cancelBoxAgentJob(chatId: number, userId: string, jobId: string): Promise<string>;
  approveBoxAgentJob(chatId: number, userId: string, jobId: string, nonce: string): Promise<string>;
  createBoxAgentSchedule(chatId: number, userId: string, cron: string, prompt: string, requestedRoute?: string): Promise<string>;
  listBoxAgentSchedules(chatId: number, userId: string): Promise<string>;
  changeBoxAgentSchedule(chatId: number, userId: string, id: string, action: 'pause' | 'resume' | 'delete'): Promise<string>;
  getArtifactLink(chatId: number, userId: string, artifactId: string): Promise<string>;
}

export interface Command {
  name: string;
  description: TranslationKey;
  action: (
    chatId: number,
    sessionKey: string,
    userId: string,
    bot: TelegramCommandBot,
    args: string[],
  ) => Promise<void>;
}
