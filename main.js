import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

export default {
  async fetch(request, env) {
    const bot = new Bot(env.BOT_TOKEN);

    bot.command("start", (ctx) => {
      return ctx.reply("🤖 Todo 提醒機器人 (npm 版)\n\n直接輸入任務加時間，例如：\n• 「買牛奶 明天下午 2 點」\n• 「開會 09:00」");
    });

    bot.command("list", async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const { results } = await env.DB.prepare(
          "SELECT * FROM todos WHERE user_id = ? AND status = 0 ORDER BY remind_at ASC"
        ).bind(userId).all();
        
        if (results.length === 0) return ctx.reply("📭 目前沒有待辦事項。");
        
        const keyboard = new InlineKeyboard();
        results.forEach(todo => {
          const timeStr = new Date(todo.remind_at * 1000).toLocaleString('zh-TW', { 
            timeZone: 'Asia/Taipei', 
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false 
          });
          keyboard.text(`🗑️ [${timeStr}] ${todo.task}`, `del_${todo.id}`).row();
        });

        await ctx.reply("📝 你的待辦清單：", { reply_markup: keyboard });
      } catch (error) {
        console.error('list command error:', error);
        return ctx.reply('❌ 系統錯誤，請稍後再試');
      }
    });

    bot.on("callback_query:data", async (ctx) => {
      try {
        if (ctx.callbackQuery.data.startsWith("del_")) {
          const todoId = ctx.callbackQuery.data.split("_")[1];
          await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(todoId).run();
          await ctx.answerCallbackQuery("任務已刪除！");
          await ctx.editMessageText("✅ 任務已從清單中移除。");
        }
      } catch (error) {
        console.error('callback error:', error);
        await ctx.answerCallbackQuery("❌ 刪除失敗");
      }
    });

    bot.on("message:text", async (ctx) => {
      try {
        const text = ctx.message.text;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const parseResults = chrono.parse(text);
        
        if (parseResults.length === 0) {
          return ctx.reply("❓ 我不知道什麼時候該提醒你。請加上時間資訊。");
        }

        let targetDate = parseResults[0].date();
        let remindAt = Math.floor(targetDate.getTime() / 1000);

        if (remindAt <= nowSeconds) {
          remindAt += 86400; 
          targetDate = new Date(remindAt * 1000);
        }

        const task = text.replace(parseResults[0].text, "").trim() || text;
        const userId = ctx.from.id.toString();

        await env.DB.prepare(
          "INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 0)"
        ).bind(userId, task, remindAt).run();

        const displayTime = targetDate.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
        });

        await ctx.reply(`✅ 已預約提醒：\n📌 內容：${task}\n⏰ 時間：${displayTime}`);
      } catch (error) {
        console.error('message error:', error);
        return ctx.reply('❌ 處理訊息時發生錯誤');
      }
    });

    // ✅ 關鍵修正：使用 webhookCallback
    const { webhookCallback } = bot;
    return webhookCallback(request);
  },

  async scheduled(event, env, ctx) {
    try {
      const bot = new Bot(env.BOT_TOKEN);
      const now = Math.floor(Date.now() / 1000);

      const { results } = await env.DB.prepare(
        "SELECT * FROM todos WHERE status = 0 AND remind_at <= ?"
      ).bind(now).all();

      if (results && results.length > 0) {
        for (const todo of results) {
          try {
            await bot.api.sendMessage(todo.user_id, `⏰ 時間到囉！\n任務內容：${todo.task}`);
            await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
          } catch (e) {
            console.error('send reminder error:', e);
          }
        }
      }
    } catch (error) {
      console.error('scheduled error:', error);
    }
  }
};