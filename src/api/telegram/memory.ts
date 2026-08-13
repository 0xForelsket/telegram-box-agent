import { TelegramTypes } from "../../../types/telegram";
import { Message } from "../chat_types";
import { translate, translateMessage } from "../../utils/i18n";
import { ModelAPIInterface } from "../model_api_interface";
import { BotSettings } from "../../config/command_types";
import {
  activeTopicsKey,
  ambientMessagesKey,
  bookmarksKey,
  botSettingsKey,
  conversationSummaryKey,
  durableMemoryKey,
  groupProfileKey,
  isGroupSession,
  lastReadKey,
  personCardsKey,
  recentTurnsKey,
  seenMembersKey,
} from "../../memory/session_keys";
import { URLReader } from "../../web/url_reader";
import {
  DurableMemory,
  getMemoryIdentity,
  inferMemoryType,
  normalizeMemoryText,
  parseDurableMemories,
  rankDurableMemories,
} from "../../memory/durable_memory";
import {
  type ActiveTopic,
  type PersonCard,
  type SeenMember,
  describeFreshness,
  formatActiveTopics,
  formatPersonCards,
  parseActiveTopics,
  parseAmbientMessages,
  parsePersonCards,
  parseSeenMembers,
} from "../../memory/prompt_memory";

import {
  type Bookmark,
  type ExtractedMemoryPayload,
  type MemoryTurn,
  type PromptState,
  type ReplyStyle,
} from "./types";

import { TelegramBotBase } from "./base";
import TelegramAuthorizationBot from "./authorization";

export abstract class TelegramMemoryBot extends TelegramAuthorizationBot {
  protected parseBotSettings(raw: string | null): BotSettings {
    const defaultSettings = this.getDefaultBotSettings();
    if (!raw) {
      return defaultSettings;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<BotSettings>;
      return {
        ambientMemory:
          typeof parsed.ambientMemory === "boolean"
            ? parsed.ambientMemory
            : defaultSettings.ambientMemory,
        replyStyle:
          parsed.replyStyle === "short" ||
          parsed.replyStyle === "normal" ||
          parsed.replyStyle === "long"
            ? parsed.replyStyle
            : defaultSettings.replyStyle,
      };
    } catch (error) {
      console.error("Error parsing bot settings:", error);
      return defaultSettings;
    }
  }

  protected getDefaultBotSettings(): BotSettings {
    return {
      ...TelegramBotBase.DEFAULT_SETTINGS,
      ambientMemory: this.config.ambientMemoryDefault,
    };
  }

  protected parseRecentTurnsRaw(raw: string | null): MemoryTurn[] {
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as MemoryTurn[];
      return parsed.filter(
        (turn) =>
          turn &&
          (turn.role === "user" || turn.role === "assistant") &&
          typeof turn.content === "string",
      );
    } catch (error) {
      console.error("Error parsing recent turns:", error);
      return [];
    }
  }

  protected parseDurableMemoriesRaw(raw: string | null): DurableMemory[] {
    return parseDurableMemories(raw);
  }

  protected async loadPromptState(
    sessionKey: string,
    initialBotSettings?: BotSettings,
  ): Promise<PromptState> {
    try {
      return await this.loadPromptStateFromRedis(
        sessionKey,
        initialBotSettings,
      );
    } catch (error) {
      console.error(
        "Redis prompt state unavailable; continuing without stored memory:",
        error,
      );
      return {
        botSettings:
          initialBotSettings ||
          (isGroupSession(sessionKey)
            ? this.getDefaultBotSettings()
            : TelegramBotBase.DEFAULT_SETTINGS),
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

  protected async loadPromptStateFromRedis(
    sessionKey: string,
    initialBotSettings?: BotSettings,
  ): Promise<PromptState> {
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
    const rawBotSettings = initialBotSettings
      ? null
      : (rawValues[offset++] ?? null);
    const rawGroupProfile = isGroup ? (rawValues[offset++] ?? null) : null;
    const rawPersonCards = isGroup ? (rawValues[offset++] ?? null) : null;
    const rawActiveTopics = isGroup ? (rawValues[offset++] ?? null) : null;
    const rawSeenMembers = isGroup ? (rawValues[offset++] ?? null) : null;

    const botSettings = isGroup
      ? (initialBotSettings ?? this.parseBotSettings(rawBotSettings ?? null))
      : TelegramBotBase.DEFAULT_SETTINGS;

    const rawAmbientMessages =
      isGroup && botSettings.ambientMemory
        ? (await this.redis.getMany([ambientMessagesKey(sessionKey)]))[0]
        : null;

    return {
      botSettings,
      groupProfile: isGroup
        ? ((rawGroupProfile ?? null) as string | null)
        : null,
      personCards: isGroup ? parsePersonCards(rawPersonCards ?? null) : [],
      activeTopics: isGroup ? parseActiveTopics(rawActiveTopics ?? null) : [],
      conversationSummary: (rawSummary ?? null) as string | null,
      recentTurns: this.parseRecentTurnsRaw(rawRecentTurns ?? null),
      ambientMessages:
        isGroup && botSettings.ambientMemory
          ? parseAmbientMessages(rawAmbientMessages)
          : [],
      seenMembers: isGroup ? parseSeenMembers(rawSeenMembers ?? null) : [],
      durableMemories: this.parseDurableMemoriesRaw(rawDurableMemories ?? null),
      currentModel: await this.resolveCurrentModel(
        sessionKey,
        storedModel ?? null,
      ),
    };
  }

  async clearContext(
    sessionKey: string,
    chatId: number,
    userId?: string,
  ): Promise<void> {
    await this.redis.del(`context:${sessionKey}`);
    await this.redis.del(recentTurnsKey(sessionKey));
    await this.redis.del(conversationSummaryKey(sessionKey));
    await this.redis.del(ambientMessagesKey(sessionKey));
    await this.redis.del(activeTopicsKey(sessionKey));
    await this.sendMessageWithFallback(chatId, translate("new_conversation"));
  }

  async getGroupProfile(sessionKey: string): Promise<string | null> {
    if (!isGroupSession(sessionKey)) {
      return null;
    }

    return await this.redis.get(groupProfileKey(sessionKey));
  }

  async setGroupProfile(sessionKey: string, profile: string): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      throw new Error("Group profile is only available in group chats.");
    }

    await this.redis.set(
      groupProfileKey(sessionKey),
      profile.trim(),
      this.getContextTTL(),
    );
  }

  async appendGroupProfile(sessionKey: string, note: string): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      throw new Error("Group profile is only available in group chats.");
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
      throw new Error("Group profile is only available in group chats.");
    }

    await this.redis.del(groupProfileKey(sessionKey));
  }

  async getFormattedPersonCards(sessionKey: string): Promise<string | null> {
    const cards = await this.getPersonCards(sessionKey);
    if (cards.length === 0) {
      return null;
    }
    return cards
      .map((card) => {
        const freshness = describeFreshness(card.lastUpdatedAt);
        return `${card.name} [${freshness}]\n${card.notes.map((n) => `  - ${n}`).join("\n")}`;
      })
      .join("\n\n");
  }

  async getFormattedActiveTopics(sessionKey: string): Promise<string | null> {
    const topics = await this.getActiveTopics(sessionKey);
    if (topics.length === 0) {
      return null;
    }
    return topics
      .map((topic) => {
        const status = topic.status ? ` (${topic.status})` : "";
        const freshness = describeFreshness(topic.lastUpdatedAt);
        return `- ${topic.topic}${status} [${freshness}]`;
      })
      .join("\n");
  }

  async getFormattedSummary(sessionKey: string): Promise<string | null> {
    return await this.getConversationSummary(sessionKey);
  }

  async rememberDurableMemory(
    sessionKey: string,
    text: string,
  ): Promise<string> {
    const normalizedText = text.trim().replace(/\s+/g, " ").slice(0, 500);
    if (!normalizedText) throw new Error("Memory text is empty");

    return await this.redis.withLock(durableMemoryKey(sessionKey), async () => {
      const memories = await this.getDurableMemories(sessionKey);
      const duplicate = memories.find(
        (memory) =>
          normalizeMemoryText(memory.text) ===
          normalizeMemoryText(normalizedText),
      );
      if (duplicate) return duplicate.id;

      const identity = getMemoryIdentity(normalizedText);
      const correction = identity
        ? memories.find((memory) => getMemoryIdentity(memory.text) === identity)
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
        scope: isGroupSession(sessionKey) ? "group" : "private",
        type: inferMemoryType(normalizedText),
        text: normalizedText,
        createdAt: now,
        updatedAt: now,
      };
      memories.push(memory);
      await this.setDurableMemories(
        sessionKey,
        memories.slice(-TelegramBotBase.MAX_DURABLE_MEMORIES),
      );
      return memory.id;
    });
  }

  async recallDurableMemory(
    sessionKey: string,
    query: string,
  ): Promise<string | null> {
    const memories = await this.getDurableMemories(sessionKey);
    if (memories.length === 0) return null;
    const ranked = rankDurableMemories(memories, query, 10);
    if (ranked.length === 0) return null;
    return ranked
      .map((memory) => `- [${memory.id}] (${memory.type}) ${memory.text}`)
      .join("\n");
  }

  async forgetSavedMemory(
    sessionKey: string,
    query: string,
  ): Promise<string | null> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;
    return await this.redis.withLock(durableMemoryKey(sessionKey), async () => {
      const memories = await this.getDurableMemories(sessionKey);
      const exactId = memories.find(
        (memory) => memory.id.toLowerCase() === normalized,
      );
      const textMatches = memories.filter((memory) =>
        memory.text.toLowerCase().includes(normalized),
      );
      const target =
        exactId || (textMatches.length === 1 ? textMatches[0] : undefined);
      if (!target) return null;
      await this.setDurableMemories(
        sessionKey,
        memories.filter((memory) => memory.id !== target.id),
      );
      return `[${target.id}] ${target.text}`;
    });
  }

  protected async getDurableMemories(
    sessionKey: string,
  ): Promise<DurableMemory[]> {
    return this.parseDurableMemoriesRaw(
      await this.redis.get(durableMemoryKey(sessionKey)),
    );
  }

  protected async setDurableMemories(
    sessionKey: string,
    memories: DurableMemory[],
  ): Promise<void> {
    await this.redis.set(
      durableMemoryKey(sessionKey),
      JSON.stringify(memories),
    );
  }

  async deletePersonCard(sessionKey: string, name: string): Promise<boolean> {
    if (!isGroupSession(sessionKey)) {
      return false;
    }

    return await this.redis.withLock(personCardsKey(sessionKey), async () => {
      const cards = await this.getPersonCards(sessionKey);
      const lowerName = name.toLowerCase();
      const filtered = cards.filter(
        (card) => card.name.toLowerCase() !== lowerName,
      );
      if (filtered.length === cards.length) {
        return false;
      }
      await this.setPersonCards(sessionKey, filtered);
      return true;
    });
  }

  async getBotSettings(sessionKey: string): Promise<BotSettings> {
    if (!isGroupSession(sessionKey)) {
      return TelegramBotBase.DEFAULT_SETTINGS;
    }

    try {
      const raw = await this.redis.get(botSettingsKey(sessionKey));
      return this.parseBotSettings(raw);
    } catch (error) {
      console.error("Redis bot settings unavailable; using defaults:", error);
      return this.getDefaultBotSettings();
    }
  }

  async setBotSettings(
    sessionKey: string,
    settings: Partial<BotSettings>,
  ): Promise<BotSettings> {
    if (!isGroupSession(sessionKey)) {
      throw new Error("Bot settings are only available in group chats.");
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
    if (
      !conversationSummary &&
      recentTurns.length === 0 &&
      !groupProfile &&
      personCards.length === 0 &&
      activeTopics.length === 0
    ) {
      return translate("no_history");
    }

    const currentModel = await this.getCurrentModel(sessionKey);
    console.log(`Summarizing history with model: ${currentModel}`);

    let messages: Message[] = [
      {
        role: "system" as const,
        content: `Summarize the following conversation in English:`,
      },
      ...(groupProfile
        ? [
            {
              role: "system" as const,
              content: `Persistent group profile for this chat:\n${groupProfile}`,
            },
          ]
        : []),
      ...(personCards.length > 0
        ? [
            {
              role: "system" as const,
              content: `Person cards:\n${formatPersonCards(personCards)}`,
            },
          ]
        : []),
      ...(activeTopics.length > 0
        ? [
            {
              role: "system" as const,
              content: `Active topics:\n${formatActiveTopics(activeTopics)}`,
            },
          ]
        : []),
      ...(conversationSummary
        ? [
            {
              role: "system" as const,
              content: `Rolling memory summary:\n${conversationSummary}`,
            },
          ]
        : []),
      ...recentTurns,
      ...(recentTurns.length === 0
        ? [
            {
              role: "user" as const,
              content: "No recent chat history available.",
            },
          ]
        : []),
    ];

    const summary = await this.generateTrackedResponse(
      this.modelAPI,
      messages,
      currentModel,
      "summary",
    );
    return `${translate("history_summary")}\n\n${summary}`;
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

  async getCacheReport(sessionKey: string): Promise<string> {
    const currentModel = await this.getCurrentModel(sessionKey);
    const deepSeekModels = this.config.openaiCompatibleModels.filter((model) =>
      /deepseek/i.test(model),
    );
    const models = deepSeekModels.length > 0 ? deepSeekModels : [currentModel];
    const reports = await Promise.all(
      models.flatMap((model) => [
        this.usageTracker.getModelCacheReport("day", model),
        this.usageTracker.getModelCacheReport("month", model),
      ]),
    );

    const lines = [translateMessage("cache_title")];
    for (const report of reports) {
      const measuredTokens = report.cacheHitTokens + report.cacheMissTokens;
      const hitRate =
        measuredTokens > 0
          ? ((report.cacheHitTokens / measuredTokens) * 100).toFixed(1)
          : "n/a";
      lines.push(
        "",
        translateMessage("cache_period", {
          model: report.model,
          period: report.period,
          calls: report.calls,
          prompt: report.promptTokens,
          hits: report.cacheHitTokens,
          misses: report.cacheMissTokens,
          rate: `${hitRate}${hitRate === "n/a" ? "" : "%"}`,
        }),
      );
    }
    return lines.join("\n");
  }

  async addBookmark(
    sessionKey: string,
    rawUrl: string,
    title?: string,
  ): Promise<void> {
    const url = new URLReader().validateUrl(rawUrl).toString();
    await this.redis.withLock(bookmarksKey(sessionKey), async () => {
      const bookmarks = await this.getBookmarks(sessionKey);
      const existing = bookmarks.find((bookmark) => bookmark.url === url);
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
      await this.redis.set(
        bookmarksKey(sessionKey),
        JSON.stringify(bookmarks.slice(-50)),
      );
    });
  }

  async listBookmarks(sessionKey: string): Promise<string | null> {
    const bookmarks = await this.getBookmarks(sessionKey);
    if (bookmarks.length === 0) return null;
    return bookmarks
      .map(
        (bookmark, index) =>
          `${index + 1}. [${bookmark.id}] ${bookmark.title}\n${bookmark.url}`,
      )
      .join("\n\n");
  }

  async removeBookmark(
    sessionKey: string,
    query: string,
  ): Promise<string | null> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;
    return await this.redis.withLock(bookmarksKey(sessionKey), async () => {
      const bookmarks = await this.getBookmarks(sessionKey);
      const matches = bookmarks.filter(
        (bookmark) =>
          bookmark.id.toLowerCase() === normalized ||
          bookmark.title.toLowerCase().includes(normalized),
      );
      if (matches.length !== 1) return null;
      const target = matches[0];
      await this.redis.set(
        bookmarksKey(sessionKey),
        JSON.stringify(
          bookmarks.filter((bookmark) => bookmark.id !== target.id),
        ),
      );
      return `${target.title} (${target.url})`;
    });
  }

  protected async getBookmarks(sessionKey: string): Promise<Bookmark[]> {
    const raw = await this.redis.get(bookmarksKey(sessionKey));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Bookmark[];
      return Array.isArray(parsed)
        ? parsed.filter(
            (bookmark) =>
              bookmark &&
              typeof bookmark.id === "string" &&
              typeof bookmark.url === "string" &&
              typeof bookmark.title === "string",
          )
        : [];
    } catch {
      return [];
    }
  }

  protected async getSeenMembers(sessionKey: string): Promise<SeenMember[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(seenMembersKey(sessionKey));
    return parseSeenMembers(raw);
  }

  protected async rememberSeenMember(
    sessionKey: string,
    user: TelegramTypes.User,
  ): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.withLock(seenMembersKey(sessionKey), async () => {
      const seenMembers = await this.getSeenMembers(sessionKey);
      const now = new Date().toISOString();
      const displayName = this.getDisplayName(user);
      const existingIndex = seenMembers.findIndex(
        (member) => member.userId === user.id.toString(),
      );

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

      while (seenMembers.length > TelegramBotBase.MAX_SEEN_MEMBERS) {
        seenMembers.shift();
      }

      await this.redis.set(
        seenMembersKey(sessionKey),
        JSON.stringify(seenMembers),
        this.getContextTTL(),
      );
    });
  }

  protected async getPersonCards(sessionKey: string): Promise<PersonCard[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(personCardsKey(sessionKey));
    return parsePersonCards(raw);
  }

  protected async setPersonCards(
    sessionKey: string,
    personCards: PersonCard[],
  ): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.set(
      personCardsKey(sessionKey),
      JSON.stringify(personCards),
      this.getContextTTL(),
    );
  }

  protected async getActiveTopics(sessionKey: string): Promise<ActiveTopic[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(activeTopicsKey(sessionKey));
    return parseActiveTopics(raw);
  }

  protected async setActiveTopics(
    sessionKey: string,
    topics: ActiveTopic[],
  ): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.set(
      activeTopicsKey(sessionKey),
      JSON.stringify(topics),
      this.getContextTTL(),
    );
  }

  protected async getLastReadFollowUpContext(
    sessionKey: string,
    promptText: string,
  ): Promise<string | null> {
    if (
      !/\b(this|that|the|previous|last)\s+(page|article|link|url|site)\b|\bwhat does it say\b/i.test(
        promptText,
      )
    ) {
      return null;
    }
    const raw = await this.redis.get(lastReadKey(sessionKey));
    if (!raw) return null;
    try {
      const page = JSON.parse(raw) as {
        url?: string;
        title?: string;
        text?: string;
      };
      if (!page.url || !page.text) return null;
      return `Previously read page:\nURL: ${page.url}\nTitle: ${page.title || "Unknown"}\nContent excerpt:\n${page.text.slice(0, 3_000)}`;
    } catch (error) {
      console.error("Failed to parse last read page:", error);
      return null;
    }
  }

  protected async getRecentTurns(sessionKey: string): Promise<MemoryTurn[]> {
    const raw = await this.redis.get(recentTurnsKey(sessionKey));
    return this.parseRecentTurnsRaw(raw);
  }

  protected async setRecentTurns(
    sessionKey: string,
    turns: MemoryTurn[],
  ): Promise<void> {
    await this.redis.set(
      recentTurnsKey(sessionKey),
      JSON.stringify(turns),
      this.getContextTTL(),
    );
  }

  protected async getConversationSummary(
    sessionKey: string,
  ): Promise<string | null> {
    return await this.redis.get(conversationSummaryKey(sessionKey));
  }

  protected async setConversationSummary(
    sessionKey: string,
    summary: string,
  ): Promise<void> {
    await this.redis.set(
      conversationSummaryKey(sessionKey),
      summary,
      this.getContextTTL(),
    );
  }

  protected async getAmbientMessages(sessionKey: string): Promise<string[]> {
    if (!isGroupSession(sessionKey)) {
      return [];
    }

    const raw = await this.redis.get(ambientMessagesKey(sessionKey));
    return parseAmbientMessages(raw);
  }

  protected async setAmbientMessages(
    sessionKey: string,
    messages: string[],
  ): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    await this.redis.set(
      ambientMessagesKey(sessionKey),
      JSON.stringify(messages),
      this.getContextTTL(),
    );
  }

  protected async rememberAmbientMessage(
    sessionKey: string,
    message: string,
  ): Promise<void> {
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
        ambientMessages.length > TelegramBotBase.MAX_AMBIENT_MESSAGES ||
        ambientMessages.reduce((total, item) => total + item.length, 0) >
          TelegramBotBase.MAX_AMBIENT_CHARS
      ) {
        ambientMessages.shift();
      }

      await this.setAmbientMessages(sessionKey, ambientMessages);
    });
  }

  protected async rememberConversation(
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
          { role: "user", content: userContent },
          { role: "assistant", content: assistantContent },
        );

        const needsCompaction =
          recentTurns.length > TelegramBotBase.MAX_RECENT_TURNS ||
          this.getRecentTurnCharCount(recentTurns) >
            TelegramBotBase.MAX_RECENT_TURN_CHARS;

        if (needsCompaction) {
          turnsToSummarize = recentTurns.slice(
            0,
            Math.max(
              0,
              recentTurns.length - TelegramBotBase.RECENT_TURNS_TO_KEEP,
            ),
          );
          const turnsToKeep = recentTurns.slice(
            -TelegramBotBase.RECENT_TURNS_TO_KEEP,
          );
          await this.setRecentTurns(sessionKey, turnsToKeep);
        } else {
          await this.setRecentTurns(sessionKey, recentTurns);
        }

        await this.redis.del(`context:${sessionKey}`);
      },
      { ttlSeconds: 30 },
    );

    if (turnsToSummarize.length > 0) {
      this.runBackground("compactConversationMemory", () =>
        this.compactConversationMemory(
          currentModel,
          turnsToSummarize,
          sessionKey,
        ),
      );
    }
  }

  protected async compactConversationMemory(
    currentModel: string,
    turnsToSummarize: MemoryTurn[],
    sessionKey: string,
  ): Promise<void> {
    const updatedSummary = await this.updateConversationSummary(
      currentModel,
      turnsToSummarize,
      sessionKey,
    );
    if (updatedSummary) {
      await this.setConversationSummary(sessionKey, updatedSummary);
    }
  }

  protected async updateConversationSummary(
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
      const existingGroupProfile = isGroup
        ? (rawValues[offset++] ?? null)
        : null;
      const existingPersonCards = isGroup
        ? parsePersonCards(rawValues[offset++] ?? null)
        : [];
      const existingActiveTopics = isGroup
        ? parseActiveTopics(rawValues[offset++] ?? null)
        : [];
      const ambientMessages = isGroup
        ? parseAmbientMessages(rawValues[offset++] ?? null)
        : [];

      const transcript = turnsToSummarize
        .map(
          (turn) =>
            `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.content}`,
        )
        .join("\n");

      const extractionMessages: Message[] = [
        {
          role: "system",
          content: [
            "Extract durable Telegram group memory and return strict JSON only.",
            `Return an object with keys: "summary", "group_profile_additions", "person_cards", "active_topics".`,
            `"summary" must be a concise rolling summary under ${TelegramBotBase.MAX_SUMMARY_CHARS} characters.`,
            '"group_profile_additions" must be an array of short durable group facts, jokes, norms, relationships, or preferences worth remembering.',
            '"person_cards" must be an array of objects shaped like {"name":"...", "notes":["...", "..."]} with only durable or repeated social facts.',
            '"active_topics" must be an array of objects shaped like {"topic":"...", "status":"..."} for ongoing threads or current plans. Set status to "resolved" for topics that have concluded, been answered, or are no longer active.',
            "Do not invent facts. Ignore one-off noise. Prefer durable social context, nicknames, recurring dynamics, unresolved plans, and active arguments.",
            "If there is nothing worth adding for a section, return an empty array for that section.",
          ].join(" "),
        },
        ...(existingSummary
          ? [
              {
                role: "user" as const,
                content: `Existing summary:\n${existingSummary}`,
              },
            ]
          : []),
        ...(existingGroupProfile
          ? [
              {
                role: "user" as const,
                content: `Existing persistent group profile:\n${existingGroupProfile}`,
              },
            ]
          : []),
        ...(existingPersonCards.length > 0
          ? [
              {
                role: "user" as const,
                content: `Existing person cards:\n${JSON.stringify(existingPersonCards)}`,
              },
            ]
          : []),
        ...(existingActiveTopics.length > 0
          ? [
              {
                role: "user" as const,
                content: `Existing active topics:\n${JSON.stringify(existingActiveTopics)}`,
              },
            ]
          : []),
        ...(ambientMessages.length > 0
          ? [
              {
                role: "user" as const,
                content: `Overheard group chatter (not addressed to the bot — use for context, people, and topic extraction only):\n${ambientMessages.join("\n")}`,
              },
            ]
          : []),
        {
          role: "user",
          content: `New turns to merge into the summary:\n${transcript}`,
        },
      ];

      const extractionResponse = await this.generateTrackedResponse(
        summaryApi,
        extractionMessages,
        summaryModel,
        "memory_extract",
      );
      const extractedMemory = this.parseExtractedMemory(extractionResponse);
      if (!extractedMemory) {
        return await this.fallbackConversationSummary(
          summaryApi,
          summaryModel,
          transcript,
          existingSummary,
        );
      }

      await this.applyExtractedMemory(sessionKey, extractedMemory);

      if (isGroup && ambientMessages.length > 0) {
        this.runBackground("clearAmbientAfterExtraction", () =>
          this.redis.del(ambientMessagesKey(sessionKey)),
        );
      }

      return extractedMemory.summary
        .slice(0, TelegramBotBase.MAX_SUMMARY_CHARS)
        .trim();
    } catch (error) {
      console.error("Error updating conversation summary:", error);
      return null;
    }
  }

  protected async fallbackConversationSummary(
    summaryApi: ModelAPIInterface,
    summaryModel: string,
    transcript: string,
    existingSummary: string | null,
  ): Promise<string | null> {
    try {
      const summaryMessages: Message[] = [
        {
          role: "system",
          content: `Compress conversation memory for a Telegram chat. Keep only durable context: people, nicknames, preferences, running jokes, unresolved threads, decisions, and important recent topics. Keep it concise and under ${TelegramBotBase.MAX_SUMMARY_CHARS} characters. Do not write fluff.`,
        },
        ...(existingSummary
          ? [
              {
                role: "user" as const,
                content: `Existing summary:\n${existingSummary}`,
              },
            ]
          : []),
        {
          role: "user",
          content: `New turns to merge into the summary:\n${transcript}`,
        },
      ];

      const summary = await this.generateTrackedResponse(
        summaryApi,
        summaryMessages,
        summaryModel,
        "summary",
      );
      return summary.slice(0, TelegramBotBase.MAX_SUMMARY_CHARS).trim();
    } catch (error) {
      console.error("Error in fallback conversation summary:", error);
      return null;
    }
  }

  protected parseExtractedMemory(raw: string): ExtractedMemoryPayload | null {
    try {
      const normalized = raw
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/, "");
      const parsed = JSON.parse(normalized) as ExtractedMemoryPayload;
      if (!parsed || typeof parsed.summary !== "string") {
        return null;
      }
      return {
        summary: parsed.summary.trim(),
        group_profile_additions: Array.isArray(parsed.group_profile_additions)
          ? parsed.group_profile_additions
              .filter((item) => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
        person_cards: Array.isArray(parsed.person_cards)
          ? parsed.person_cards
              .filter(
                (card) =>
                  card &&
                  typeof card.name === "string" &&
                  Array.isArray(card.notes),
              )
              .map((card) => ({
                name: card.name.trim(),
                notes: card.notes
                  .filter((note) => typeof note === "string")
                  .map((note) => note.trim())
                  .filter(Boolean),
              }))
              .filter((card) => card.name && card.notes.length > 0)
          : [],
        active_topics: Array.isArray(parsed.active_topics)
          ? parsed.active_topics
              .filter((topic) => topic && typeof topic.topic === "string")
              .map((topic) => ({
                topic: topic.topic.trim(),
                status:
                  typeof topic.status === "string"
                    ? topic.status.trim()
                    : undefined,
              }))
              .filter((topic) => topic.topic)
          : [],
      };
    } catch (error) {
      console.error("Error parsing extracted memory payload:", error);
      return null;
    }
  }

  protected async applyExtractedMemory(
    sessionKey: string,
    extractedMemory: ExtractedMemoryPayload,
  ): Promise<void> {
    if (!isGroupSession(sessionKey)) {
      return;
    }

    if (
      extractedMemory.group_profile_additions &&
      extractedMemory.group_profile_additions.length > 0
    ) {
      await this.mergeGroupProfileAdditions(
        sessionKey,
        extractedMemory.group_profile_additions,
      );
    }

    if (
      extractedMemory.person_cards &&
      extractedMemory.person_cards.length > 0
    ) {
      await this.mergePersonCards(sessionKey, extractedMemory.person_cards);
    }

    if (
      extractedMemory.active_topics &&
      extractedMemory.active_topics.length > 0
    ) {
      await this.mergeActiveTopics(sessionKey, extractedMemory.active_topics);
    }
  }

  protected async mergeGroupProfileAdditions(
    sessionKey: string,
    additions: string[],
  ): Promise<void> {
    await this.redis.withLock(groupProfileKey(sessionKey), async () => {
      const existingProfile = (await this.getGroupProfile(sessionKey)) || "";
      const existingLines = new Set(
        existingProfile
          .split("\n")
          .map((line) =>
            line
              .replace(/^-+\s*/, "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      );

      const newLines = additions
        .map((item) => item.trim())
        .filter((item) => item && !existingLines.has(item.toLowerCase()));

      if (newLines.length === 0) {
        return;
      }

      const appended = newLines.map((item) => `- ${item}`).join("\n");
      let updatedProfile = existingProfile
        ? `${existingProfile}\n${appended}`
        : appended;

      if (updatedProfile.length > TelegramBotBase.MAX_GROUP_PROFILE_CHARS) {
        const lines = updatedProfile.split("\n").filter(Boolean);
        while (
          lines.length > 1 &&
          lines.join("\n").length > TelegramBotBase.MAX_GROUP_PROFILE_CHARS
        ) {
          lines.shift();
        }
        updatedProfile = lines.join("\n");
      }

      await this.redis.set(
        groupProfileKey(sessionKey),
        updatedProfile.trim(),
        this.getContextTTL(),
      );
    });
  }

  protected async mergePersonCards(
    sessionKey: string,
    incomingCards: NonNullable<ExtractedMemoryPayload["person_cards"]>,
  ): Promise<void> {
    await this.redis.withLock(personCardsKey(sessionKey), async () => {
      const existingCards = await this.getPersonCards(sessionKey);
      const now = new Date().toISOString();
      const cardMap = new Map(
        existingCards.map((card) => [card.name.toLowerCase(), { ...card }]),
      );

      for (const incomingCard of incomingCards) {
        const key = incomingCard.name.toLowerCase();
        const existing = cardMap.get(key);
        if (existing) {
          const mergedNotes = [...existing.notes];
          for (const note of incomingCard.notes) {
            if (
              !mergedNotes.some(
                (existingNote) =>
                  existingNote.toLowerCase() === note.toLowerCase(),
              )
            ) {
              mergedNotes.push(note);
            }
          }
          existing.notes = mergedNotes.slice(-TelegramBotBase.MAX_PERSON_NOTES);
          existing.lastUpdatedAt = now;
          existing.name = incomingCard.name;
        } else {
          cardMap.set(key, {
            name: incomingCard.name,
            notes: incomingCard.notes.slice(-TelegramBotBase.MAX_PERSON_NOTES),
            lastUpdatedAt: now,
          });
        }
      }

      const mergedCards = Array.from(cardMap.values())
        .sort(
          (a, b) =>
            new Date(a.lastUpdatedAt).getTime() -
            new Date(b.lastUpdatedAt).getTime(),
        )
        .slice(-TelegramBotBase.MAX_PERSON_CARDS);
      await this.setPersonCards(sessionKey, mergedCards);
    });
  }

  protected async mergeActiveTopics(
    sessionKey: string,
    incomingTopics: NonNullable<ExtractedMemoryPayload["active_topics"]>,
  ): Promise<void> {
    await this.redis.withLock(activeTopicsKey(sessionKey), async () => {
      const existingTopics = await this.getActiveTopics(sessionKey);
      const now = new Date().toISOString();
      const topicMap = new Map(
        existingTopics.map((topic) => [
          topic.topic.toLowerCase(),
          { ...topic },
        ]),
      );

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
        .filter((topic) => topic.status?.toLowerCase() !== "resolved")
        .sort(
          (a, b) =>
            new Date(a.lastUpdatedAt).getTime() -
            new Date(b.lastUpdatedAt).getTime(),
        )
        .slice(-TelegramBotBase.MAX_ACTIVE_TOPICS);
      await this.setActiveTopics(sessionKey, mergedTopics);
    });
  }

  protected getRecentTurnCharCount(turns: MemoryTurn[]): number {
    return turns.reduce((total, turn) => total + turn.content.length, 0);
  }

  protected truncateAmbientMessage(message: string): string {
    const trimmed = message.trim();
    if (trimmed.length <= 280) {
      return trimmed;
    }
    return `${trimmed.slice(0, 277)}...`;
  }

  protected shouldStoreAmbientMessage(message: string): boolean {
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
    if (fillerPatterns.some((pattern) => pattern.test(lower))) {
      return false;
    }

    const contentOnly = trimmed.replace(/\s+/g, "");
    if (/^[\p{P}\p{S}]+$/u.test(contentOnly)) {
      return false;
    }

    const alphaNumericCount = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
    return alphaNumericCount >= 8;
  }

  protected getReplyStyleInstruction(replyStyle: ReplyStyle): string {
    switch (replyStyle) {
      case "short":
        return "Reply style for this chat: keep responses compact and punchy. Prefer 1-2 short paragraphs or a few short lines. Do not turn simple answers into essays.";
      case "long":
        return "Reply style for this chat: provide fuller answers with more context when helpful, but stay readable and avoid bloated filler.";
      default:
        return "Reply style for this chat: keep responses natural and fairly short. Prefer 2 short paragraphs max unless the user clearly asks for depth.";
    }
  }
}

export default TelegramMemoryBot;
