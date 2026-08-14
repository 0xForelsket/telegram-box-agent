import { Command } from "../command_types";
import { translate, translateMessage } from "../../utils/i18n";
import { commands } from "../commands";
import { encodeModelCallbackData, fitsCallbackData } from "../callback_data";
import { dispatchSubcommand } from "./subcommand";
import {
  requireGroupAdmin,
  requireOwner,
  type TelegramBot,
  userMessage,
} from "./shared";

export const coreCommands: Command[] = [
  {
    name: "start",
    description: "start_description",
    action: async (chatId: number, _sessionKey: string, _userId: string, bot: TelegramBot) => {
      await bot.sendMessageWithFallback(chatId, translate("welcome"));
    },
  },
  {
    name: "help",
    description: "help_description",
    action: async (chatId: number, _sessionKey: string, _userId: string, bot: TelegramBot) => {
      // Deliberately short. Most capability is reachable by asking, so listing
      // commands is no longer the way to discover what the bot can do — the
      // second half of this message matters more than the first.
      const lines = [translate("help_intro"), ""];
      for (const command of commands) {
        lines.push(`/${command.name} - ${translate(command.description)}`);
      }
      lines.push(
        "",
        "Everything else is conversational. Just ask:",
        "· maths, unit conversion, times, dates",
        "· weather, currency, stocks, GitHub, arXiv, Wikipedia",
        "· web search, reading a link, researching a question",
        "· reminders and digests — \"remind me in 20 minutes to stretch\"",
        "· bookmarks, feeds, and things to remember",
        "",
        "Tap the menu button for status, usage, schedules, saved links, and memory.",
        "",
        translate("image_analysis_description"),
      );
      await bot.sendMessage(chatId, lines.join("\n"));
    },
  },
  {
    name: "new",
    description: "new_description",
    action: async (chatId: number, sessionKey: string, _userId: string, bot: TelegramBot) => {
      await bot.clearContext(sessionKey, chatId);
    },
  },
  {
    name: "model",
    description: "model_description",
    action: async (chatId: number, _sessionKey: string, _userId: string, bot: TelegramBot) => {
      try {
        const availableModels = await bot.getSelectableModels();
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
        await bot.sendMessage(
          chatId,
          skipped > 0
            ? `${translate("choose_model")}\n(${skipped} model name${skipped === 1 ? "" : "s"} too long for a button.)`
            : translate("choose_model"),
          {
            reply_markup: JSON.stringify({
              inline_keyboard: selectable.map((model) => [
                { text: model, callback_data: encodeModelCallbackData(model) },
              ]),
            }),
          },
        );
      } catch (error) {
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
    // One control surface for the things that change how the bot behaves,
    // rather than a command per toggle.
    name: "settings",
    description: "settings_description",
    action: dispatchSubcommand({
      usage: [
        "Usage:",
        "/settings ambient on|off",
        "/settings style short|normal|long",
        "/settings profile [set|add|clear] <text>",
        "/settings dashboard",
      ].join("\n"),
      fallback: async ({ chatId, sessionKey, userId, bot }) => {
        const settings = await bot.getBotSettings(sessionKey);
        const profile = await bot.getGroupProfile(sessionKey);
        await bot.sendMessageWithFallback(
          chatId,
          [
            `Ambient memory: ${settings.ambientMemory ? "on" : "off"}`,
            `Reply style: ${settings.replyStyle}`,
            `Group profile: ${profile ? `${profile.length} chars` : "none"}`,
            "",
            "/settings ambient on|off",
            "/settings style short|normal|long",
            "/settings profile [set|add|clear] <text>",
            bot.isOwner(userId) ? "/settings dashboard" : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
      subcommands: [
        {
          keywords: ["ambient"],
          handler: async ({ chatId, sessionKey, userId, bot, args }) => {
            if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) return;
            const value = (args[0] || "").toLowerCase();
            if (!["on", "off"].includes(value)) {
              await bot.sendMessageWithFallback(
                chatId,
                await userMessage(bot, userId, "ambient_usage"),
              );
              return;
            }
            const settings = await bot.setBotSettings(sessionKey, {
              ambientMemory: value === "on",
            });
            await bot.sendMessageWithFallback(
              chatId,
              await userMessage(bot, userId, "ambient_updated", {
                value: translateMessage(
                  settings.ambientMemory ? "value_on" : "value_off",
                ),
              }),
            );
          },
        },
        {
          keywords: ["style", "replystyle"],
          handler: async ({ chatId, sessionKey, userId, bot, args }) => {
            if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) return;
            const replyStyle = (args[0] || "").toLowerCase();
            if (!["short", "normal", "long"].includes(replyStyle)) {
              await bot.sendMessageWithFallback(
                chatId,
                await userMessage(bot, userId, "reply_style_usage"),
              );
              return;
            }
            const settings = await bot.setBotSettings(sessionKey, {
              replyStyle: replyStyle as "short" | "normal" | "long",
            });
            await bot.sendMessageWithFallback(
              chatId,
              await userMessage(bot, userId, "reply_style_updated", {
                value: settings.replyStyle,
              }),
            );
          },
        },
        {
          keywords: ["profile", "groupprofile"],
          handler: async ({ chatId, sessionKey, userId, bot, args }) => {
            if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) return;
            const operation = (args[0] || "").toLowerCase();
            const rest = args.slice(1).join(" ").trim();
            if (operation === "set") {
              if (!rest) {
                await bot.sendMessageWithFallback(
                  chatId,
                  await userMessage(bot, userId, "set_group_profile_usage"),
                );
                return;
              }
              await bot.setGroupProfile(sessionKey, rest);
              await bot.sendMessageWithFallback(
                chatId,
                await userMessage(bot, userId, "group_profile_updated"),
              );
              return;
            }
            if (operation === "add") {
              if (!rest) {
                await bot.sendMessageWithFallback(
                  chatId,
                  await userMessage(bot, userId, "add_group_profile_usage"),
                );
                return;
              }
              await bot.appendGroupProfile(sessionKey, rest);
              await bot.sendMessageWithFallback(
                chatId,
                await userMessage(bot, userId, "group_profile_added"),
              );
              return;
            }
            if (operation === "clear") {
              await bot.clearGroupProfile(sessionKey);
              await bot.sendMessageWithFallback(
                chatId,
                await userMessage(bot, userId, "group_profile_cleared"),
              );
              return;
            }
            const profile = await bot.getGroupProfile(sessionKey);
            await bot.sendMessageWithFallback(
              chatId,
              profile
                ? await userMessage(bot, userId, "group_profile", { profile })
                : await userMessage(bot, userId, "no_group_profile"),
            );
          },
        },
        {
          keywords: ["dashboard"],
          handler: async ({ chatId, sessionKey, userId, bot }) => {
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
      ],
    }),
  },
];
