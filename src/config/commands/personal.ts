import { Command } from "../command_types";
import { translate, translateMessage } from "../../utils/i18n";
import { ImageGenerationAPI } from "../../api/image_generation";
import { sendChatAction } from "../../utils/helpers";
import { FluxAPI } from "../../api/flux-cf";
import { getConfig } from "../../env";
import { requireGroupAdmin, type TelegramBot, userMessage } from "./shared";
import { dispatchSubcommand } from "./subcommand";

/** The Flux backend of `/img --flux`, kept out of the command body so the two
 * generation paths stay readable side by side. */
async function runFluxGeneration(
  chatId: number,
  sessionKey: string,
  userId: string,
  bot: TelegramBot,
  args: string[],
): Promise<void> {
  let aspectRatio = "1:1";
  const fluxApi = new FluxAPI(bot.getEnv());
  const validRatios = fluxApi.getValidAspectRatios();
  let prompt: string;
  if (validRatios.includes(args[args.length - 1])) {
    aspectRatio = args[args.length - 1];
    prompt = args.slice(0, -1).join(" ");
  } else {
    prompt = args.join(" ");
  }

  let taskId: string | null = null;
  let progress: Awaited<ReturnType<TelegramBot["sendMessageWithFallback"]>> = [];
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
      bot.recordModelOperation(fluxApi.getDefaultModel(), "image", startedAt, true);
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

    await bot.sendPhoto(chatId, imageData, { caption });
    if (progress[0]?.message_id)
      await bot.replaceProgressMessage(
        chatId,
        progress[0].message_id,
        await userMessage(bot, userId, "image_complete"),
      );
  } catch (error) {
    console.error(`Error generating Flux image for user ${userId}:`, error);
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
}

export const personalCommands: Command[] = [
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
      // `--flux` replaces the separate /flux command: same action, different
      // backend, so it is a flag rather than a second entry in the menu.
      const useFlux = args.some((arg) => /^--flux$/i.test(arg));
      args = args.filter((arg) => !/^--flux$/i.test(arg));
      if (!args.length) {
        await bot.sendMessageWithFallback(
          chatId,
          translate("image_prompt_required"),
        );
        return;
      }
      if (useFlux) {
        await runFluxGeneration(chatId, sessionKey, userId, bot, args);
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
];
