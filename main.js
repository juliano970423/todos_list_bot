import { Bot, InlineKeyboard } from "grammy";
import { initDatabase } from "./db.js";
import { handleMessage, handleCallbackQuery } from "./router.js";
import { processScheduledReminders } from "./task.js";

export default {
  async fetch(request, env, ctx) {
    await initDatabase(env);
    const bot = new Bot(env.BOT_TOKEN);

    // --- 1. 訊息接收與分流 ---
    bot.on("message:text", async (ctx) => {
      await handleMessage(ctx, env);
    });

    // --- 7. Callback 互動處理 ---
    bot.on("callback_query:data", async (ctx) => {
      await handleCallbackQuery(ctx, env);
    });

    return bot.handle(request);
  },

  // --- 9. 定時任務 (Cron Trigger) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    await processScheduledReminders(bot, env);
  }
};