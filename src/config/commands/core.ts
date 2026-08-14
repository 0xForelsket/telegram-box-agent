import { Command } from "../command_types";
import { translate, translateMessage, UserMessageKey } from "../../utils/i18n";
import { commands } from "../commands";
import { encodeModelCallbackData, fitsCallbackData } from "../callback_data";
import {
  formatProviderHealth,
  requireGroupAdmin,
  requireOwner,
  type TelegramBot,
  userMessage,
} from "./shared";

export const coreCommands: Command[] = [
  {
    name: "start",
    description: "start_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const welcomeMessage = translate("welcome");
      await bot.sendMessageWithFallback(chatId, welcomeMessage);
    },
  },
  {
    name: "switchmodel",
    description: "switchmodel_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        console.log("Executing switchmodel command");
        const availableModels = await bot.getSelectableModels();

        console.log("Available models:", availableModels);
        // One oversized button makes Telegram reject the whole message, so a
        // name that cannot be encoded is dropped from the picker instead.
        const selectable = availableModels.filter((model) =>
          fitsCallbackData(encodeModelCallbackData(model)),
        );
        const skipped = availableModels.length - selectable.length;
        if (selectable.length === 0) {
          await bot.sendMessage(
            chatId,
            `${translate("error")}\nNo configured model name is short enough for a Telegram button.`,
          );
          return;
        }
        const keyboard = {
          inline_keyboard: selectable.map((model) => [
            { text: model, callback_data: encodeModelCallbackData(model) },
          ]),
        };
        console.log("Sending message with model selection keyboard");
        await bot.sendMessage(
          chatId,
          skipped > 0
            ? `${translate("choose_model")}\n(${skipped} model name${skipped === 1 ? "" : "s"} too long for a button.)`
            : translate("choose_model"),
          { reply_markup: JSON.stringify(keyboard) },
        );
        console.log("Message sent successfully");
      } catch (error) {
        console.error("Error in switchmodel command:", error);
        await bot.sendMessage(
          chatId,
          translate("error") +
            ": " +
            (error instanceof Error ? error.message : "Unknown error"),
        );
      }
    },
  },
  {
    name: "new",
    description: "new_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      await bot.clearContext(sessionKey, chatId);
    },
  },
  {
    name: "history",
    description: "history_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const summary = await bot.summarizeHistory(sessionKey);
      await bot.sendMessage(chatId, summary || translate("no_history"));
    },
  },
  {
    name: "help",
    description: "help_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      let helpMessage = translate("help_intro") + "\n\n";

      const groups: Array<[string, string[]]> = [
        [
          "Chat",
          [
            "start",
            "switchmodel",
            "new",
            "history",
            "compare",
            "translate",
            "rewrite",
            "summarize",
            "cancel",
          ],
        ],
        ["Agent runtime", ["agent", "quick", "artifact", "box"]],
        [
          "Research",
          [
            "research",
            "read",
            "sources",
            "feed",
            "followfeed",
            "feeds",
            "unfollowfeed",
            "arxiv",
            "github",
            "bookmark",
            "bookmarks",
            "unbookmark",
          ],
        ],
        [
          "Memory",
          ["memory", "remember", "recall", "forget", "people", "topics"],
        ],
        [
          "Utilities",
          [
            "calc",
            "convert",
            "currency",
            "date",
            "time",
            "weather",
            "remind",
            "reminders",
            "unremind",
            "digest",
            "digests",
            "undigest",
            "speak",
            "img",
            "flux",
          ],
        ],
        [
          "Group and admin",
          [
            "status",
            "dashboard",
            "setambient",
            "setreplystyle",
            "groupprofile",
            "setgroupprofile",
            "addgroupprofile",
            "cleargroupprofile",
            "usage",
            "cache",
            "synccommands",
          ],
        ],
      ];
      for (const [group, names] of groups) {
        helpMessage += `${group}\n`;
        for (const name of names) {
          const command = commands.find((candidate) => candidate.name === name);
          if (!command) continue;
          helpMessage += `/${command.name} - ${translate(command.description)}\n`;
        }
        helpMessage += "\n";
      }

      helpMessage += translate("image_analysis_description");

      await bot.sendMessage(chatId, helpMessage);
    },
  },
  {
    name: "groupprofile",
    description: "groupprofile_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const profile = await bot.getGroupProfile(sessionKey);
      if (!profile) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "no_group_profile"),
        );
        return;
      }

      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "group_profile", { profile }),
      );
    },
  },
  {
    name: "setgroupprofile",
    description: "setgroupprofile_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const profile = args.join(" ").trim();
      if (!profile) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "set_group_profile_usage"),
        );
        return;
      }

      await bot.setGroupProfile(sessionKey, profile);
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "group_profile_updated"),
      );
    },
  },
  {
    name: "addgroupprofile",
    description: "addgroupprofile_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const note = args.join(" ").trim();
      if (!note) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "add_group_profile_usage"),
        );
        return;
      }

      await bot.appendGroupProfile(sessionKey, note);
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "group_profile_added"),
      );
    },
  },
  {
    name: "cleargroupprofile",
    description: "cleargroupprofile_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      await bot.clearGroupProfile(sessionKey);
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "group_profile_cleared"),
      );
    },
  },
  {
    name: "synccommands",
    description: "synccommands_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (sessionKey.startsWith("group:")) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "private_only"),
        );
        return;
      }

      await bot.syncCommands();
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "menu_synced"),
      );
    },
  },
  {
    name: "status",
    description: "status_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (
        sessionKey.startsWith("group:") &&
        !(await requireGroupAdmin(chatId, sessionKey, userId, bot))
      ) {
        return;
      }

      const status = await bot.getStatus(sessionKey);
      const word = (key: UserMessageKey) => translateMessage(key);
      await bot.sendMessageWithFallback(
        chatId,
        translateMessage("status_report", {
          model: status.currentModel,
          summaryModel: status.summaryModel,
          researchModel: status.researchModel,
          visionModel: status.visionModel,
          ambientMemory: word(status.ambientMemory ? "value_on" : "value_off"),
          replyStyle: status.replyStyle,
          groupProfile: word(
            status.hasGroupProfile ? "value_set" : "value_empty",
          ),
          summary: word(status.hasSummary ? "value_present" : "value_empty"),
          recentTurns: status.recentTurnCount,
          ambientBuffer: status.ambientMessageCount,
          seenMembers: status.seenMemberCount,
          personCards: status.personCardCount,
          activeTopics: status.activeTopicCount,
          webSearch: `${word(status.webSearchAvailable ? "value_available" : "value_unavailable")} (${status.searchProviders.join(" → ") || word("value_none")})`,
          modelFallbacks:
            status.modelFallbacks.join(" → ") || word("value_none"),
          modelHealth:
            status.modelProviderHealth.map(formatProviderHealth).join(", ") ||
            word("value_no_observations"),
          searchHealth:
            status.searchProviderHealth.map(formatProviderHealth).join(", ") ||
            word("value_no_observations"),
          searchQuota:
            status.searchQuotas
              .map(
                (item) =>
                  `${item.provider}=${item.used}/${item.cap ?? word("value_uncapped")}`,
              )
              .join(", ") || word("value_none"),
          commandMenu: status.commandMenuStatus,
        }),
      );
    },
  },
  {
    name: "dashboard",
    description: "dashboard_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      if (!(await requireOwner(chatId, userId, bot))) return;
      if (sessionKey.startsWith("group:")) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "private_only"),
        );
        return;
      }
      const access = await bot.createDashboardLink(sessionKey, userId);
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "dashboard_link", {
          url: access.url,
          minutes: access.expiresInMinutes,
        }),
      );
    },
  },
];
