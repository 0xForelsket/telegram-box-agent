/**
 * Subset of the Telegram Bot API this worker consumes.
 *
 * Only the fields the bot reads are declared, so an unfamiliar field appearing
 * here means something depends on it. Telegram adds fields freely and never
 * removes them, so treat every optional member as genuinely optional: an update
 * that omits one is normal traffic, not a malformed request.
 *
 * Field names and value ranges follow https://core.telegram.org/bots/api.
 */
export namespace TelegramTypes {
  /** Chat kinds. Groups silently become supergroups, which changes `Chat.id`. */
  type ChatType = 'private' | 'group' | 'supergroup' | 'channel';

  /**
   * Entity kinds the bot inspects. Telegram defines more; the catch-all keeps
   * an unrecognised kind from failing the parse.
   */
  type MessageEntityType =
    | 'mention'
    | 'text_mention'
    | 'bot_command'
    | 'url'
    | 'email'
    | 'hashtag'
    | (string & {});

  type ChatMemberStatus =
    | 'creator'
    | 'administrator'
    | 'member'
    | 'restricted'
    | 'left'
    | 'kicked';

  interface Update {
    update_id: number;
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: CallbackQuery;
  }

  interface User {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  }

  interface Chat {
    id: number;
    type: ChatType;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  }

  interface Message {
    message_id: number;
    date: number;
    chat: Chat;
    from?: User;
    /** Present only in forum topics. */
    message_thread_id?: number;
    text?: string;
    caption?: string;
    photo?: PhotoSize[];
    voice?: Voice;
    document?: Document;
    entities?: MessageEntity[];
    caption_entities?: MessageEntity[];
    reply_to_message?: Message;
    /**
     * Set on the final message of a basic group that has just become a
     * supergroup. The supergroup receives a new id unrelated to the old one, so
     * anything keyed on chat id — an allowlist entry, stored state — refers to
     * a chat that no longer receives traffic until it is repointed.
     */
    migrate_to_chat_id?: number;
    /** Set on the first message of the resulting supergroup. */
    migrate_from_chat_id?: number;
  }

  interface PhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }

  interface Voice {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  }

  interface Document {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  }

  interface MessageEntity {
    type: MessageEntityType;
    /** UTF-16 code units, not characters: an emoji before the entity shifts it by two. */
    offset: number;
    length: number;
    url?: string;
    user?: User;
  }

  interface CallbackQuery {
    id: string;
    from: User;
    chat_instance: string;
    message?: Message;
    inline_message_id?: string;
    data?: string;
    game_short_name?: string;
  }

  interface SendMessageParams {
    chat_id: number | string;
    text: string;
    parse_mode?: 'Markdown' | 'HTML';
    disable_web_page_preview?: boolean;
    disable_notification?: boolean;
    reply_to_message_id?: number;
  }

  interface SendMessageResult {
    message_id: number;
    from: User;
    chat: Chat;
    date: number;
    text: string;
  }

  /** Only `status` is read; admin checks compare it against creator/administrator. */
  interface ChatMember {
    user: User;
    status: ChatMemberStatus;
    until_date?: number;
  }

  interface GetChatMemberResult {
    ok: boolean;
    result: ChatMember;
  }
}
