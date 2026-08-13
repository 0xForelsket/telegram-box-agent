import { TelegramTypes } from "../../../types/telegram";
import { fetchJson } from "../../utils/helpers";

import { TelegramBotBase } from "./base";

export abstract class TelegramAuthorizationBot extends TelegramBotBase {
  protected reportChatMigration(message: TelegramTypes.Message): void {
    const migratedTo = message.migrate_to_chat_id;
    if (migratedTo !== undefined) {
      console.error(
        `Telegram group ${message.chat.id} has migrated to supergroup ${migratedTo}. ` +
          `Update WHITELISTED_GROUPS to "${migratedTo}" or the bot will stop answering there.`,
      );
      return;
    }
    const migratedFrom = message.migrate_from_chat_id;
    if (
      migratedFrom !== undefined &&
      !this.isGroupWhitelisted(message.chat.id)
    ) {
      console.error(
        `Received traffic from supergroup ${message.chat.id}, migrated from group ${migratedFrom}, ` +
          "which is not in WHITELISTED_GROUPS. Update it to restore access.",
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

  isAuthorized(input: {
    userId: string;
    chatId: number;
    chatType: TelegramTypes.Chat["type"];
  }): boolean {
    // Deny by default. An unset whitelist previously authorized every Telegram
    // user who could reach the webhook.
    if (
      this.whitelistedUsers.length === 0 &&
      this.whitelistedGroups.length === 0
    ) {
      console.error(
        "Neither WHITELISTED_USERS nor WHITELISTED_GROUPS is configured; denying every request. " +
          "Set WHITELISTED_USERS to numeric Telegram user IDs and/or WHITELISTED_GROUPS to numeric group chat IDs.",
      );
      return false;
    }
    if (this.isUserWhitelisted(input.userId)) return true;
    return (
      input.chatType !== "private" && this.isGroupWhitelisted(input.chatId)
    );
  }

  isOwner(userId: string): boolean {
    // Ownership must be stated, never inferred. Inferring it from a
    // single-entry whitelist meant adding a second user silently revoked it.
    const configuredOwner = this.config.ownerUserId;
    return !!configuredOwner && configuredOwner === userId;
  }

  async isUserGroupAdmin(chatId: number, userId: string): Promise<boolean> {
    const result = await fetchJson<TelegramTypes.GetChatMemberResult>(
      `${this.apiUrl}/getChatMember`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          user_id: parseInt(userId),
        }),
      },
      "Failed to get chat member",
    );
    if (!result.ok) {
      throw new Error("Failed to get chat member");
    }
    return (
      result.result.status === "creator" ||
      result.result.status === "administrator"
    );
  }

  protected getSessionKey(
    chatId: number,
    userId: string,
    chatType: TelegramTypes.Chat["type"],
  ): string {
    if (chatType === "private") {
      return userId;
    }
    return `group:${chatId}`;
  }

  protected getUserIdFromSessionKey(sessionKey: string): string {
    if (sessionKey.startsWith("group:")) {
      return sessionKey;
    }
    const parts = sessionKey.split(":");
    return parts[parts.length - 1];
  }
}

export default TelegramAuthorizationBot;
