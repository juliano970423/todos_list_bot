import { Bot, InlineKeyboard } from "grammy";
import { initDatabase } from "./db.js";
import { handleMessage, handleCallbackQuery } from "./router.js";
import { processScheduledReminders } from "./task.js";

export default {
  async fetch(request, env, ctx) {
    await initDatabase(env);
    const bot = new Bot(env.BOT_TOKEN);
    await bot.init(); // 初始化機器人

    // --- 1. 訊息接收與分流 ---
    bot.on("message:text", async (ctx) => {
      await handleMessage(ctx, env);
    });

    // --- 7. Callback 互動處理 ---
    bot.on("callback_query:data", async (ctx) => {
      await handleCallbackQuery(ctx, env);
    });

    // --- 新增: /help 指令處理 ---
    bot.command("help", async (ctx) => {
      const helpMessage = `📋 <b>待辦事項機器人使用說明</b>

<b>基本指令：</b>
• <code>/list</code> - 查看待辦事項清單
• <code>/list [時間範圍]</code> - 查詢特定時間範圍的任務
  • 例如：<code>/list today</code>, <code>/list tomorrow</code>, <code>/list this week</code>
• <code>/history</code> - 查看已完成的任務歷史
• <code>/history [時間範圍]</code> - 查詢特定時間範圍的歷史記錄

<b>任務建立：</b>
• 直接輸入任務描述，例如："提醒我明天下午3點開會"
  • 支援自然語言時間表達：今天、明天、後天、週一、下週、本月、明年等
  • 支援週期性任務：每天、每週一、每月5號、每年1月1號等

<b>例行性任務查詢：</b>
• <code>/list 例行</code> 或 <code>/list 重複</code> - 查看所有週期性任務
• <code>/list 每天</code>, <code>/list 每週</code>, <code>/list 每月</code>, <code>/list 每年</code> - 查詢特定類型的週期性任務

<b>互動功能：</b>
• 點擊任務旁邊的 ✅ 確認儲存按鈕來保存任務
• 點擊 🤖 AI重新判斷 可以讓AI重新解析您的任務描述
• 點擊 🗑️ 管理模式 可以刪除任務

<b>時間格式支援：</b>
• 24小時制：21:00, 20:30
• 12小時制：9pm, 8:30am
• 中文時間：9點、晚上8點58分
• 日期格式：1月1號、Jan 1st

💡 小提示：如果AI解析結果不正確，可以點擊「AI重新判斷」按鈕讓AI重新分析！`;

      await ctx.reply(helpMessage, { parse_mode: "HTML" });
    });

    // 使用 Grammy 的 webhook 适配器
    const update = await request.json();
    await bot.handleUpdate(update);
    return new Response("OK");
  },

  // --- 9. 定時任務 (Cron Trigger) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    await processScheduledReminders(bot, env);
  }
};