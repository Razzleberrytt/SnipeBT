import { Telegraf } from "../vendor/telegram-lib";
import { loadConfig } from "../config";

let botInstance: any = null;
let chatId: string | null = null;

export function maybeStartTelegram() {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = loadConfig();
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (botInstance) return;
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  bot.command("status", (ctx: any) => ctx.reply("SnipeBT running"));
  try {
    bot.launch();
    botInstance = bot;
    chatId = TELEGRAM_CHAT_ID;
  } catch (error) {
    console.warn("[Telegram] Failed to launch bot", error);
  }
}

export async function notifyTelegram(message: string): Promise<void> {
  if (!botInstance || !chatId) {
    return;
  }

  try {
    const telegram = botInstance.telegram;
    if (telegram?.sendMessage) {
      await telegram.sendMessage(chatId, message, { disable_web_page_preview: true });
      return;
    }

    if (typeof botInstance.sendMessage === "function") {
      await botInstance.sendMessage(chatId, message);
      return;
    }
  } catch (error) {
    console.warn("[Telegram] notify failed", error);
  }
}
