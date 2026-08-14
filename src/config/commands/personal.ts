import { Command } from "../command_types";
import { translate, translateMessage } from "../../utils/i18n";
import { ImageGenerationAPI } from "../../api/image_generation";
import { sendChatAction } from "../../utils/helpers";
import { FluxAPI } from "../../api/flux-cf";
import { getConfig } from "../../env";
import { requireGroupAdmin, type TelegramBot, userMessage } from "./shared";
import { dispatchSubcommand } from "./subcommand";

export const personalCommands: Command[] = [
  {
    name: "bookmark",
    description: "bookmark_description",
    action: dispatchSubcommand({
      usage: "Usage: /bookmark <url> [title]\n/bookmark list\n/bookmark rm <id-or-title>",
      // Bare `/bookmark <url>` stays the primary form.
      fallback: async ({ chatId, sessionKey, userId, bot, args }) => {
        const [url, ...titleParts] = args;
        if (!url) {
          await bot.sendMessageWithFallback(
            chatId,
            await userMessage(bot, userId, "bookmark_usage"),
          );
          return;
        }
        try {
          await bot.addBookmark(sessionKey, url, titleParts.join(" "));
          await bot.sendMessageWithFallback(
            chatId,
            await userMessage(bot, userId, "bookmark_saved"),
          );
        } catch (error) {
          await bot.sendMessageWithFallback(
            chatId,
            await userMessage(bot, userId, "bookmark_failed", {
              error:
                error instanceof Error
                  ? error.message
                  : await userMessage(bot, userId, "unknown_error"),
            }),
          );
        }
      },
      subcommands: [
        {
          keywords: ["list", "ls"],
          handler: async ({ chatId, sessionKey, userId, bot }) => {
            await bot.sendMessageWithFallback(
              chatId,
              (await bot.listBookmarks(sessionKey)) ||
                (await userMessage(bot, userId, "no_bookmarks")),
            );
          },
        },
        {
          keywords: ["rm", "remove", "delete"],
          handler: async ({ chatId, sessionKey, userId, bot, args }) => {
            const removed = await bot.removeBookmark(sessionKey, args.join(" "));
            await bot.sendMessageWithFallback(
              chatId,
              removed
                ? await userMessage(bot, userId, "bookmark_removed", {
                    value: removed,
                  })
                : await userMessage(bot, userId, "bookmark_not_found"),
            );
          },
        },
      ],
    }),
  },
  {
    name: "setambient",
    description: "setambient_description",
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
    name: "setreplystyle",
    description: "setreplystyle_description",
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
    name: "img",
    description: "img_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!args.length) {
        await bot.sendMessageWithFallback(
          chatId,
          translate("image_prompt_required"),
        );
        return;
      }

      const validSizes = ["1024x1024", "1024x1792", "1792x1024"];
      const sizeArg = args[args.length - 1].toLowerCase();
      let size: string;
      let prompt: string;

      if (validSizes.includes(sizeArg)) {
        size = sizeArg;
        prompt = args.slice(0, -1).join(" ");
      } else {
        size = "1024x1024";
        prompt = args.join(" ");

        if (sizeArg.includes("x") || sizeArg.includes("*")) {
          const sizeOptions = validSizes.map((s) => `\`${s}\``).join(", ");
          await bot.sendMessage(
            chatId,
            translate("invalid_size") + sizeOptions,
          );
          return;
        }
      }

      let taskId: string | null = null;
      let progress: Awaited<
        ReturnType<TelegramBot["sendMessageWithFallback"]>
      > = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, "image");
        await sendChatAction(chatId, "upload_photo", bot.getEnv());
        progress = await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "image_progress"),
        );
        const imageApi = new ImageGenerationAPI(bot.getEnv());
        const startedAt = Date.now();
        try {
          const imageUrl = await imageApi.generateImage(prompt, size);
          bot.recordModelOperation(
            imageApi.getDefaultModel(),
            "image",
            startedAt,
            true,
          );
          await bot.assertTaskActive(sessionKey, taskId);
          await bot.sendPhoto(chatId, imageUrl, { caption: prompt });
          if (progress[0]?.message_id)
            await bot.replaceProgressMessage(
              chatId,
              progress[0].message_id,
              await userMessage(bot, userId, "image_complete"),
            );
        } catch (error) {
          bot.recordModelOperation(
            imageApi.getDefaultModel(),
            "image",
            startedAt,
            false,
            error,
          );
          throw error;
        }
      } catch (error) {
        console.error("Error generating image:", error);
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            translate("image_generation_error"),
          );
        else await bot.sendMessage(chatId, translate("image_generation_error"));
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: "flux",
    description: "flux_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if (!args.length) {
        await bot.sendMessage(chatId, translate("flux_usage"));
        return;
      }

      let aspectRatio = "1:1";
      let prompt: string;

      const fluxApi = new FluxAPI(bot.getEnv());
      const validRatios = fluxApi.getValidAspectRatios();

      if (validRatios.includes(args[args.length - 1])) {
        aspectRatio = args[args.length - 1];
        prompt = args.slice(0, -1).join(" ");
      } else {
        prompt = args.join(" ");
      }

      let taskId: string | null = null;
      let progress: Awaited<
        ReturnType<TelegramBot["sendMessageWithFallback"]>
      > = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, "image");
        await sendChatAction(chatId, "upload_photo", bot.getEnv());
        progress = await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "image_progress"),
        );
        const startedAt = Date.now();
        let imageData: Uint8Array;
        let optimizedPrompt: string | undefined;
        try {
          ({ imageData, optimizedPrompt } = await fluxApi.generateImage(
            prompt,
            aspectRatio,
          ));
          bot.recordModelOperation(
            fluxApi.getDefaultModel(),
            "image",
            startedAt,
            true,
          );
          await bot.assertTaskActive(sessionKey, taskId);
        } catch (error) {
          bot.recordModelOperation(
            fluxApi.getDefaultModel(),
            "image",
            startedAt,
            false,
            error,
          );
          throw error;
        }

        const config = getConfig(bot.getEnv());
        let caption = `${translate("original_prompt")}: ${prompt}\n`;
        caption += `${translate("image_specs")}: ${aspectRatio}\n`;

        if (config.promptOptimization && optimizedPrompt) {
          caption += `${translate("prompt_generation_model")}: ${config.externalModel || "Unknown"}\n`;
          caption += `${translate("optimized_prompt")}: ${optimizedPrompt}\n`;
        }

        await bot.sendPhoto(chatId, imageData, { caption: caption });
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            await userMessage(bot, userId, "image_complete"),
          );
      } catch (error) {
        console.error(`Error generating Flux image for user ${userId}:`, error);
        if (error instanceof Error) {
          console.error("Error details:", error.message);
        }
        if (progress[0]?.message_id)
          await bot.replaceProgressMessage(
            chatId,
            progress[0].message_id,
            translate("image_generation_error"),
          );
        else await bot.sendMessage(chatId, translate("image_generation_error"));
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: "people",
    description: "people_description",
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

      const formatted = await bot.getFormattedPersonCards(sessionKey);
      if (!formatted) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "no_people"),
        );
        return;
      }

      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "people_header", { value: formatted }),
      );
    },
  },
  {
    name: "topics",
    description: "topics_description",
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

      const formatted = await bot.getFormattedActiveTopics(sessionKey);
      if (!formatted) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "no_topics"),
        );
        return;
      }

      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "topics_header", { value: formatted }),
      );
    },
  },
  {
    name: "memory",
    description: "memory_description",
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

      const summary = await bot.getFormattedSummary(sessionKey);
      if (!summary) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "no_summary"),
        );
        return;
      }

      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "summary_header", { value: summary }),
      );
    },
  },
  {
    name: "remember",
    description: "remember_description",
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
      )
        return;
      const text = args.join(" ").trim();
      if (!text) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "remember_usage"),
        );
        return;
      }
      const id = await bot.rememberDurableMemory(sessionKey, text);
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "remembered", { id }),
      );
    },
  },
  {
    name: "recall",
    description: "recall_description",
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
      )
        return;
      const result = await bot.recallDurableMemory(
        sessionKey,
        args.join(" ").trim(),
      );
      await bot.sendMessageWithFallback(
        chatId,
        result
          ? await userMessage(bot, userId, "memories_header", { value: result })
          : await userMessage(bot, userId, "no_memory_match"),
      );
    },
  },
  {
    name: "forget",
    description: "forget_description",
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

      const name = args.join(" ").trim();
      if (!name) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "forget_usage"),
        );
        return;
      }

      const forgottenMemory = await bot.forgetSavedMemory(sessionKey, name);
      if (forgottenMemory) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "memory_forgotten", {
            value: forgottenMemory,
          }),
        );
        return;
      }

      const deleted = await bot.deletePersonCard(sessionKey, name);
      if (deleted) {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "person_forgotten", { name }),
        );
      } else {
        await bot.sendMessageWithFallback(
          chatId,
          await userMessage(bot, userId, "person_not_found", { name }),
        );
      }
    },
  },
];
