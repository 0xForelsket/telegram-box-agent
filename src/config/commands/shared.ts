import { TelegramCommandBot } from "../command_types";
import { translateMessage, UserMessageKey } from "../../utils/i18n";
import { ProviderHealth } from "../../utils/usage_tracker";

export type TelegramBot = TelegramCommandBot;

export function formatProviderHealth(item: ProviderHealth): string {
  const failures = Object.entries(item.errorCategories)
    .sort(([, left], [, right]) => right - left)
    .map(([category, count]) => `${category} ${count}`)
    .join(", ");
  return `${item.provider}=${item.status} (${item.successes}/${item.calls}${failures ? `; ${failures}` : ""})`;
}

export async function userMessage(
  _bot: TelegramBot,
  _userId: string,
  key: UserMessageKey,
  values: Record<string, string | number> = {},
): Promise<string> {
  return translateMessage(key, values);
}

export async function requireGroupAdmin(
  chatId: number,
  sessionKey: string,
  userId: string,
  bot: TelegramBot,
): Promise<boolean> {
  if (!sessionKey.startsWith("group:")) {
    await bot.sendMessageWithFallback(
      chatId,
      await userMessage(bot, userId, "group_only"),
    );
    return false;
  }

  try {
    const isAdmin = await bot.isUserGroupAdmin(chatId, userId);
    if (!isAdmin) {
      await bot.sendMessageWithFallback(
        chatId,
        await userMessage(bot, userId, "admin_only"),
      );
      return false;
    }
    return true;
  } catch {
    await bot.sendMessageWithFallback(
      chatId,
      await userMessage(bot, userId, "admin_check_failed"),
    );
    return false;
  }
}

export async function requireOwner(
  chatId: number,
  userId: string,
  bot: TelegramBot,
): Promise<boolean> {
  if (!bot.isOwner(userId)) {
    await bot.sendMessageWithFallback(
      chatId,
      await userMessage(bot, userId, "owner_only"),
    );
    return false;
  }
  return true;
}
