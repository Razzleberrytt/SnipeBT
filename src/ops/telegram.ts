import { Telegraf } from "../vendor/telegram-lib";
import { loadConfig } from "../config";
export function maybeStartTelegram(){
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = loadConfig();
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  bot.command("status", (ctx: any) => ctx.reply("SnipeBT running"));
  bot.launch();
}
