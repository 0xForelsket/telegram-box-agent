import TelegramMessageHandlingBot from "./telegram/message_handling";

/** Public facade assembled from responsibility-focused Telegram modules. */
class TelegramBot extends TelegramMessageHandlingBot {}

export default TelegramBot;
