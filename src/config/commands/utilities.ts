import { Command } from "../command_types";
import { translate } from "../../utils/i18n";
import { sendChatAction } from "../../utils/helpers";
import { getConfig } from "../../env";
import {
  calculateDate,
  calculateExpression,
  convertUnits,
  formatNumber,
  formatTimeInZone,
} from "../../utils/deterministic_tools";
import {
  convertCurrency,
  formatFeed,
  getGitHubRepository,
  getWeather,
  readFeed,
  searchArxiv,
} from "../../utils/structured_utilities";
import { requireOwner, type TelegramBot, userMessage } from "./shared";

export const utilitiesCommands: Command[] = [
  {
    name: "calc",
    description: "calc_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        const expression = args.join(" ").trim();
        if (!expression)
          throw new Error(await userMessage(bot, userId, "calc_usage"));
        await bot.sendMessageWithFallback(
          chatId,
          `${expression} = ${formatNumber(calculateExpression(expression))}`,
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "calc_failed"),
        );
      }
    },
  },
  {
    name: "convert",
    description: "convert_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        const conversion = convertUnits(args.join(" "));
        await bot.sendMessageWithFallback(
          chatId,
          `${args.join(" ")} = ${formatNumber(conversion.value)} ${conversion.to}`,
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "conversion_failed"),
        );
      }
    },
  },
  {
    name: "time",
    description: "time_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        const timeZone = args[0] || "Asia/Kuala_Lumpur";
        await bot.sendMessageWithFallback(
          chatId,
          `${timeZone}: ${formatTimeInZone(timeZone)}`,
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "timezone_failed"),
        );
      }
    },
  },
  {
    name: "date",
    description: "date_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        await bot.sendMessageWithFallback(
          chatId,
          calculateDate(args.join(" ")),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "date_failed"),
        );
      }
    },
  },
  {
    name: "remind",
    description: "remind_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await bot.addReminder(chatId, sessionKey, args.join(" ")),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "reminder_failed"),
        );
      }
    },
  },
  {
    name: "reminders",
    description: "reminders_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      await bot.sendMessageWithFallback(
        chatId,
        (await bot.listReminders(sessionKey)) ||
          (await userMessage(bot, userId, "no_reminders")),
      );
    },
  },
  {
    name: "unremind",
    description: "unremind_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const removed = args[0]
        ? await bot.removeReminder(sessionKey, args[0])
        : null;
      await bot.sendMessageWithFallback(
        chatId,
        removed
          ? await userMessage(bot, userId, "reminder_removed", {
              value: removed,
            })
          : await userMessage(bot, userId, "reminder_not_found"),
      );
    },
  },
  {
    name: "digest",
    description: "digest_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await bot.addDigest(chatId, sessionKey, args.join(" ")),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "digest_failed"),
        );
      }
    },
  },
  {
    name: "digests",
    description: "digests_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      await bot.sendMessageWithFallback(
        chatId,
        (await bot.listDigests(sessionKey)) ||
          (await userMessage(bot, userId, "no_digests")),
      );
    },
  },
  {
    name: "undigest",
    description: "undigest_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const removed = args[0]
        ? await bot.removeDigest(sessionKey, args[0])
        : null;
      await bot.sendMessageWithFallback(
        chatId,
        removed
          ? await userMessage(bot, userId, "digest_removed", { value: removed })
          : await userMessage(bot, userId, "digest_not_found"),
      );
    },
  },
  {
    name: "speak",
    description: "speak_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const text = args.join(" ").trim();
      if (!text) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "speak_usage"),
        );
        return;
      }
      try {
        const progress = await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "speech_progress"),
        );
        const audio = await bot.synthesizeSpeech(text);
        await bot.sendVoice(chatId, audio, text.slice(0, 200));
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            await userMessage(bot, userId, "speech_generated"),
          );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "speech_failed"),
        );
      }
    },
  },
  {
    name: "translate",
    description: "translate_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const [target, ...textParts] = args;
      if (!target || textParts.length === 0) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "translate_usage"),
        );
        return;
      }
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await bot.runTextShortcut(
            sessionKey,
            "translate",
            textParts.join(" "),
            target,
          ),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "translation_failed"),
        );
      }
    },
  },
  {
    name: "rewrite",
    description: "rewrite_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (args.length === 0) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "rewrite_usage"),
        );
        return;
      }
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await bot.runTextShortcut(sessionKey, "rewrite", args.join(" ")),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "rewrite_failed"),
        );
      }
    },
  },
  {
    name: "summarize",
    description: "summarize_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (args.length === 0) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "summarize_usage"),
        );
        return;
      }
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await bot.runTextShortcut(sessionKey, "summarize", args.join(" ")),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "summarize_failed"),
        );
      }
    },
  },
  {
    name: "weather",
    description: "weather_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await getWeather(args.join(" "), AbortSignal.timeout(10_000)),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "weather_failed"),
        );
      }
    },
  },
  {
    name: "currency",
    description: "currency_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const match = args
        .join(" ")
        .trim()
        .match(
          /^(-?\d+(?:\.\d+)?)\s+([A-Za-z]{3})\s+(?:to|in)\s+([A-Za-z]{3})$/,
        );
      if (!match) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "currency_usage"),
        );
        return;
      }
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await convertCurrency(
            Number(match[1]),
            match[2],
            match[3],
            AbortSignal.timeout(10_000),
          ),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "currency_failed"),
        );
      }
    },
  },
  {
    name: "feed",
    description: "feed_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const url = args[0];
      if (!url) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "feed_usage"),
        );
        return;
      }
      try {
        const count = Number.parseInt(args[1] || "5", 10) || 5;
        await bot.sendMessageWithFallback(
          chatId,
          formatFeed(await readFeed(url, count, AbortSignal.timeout(10_000))),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "feed_failed"),
        );
      }
    },
  },
  {
    name: "followfeed",
    description: "followfeed_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!args[0]) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "follow_feed_usage"),
        );
        return;
      }
      try {
        const id = await bot.addFeedSubscription(sessionKey, args[0]);
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "feed_followed", { value: id }),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "follow_feed_failed"),
        );
      }
    },
  },
  {
    name: "feeds",
    description: "feeds_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      await bot.sendMessageWithFallback(
        chatId,
        (await bot.listFeedSubscriptions(sessionKey)) ||
          (await userMessage(bot, userId, "no_feeds")),
      );
    },
  },
  {
    name: "unfollowfeed",
    description: "unfollowfeed_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const removed = args[0]
        ? await bot.removeFeedSubscription(sessionKey, args[0])
        : null;
      await bot.sendMessageWithFallback(
        chatId,
        removed
          ? await userMessage(bot, userId, "feed_unfollowed", {
              value: removed,
            })
          : await userMessage(bot, userId, "feed_not_found"),
      );
    },
  },
  {
    name: "github",
    description: "github_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const repo = args[0];
      const view =
        args[1] === "releases" || args[1] === "issues" ? args[1] : "summary";
      if (!repo) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "github_usage"),
        );
        return;
      }
      try {
        const config = getConfig(bot.getEnv());
        await bot.sendMessageWithFallback(
          chatId,
          await getGitHubRepository(
            repo,
            view,
            config.githubToken,
            AbortSignal.timeout(10_000),
          ),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "github_failed"),
        );
      }
    },
  },
  {
    name: "arxiv",
    description: "arxiv_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (args.length === 0) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "arxiv_usage"),
        );
        return;
      }
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await searchArxiv(args.join(" "), 5, AbortSignal.timeout(12_000)),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : await userMessage(bot, userId, "arxiv_failed"),
        );
      }
    },
  },
  {
    name: "usage",
    description: "usage_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      if (!(await requireOwner(chatId, userId, bot))) {
        return;
      }
      await bot.sendMessageWithFallback(chatId, await bot.getUsageReport());
    },
  },
  {
    name: "cache",
    description: "cache_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      if (!(await requireOwner(chatId, userId, bot))) {
        return;
      }
      await bot.sendMessageWithFallback(
        chatId,
        await bot.getCacheReport(sessionKey),
      );
    },
  },
  {
    name: "research",
    description: "research_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const question = args.join(" ").trim();
      if (!question) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "research_usage"),
        );
        return;
      }
      let taskId: string | null = null;
      let progress: Awaited<
        ReturnType<TelegramBot["sendMessageWithFallback"]>
      > = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, "research");
        await sendChatAction(chatId, "typing", bot.getEnv());
        progress = await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "research_progress"),
        );
        const answer = await bot.research(sessionKey, question);
        await bot.assertTaskActive(sessionKey, taskId);
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            answer,
          );
        else await bot.sendMessageWithFallback(chatId, answer);
      } catch (error) {
        console.error("Research command failed:", error);
        const message = await userMessage(bot, userId, "research_failed", {
          error:
            error instanceof Error
              ? error.message
              : await userMessage(bot, userId, "unknown_error"),
        });
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            message,
          );
        else await bot.sendMessageWithFallback(chatId, message);
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: "read",
    description: "read_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const forceAgent = args[0]?.toLowerCase() === "--agent";
      const url = args[forceAgent ? 1 : 0]?.trim();
      if (!url) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "read_usage"),
        );
        return;
      }
      const instruction = args
        .slice(forceAgent ? 2 : 1)
        .join(" ")
        .trim();
      if (forceAgent || (/\.pdf(?:[?#]|$)/i.test(url) && instruction)) {
        try {
          await bot.startBoxAgentJob(
            chatId,
            sessionKey,
            userId,
            `Read and analyze ${url}. ${instruction || "Extract the important content accurately, using PDF or browser tooling as needed."}`,
          );
        } catch (error) {
          await bot.sendMessageWithFallback(
            chatId,
            error instanceof Error
              ? error.message
              : "Box reading request failed.",
          );
        }
        return;
      }
      let taskId: string | null = null;
      let progress: Awaited<
        ReturnType<TelegramBot["sendMessageWithFallback"]>
      > = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, "read");
        await sendChatAction(chatId, "typing", bot.getEnv());
        progress = await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "read_progress"),
        );
        const answer = await bot.readUrl(sessionKey, url);
        await bot.assertTaskActive(sessionKey, taskId);
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            answer,
          );
        else await bot.sendMessageWithFallback(chatId, answer);
      } catch (error) {
        console.error("Read command failed:", error);
        const message = await userMessage(bot, userId, "read_failed", {
          error:
            error instanceof Error
              ? error.message
              : await userMessage(bot, userId, "unknown_error"),
        });
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            message,
          );
        else await bot.sendMessageWithFallback(chatId, message);
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: "sources",
    description: "sources_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      const sources = await bot.getLastSources(sessionKey);
      await bot.sendMessageWithFallback(
        chatId,
        sources || (await userMessage(bot, userId, "no_sources")),
      );
    },
  },
  {
    name: "compare",
    description: "compare_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const question = args.join(" ").trim();
      if (!question) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "compare_usage"),
        );
        return;
      }
      let taskId: string | null = null;
      let progress: Awaited<
        ReturnType<TelegramBot["sendMessageWithFallback"]>
      > = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, "compare");
        await sendChatAction(chatId, "typing", bot.getEnv());
        progress = await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "compare_progress"),
        );
        const answer = await bot.compareModels(sessionKey, question);
        await bot.assertTaskActive(sessionKey, taskId);
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            answer,
          );
        else await bot.sendMessageWithFallback(chatId, answer);
      } catch (error) {
        const message = await userMessage(bot, userId, "compare_failed", {
          error:
            error instanceof Error
              ? error.message
              : await userMessage(bot, userId, "unknown_error"),
        });
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            message,
          );
        else await bot.sendMessageWithFallback(chatId, message);
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
];
