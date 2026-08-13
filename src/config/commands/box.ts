import { Command } from "../command_types";
import { requireOwner, type TelegramBot, userMessage } from "./shared";

export const boxCommands: Command[] = [
  {
    name: "box",
    description: "box_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      if ((args[0] || "").toLowerCase() !== "enable") {
        await bot.sendMessageWithFallback(
          chatId,
          "Usage: /box enable (owner-only, from the Telegram group to bind)",
        );
        return;
      }
      if (!(await requireOwner(chatId, userId, bot))) return;
      if (!sessionKey.startsWith("group:")) {
        await bot.sendMessageWithFallback(
          chatId,
          "Run /box enable inside the Telegram group you want to bind.",
        );
        return;
      }
      try {
        await bot.enableBoxForChat(chatId, sessionKey);
        await bot.sendMessageWithFallback(
          chatId,
          `Box execution is bound to this group (${chatId}).`,
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error
            ? error.message
            : "Failed to bind Box execution.",
        );
      }
    },
  },
  {
    name: "agent",
    description: "agent_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      try {
        const action = (args[0] || "").toLowerCase();
        if (action === "status") {
          await bot.sendMessageWithFallback(
            chatId,
            await bot.getBoxAgentStatus(chatId, userId, args[1]),
          );
          return;
        }
        if (action === "cancel") {
          if (!args[1]) {
            await bot.sendMessageWithFallback(
              chatId,
              "Usage: /agent cancel <job-id>",
            );
            return;
          }
          await bot.sendMessageWithFallback(
            chatId,
            await bot.cancelBoxAgentJob(chatId, userId, args[1]),
          );
          return;
        }
        if (action === "approve") {
          if (!args[1] || !args[2]) {
            await bot.sendMessageWithFallback(
              chatId,
              "Usage: /agent approve <job-id> <nonce>",
            );
            return;
          }
          await bot.sendMessageWithFallback(
            chatId,
            await bot.approveBoxAgentJob(chatId, userId, args[1], args[2]),
          );
          return;
        }
        if (action === "schedule") {
          const operation = (args[1] || "").toLowerCase();
          if (operation === "list") {
            await bot.sendMessageWithFallback(
              chatId,
              await bot.listBoxAgentSchedules(chatId, userId),
            );
            return;
          }
          if (["pause", "resume", "delete"].includes(operation)) {
            if (!args[2])
              throw new Error(
                `Usage: /agent schedule ${operation} <schedule-id>`,
              );
            await bot.sendMessageWithFallback(
              chatId,
              await bot.changeBoxAgentSchedule(
                chatId,
                userId,
                args[2],
                operation as "pause" | "resume" | "delete",
              ),
            );
            return;
          }
          if (operation === "create") {
            const fields = args.slice(2, 7);
            if (fields.length !== 5)
              throw new Error(
                "Usage: /agent schedule create <5-field UTC cron> [--model deepseek|glm] <prompt>",
              );
            const rest = args.slice(7);
            let requestedRoute: string | undefined;
            if (rest[0] === "--model") {
              rest.shift();
              requestedRoute = rest.shift();
            }
            const prompt = rest.join(" ").trim();
            if (!prompt) throw new Error("Scheduled agent prompt is required.");
            await bot.sendMessageWithFallback(
              chatId,
              await bot.createBoxAgentSchedule(
                chatId,
                userId,
                fields.join(" "),
                prompt,
                requestedRoute,
              ),
            );
            return;
          }
          throw new Error(
            "Usage: /agent schedule create|list|pause|resume|delete",
          );
        }

        let requestedRoute: string | undefined;
        const requestArgs = [...args];
        if (requestArgs[0]?.startsWith("--model=")) {
          requestedRoute = requestArgs.shift()!.slice("--model=".length);
        } else if (requestArgs[0] === "--model") {
          requestArgs.shift();
          requestedRoute = requestArgs.shift();
        }
        const request = requestArgs.join(" ").trim();
        if (!request) {
          await bot.sendMessageWithFallback(
            chatId,
            "Usage: /agent [--model deepseek|glm] <request>\n/agent status [job-id]\n/agent cancel <job-id>\n/agent approve <job-id> <nonce>",
          );
          return;
        }
        await bot.startBoxAgentJob(
          chatId,
          sessionKey,
          userId,
          request,
          requestedRoute,
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error ? error.message : "Box agent request failed.",
        );
      }
    },
  },
  {
    name: "quick",
    description: "quick_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
      args: string[],
    ) => {
      const request = args.join(" ").trim();
      if (!request) {
        await bot.sendMessageWithFallback(chatId, "Usage: /quick <request>");
        return;
      }
      try {
        await bot.runQuickChat(chatId, sessionKey, userId, request);
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error ? error.message : "Quick request failed.",
        );
      }
    },
  },
  {
    name: "artifact",
    description: "artifact_description",
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
          "Usage: /artifact <artifact-id>",
        );
        return;
      }
      try {
        await bot.sendMessageWithFallback(
          chatId,
          await bot.getArtifactLink(chatId, userId, args[0]),
        );
      } catch (error) {
        await bot.sendMessageWithFallback(
          chatId,
          error instanceof Error ? error.message : "Artifact lookup failed.",
        );
      }
    },
  },
  {
    name: "cancel",
    description: "cancel_description",
    action: async (
      chatId: number,
      sessionKey: string,
      userId: string,
      bot: TelegramBot,
    ) => {
      const type = await bot.cancelActiveTask(sessionKey);
      await bot.sendMessageWithFallback(
        chatId,
        type
          ? await userMessage(bot, userId, "cancelling_task", { type })
          : await userMessage(bot, userId, "no_active_task"),
      );
    },
  },
];
