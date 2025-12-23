import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

// === 設定與常數 ===
const TAIPEI_TIMEZONE_OFFSET = 8 * 60; // 台灣是 UTC+8 (分鐘)
const NO_TIME_LIMIT = -1;

// 提醒類型定義
const TYPE_ONCE = 0;    // 單次
const TYPE_DAILY = 1;   // 每天
const TYPE_WEEKLY = 2;  // 每週
const TYPE_MONTHLY = 3; // 每月

// 狀態追蹤 (暫存用戶輸入狀態)
const userParsingState = new Map();

export default {
  async fetch(request, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);

    // --- 指令區域 ---

    bot.command("start", (ctx) => {
      return ctx.reply(
        "🤖 超強 Todo 提醒機器人 (台灣時區版)\n\n" +
        "直接輸入任務，支援自然語言：\n" +
        "• 「明天下午2點 買牛奶」\n" +
        "• 「每天 09:00 吃藥」\n" +
        "• 「每週五 晚上8點 倒垃圾」\n" +
        "• 「每月 5號 繳房租」\n" +
        "• 「10分鐘後 提醒我喝水」\n\n" +
        "時間計算已修正，不再會有時差問題！"
      );
    });

    bot.command("list", async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        // 抓取未完成 (status=0) 的任務，依時間排序
        const { results } = await env.DB.prepare(
          "SELECT * FROM todos WHERE user_id = ? AND status = 0 ORDER BY remind_at ASC"
        ).bind(userId).all();
        
        if (!results || results.length === 0) return ctx.reply("📭 目前沒有待辦事項。");
        
        let replyText = "📝 你的待辦清單：\n\n";
        const keyboard = new InlineKeyboard();
        
        results.forEach(todo => {
          const typeIcon = getRecurrenceIcon(todo.reminder_type);
          let timeStr = "";

          if (todo.remind_at === NO_TIME_LIMIT) {
            timeStr = "無時間限制";
          } else {
            // 資料庫存的是 UTC Timestamp，轉成台灣時間顯示
            timeStr = unixToTaipeiString(todo.remind_at);
          }

          replyText += `• ${typeIcon} ${todo.task}\n   📅 ${timeStr}\n`;
          keyboard.text(`🗑️ 刪除 ${todo.task.substring(0, 5)}...`, `del_${todo.id}`).row();
        });

        await ctx.reply(replyText, { reply_markup: keyboard });
      } catch (error) {
        console.error('list error:', error);
        return ctx.reply('❌ 讀取清單失敗');
      }
    });

    // --- 互動按鈕處理 ---

    bot.on("callback_query:data", async (ctx) => {
      const userId = ctx.from.id.toString();
      const state = userParsingState.get(userId);
      const data = ctx.callbackQuery.data;

      try {
        if (data.startsWith("del_")) {
          const todoId = data.split("_")[1];
          await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(todoId).run();
          await ctx.answerCallbackQuery("已刪除");
          await ctx.editMessageText("🗑️ 任務已刪除。");
        } 
        else if (data === "confirm_save" && state) {
          await saveTaskToDB(ctx, env, state);
          userParsingState.delete(userId);
          await ctx.answerCallbackQuery("✅ 儲存成功");
        } 
        else if (data === "retry_ai" && state) {
          await ctx.answerCallbackQuery("🤖 AI 重新思考中...");
          await processWithAI(ctx, env, state.originalText); // 重新呼叫 AI
        }
        else if (data === "cancel" && state) {
          userParsingState.delete(userId);
          await ctx.answerCallbackQuery("已取消");
          await ctx.editMessageText("❌ 操作已取消");
        }
      } catch (error) {
        console.error('Callback error:', error);
        await ctx.answerCallbackQuery("❌ 發生錯誤");
      }
    });

    // --- 訊息處理核心 ---

    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      
      // 1. 先嘗試本地正則與 Chrono 解析 (速度快)
      // 判斷是否包含週期性關鍵字
      let recurrence = TYPE_ONCE;
      if (text.match(/每[天日]/)) recurrence = TYPE_DAILY;
      else if (text.match(/每[週周]/)) recurrence = TYPE_WEEKLY;
      else if (text.match(/每[月]/)) recurrence = TYPE_MONTHLY;

      // 使用 Chrono 解析時間
      const localResult = parseTimeLocally(text);

      // 如果本地解析失敗，或者使用者似乎想要複雜的語意，就轉交給 AI
      // 這裡簡化邏輯：如果沒有解析出時間，或者時間信心度低，就用 AI
      if (!localResult) {
        return await processWithAI(ctx, env, text);
      }

      // 如果本地解析成功，顯示預覽
      // 注意：如果是週期性任務，Chrono 解析出的是「下一次發生的時間」
      const state = {
        originalText: text,
        task: localResult.task,
        remindAt: localResult.utcTimestamp, // 這是 UTC Timestamp
        recurrence: recurrence,
        source: 'local'
      };

      await sendConfirmation(ctx, state);
    });

    // --- 輔助函數 ---

    async function processWithAI(ctx, env, text) {
      const processingMsg = await ctx.reply("🤖 正在分析任務與時間...");
      const aiResult = await callAI(text, env);

      // 刪除「正在分析...」訊息 (如果權限允許，否則忽略)
      try { await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch(e){}

      if (!aiResult) {
        return ctx.reply("❌ AI 無法理解您的時間需求，請嘗試換個說法 (例如：明天早上9點 開會)");
      }

      const state = {
        originalText: text,
        task: aiResult.task,
        remindAt: aiResult.utcTimestamp,
        recurrence: aiResult.recurrence, // 0, 1, 2, 3
        source: 'ai'
      };

      await sendConfirmation(ctx, state);
    }

    async function sendConfirmation(ctx, state) {
      const userId = ctx.from.id.toString();
      userParsingState.set(userId, state);

      const timeStr = unixToTaipeiString(state.remindAt);
      const recurStr = getRecurrenceName(state.recurrence);
      const sourceStr = state.source === 'ai' ? '🤖 AI 解析' : '⚡ 快速解析';

      const keyboard = new InlineKeyboard()
        .text("✅ 確認新增", "confirm_save")
        .text("🤖 用 AI 重試", "retry_ai")
        .text("❌ 取消", "cancel");

      await ctx.reply(
        `請確認任務內容：\n\n` +
        `📌 任務：${state.task}\n` +
        `🕒 時間：${timeStr}\n` +
        `🔄 週期：${recurStr}\n` +
        `🔍 來源：${sourceStr}`,
        { reply_markup: keyboard }
      );
    }

    async function saveTaskToDB(ctx, env, state) {
      const userId = ctx.from.id.toString();
      try {
        await env.DB.prepare(
          "INSERT INTO todos (user_id, task, remind_at, status, reminder_type, last_reminded) VALUES (?, ?, ?, 0, ?, NULL)"
        ).bind(userId, state.task, state.remindAt, state.recurrence).run();

        await ctx.editMessageText(
          `✅ 任務已儲存！\n下一次提醒：${unixToTaipeiString(state.remindAt)}`
        );
      } catch (e) {
        console.error('Save DB error', e);
        await ctx.reply("❌ 資料庫錯誤");
      }
    }

    // --- 解析邏輯 (核心修正區) ---

    function getTaipeiNow() {
      // 取得現在的 UTC 時間物件
      const now = new Date();
      // 為了讓 chrono 理解「明天」是相對於台灣的明天，我們建立一個「Shift 過的時間物件」
      // 但這個物件僅用於 Chrono 的 reference，不能直接拿來當結果
      return new Date(now.getTime() + TAIPEI_TIMEZONE_OFFSET * 60000);
    }

    function parseTimeLocally(text) {
      try {
        // 設定參考時間為台灣現在時間
        const taipeiRef = getTaipeiNow();
        
        const results = chrono.parse(text, taipeiRef, { forwardDate: true });
        if (results.length === 0) return null;

        const result = results[0];
        const extractedText = result.text;
        const task = text.replace(extractedText, "").trim() || text;

        // 【核心修正】
        // Chrono 解析出的 date() 是基於我們給的 reference (台灣時間) 算出的「字面時間」。
        // 在 UTC 環境下，它會被當作 UTC。例如解析出 "09:00"，會變成 09:00 UTC。
        // 但我們其實是指 09:00 台灣時間 (即 01:00 UTC)。
        // 所以我們要把它「減回來」。
        const chronoDate = result.date();
        let utcTimestamp = Math.floor((chronoDate.getTime() - TAIPEI_TIMEZONE_OFFSET * 60000) / 1000);

        // 防止過去時間 (如果 Chrono 沒自動推未來)
        // 允許 60 秒的誤差緩衝
        const nowUnix = Math.floor(Date.now() / 1000);
        
        // 判斷使用者是否明確指定日期 (如果指定 "12月23日"，就算過了也不要亂加一天，可能是補登)
        const isExplicitDate = result.start.isCertain('day') || result.start.isCertain('weekday');

        if (!isExplicitDate && utcTimestamp < nowUnix) {
           // 只說時間沒說日期，且時間已過 -> 加一天
           utcTimestamp += 86400;
        }

        return { task, utcTimestamp, method: 'chrono' };
      } catch (e) {
        console.error(e);
        return null;
      }
    }

    async function callAI(text, env) {
      // 這是你原本的 AI 邏輯，但我更新了 Prompt 以支援週期
      const taipeiNow = new Date(Date.now() + TAIPEI_TIMEZONE_OFFSET * 60000);
      const timeStr = taipeiNow.toISOString().replace('Z', '+08:00');
      
      const prompt = `
      現在台灣時間是：${timeStr} (${taipeiNow.toLocaleDateString('zh-TW', {weekday: 'long'})})。
      使用者輸入："${text}"
      
      請解析出：
      1. 任務內容 (task)
      2. 下一次提醒的時間 (ISO8601格式，必須指定時區+08:00)。如果使用者說"每天9點"，這裡填入"下一個9點"的日期時間。
      3. 週期性 (recurrence)：0=單次, 1=每天, 2=每週, 3=每月。

      若沒有明確時間，請回傳 null。
      
      JSON 格式範例：
      { "task": "買牛奶", "time": "2024-12-25T09:00:00+08:00", "recurrence": 1 }
      `;

      try {
        const response = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.POLLINATIONS_API_KEY}` },
          body: JSON.stringify({
            model: "openai", // 或 nova-micro
            messages: [{ role: "user", content: prompt }]
          })
        });
        const data = await response.json();
        const content = data.choices[0].message.content;
        
        // 簡易 JSON 提取
        const jsonStr = content.match(/\{[\s\S]*\}/)?.[0];
        if (!jsonStr) return null;
        
        const result = JSON.parse(jsonStr);
        if (!result.time) return null;

        // AI 給的是帶有 +08:00 的 ISO 字串，直接 new Date() 就會轉成正確的 UTC Timestamp
        const dateObj = new Date(result.time);
        
        return {
          task: result.task,
          utcTimestamp: Math.floor(dateObj.getTime() / 1000),
          recurrence: result.recurrence || 0
        };
      } catch (e) {
        console.error("AI Error", e);
        return null;
      }
    }

    // --- 顯示用工具 ---
    function unixToTaipeiString(unix) {
      if (unix === NO_TIME_LIMIT) return "無期限";
      const date = new Date(unix * 1000);
      return date.toLocaleString('zh-TW', { 
        timeZone: 'Asia/Taipei', 
        month: 'numeric', day: 'numeric', 
        hour: '2-digit', minute: '2-digit', hour12: false 
      });
    }

    function getRecurrenceName(type) {
      switch(type) {
        case TYPE_DAILY: return "每天";
        case TYPE_WEEKLY: return "每週";
        case TYPE_MONTHLY: return "每月";
        default: return "單次";
      }
    }

    function getRecurrenceIcon(type) {
      switch(type) {
        case TYPE_DAILY: return "🔄";
        case TYPE_WEEKLY: return "📅";
        case TYPE_MONTHLY: return "🗓️";
        default: return "📍";
      }
    }

    // --- 初始化 Webhook ---
    if (request.method === "POST") {
      await bot.init();
      await bot.handleUpdate(await request.json());
      return new Response("OK");
    }
    return new Response("OK");
  },

  // === 排程觸發 (Cron Job) ===
  // 建議設定 cron = "* * * * *" (每分鐘執行)
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    await bot.init();
    
    const nowUnix = Math.floor(Date.now() / 1000);

    // 1. 找出「時間已到」且「未處理」的任務
    // 注意：這裡只看 remind_at <= now，不分早上晚上，完全依賴時間戳記
    const { results } = await env.DB.prepare(
      "SELECT * FROM todos WHERE status = 0 AND remind_at <= ? AND remind_at != ?"
    ).bind(nowUnix, NO_TIME_LIMIT).all();

    if (!results.length) return;

    for (const todo of results) {
      try {
        // 發送通知
        const timeStr = new Date(todo.remind_at * 1000).toLocaleTimeString('zh-TW', {timeZone: 'Asia/Taipei', hour:'2-digit', minute:'2-digit'});
        let msg = `⏰ 提醒：${todo.task} (${timeStr})`;
        
        // 根據類型處理後續
        if (todo.reminder_type === TYPE_ONCE) {
          // 單次任務 -> 標記完成
          msg += "\n(已標記完成)";
          await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
        } else {
          // 週期性任務 -> 計算下一次時間
          const nextRun = calculateNextRun(todo.remind_at, todo.reminder_type);
          const nextStr = new Date(nextRun * 1000).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'});
          
          msg += `\n(下一次：${nextStr})`;
          
          // 更新資料庫為下一次時間，status 保持 0
          await env.DB.prepare(
            "UPDATE todos SET remind_at = ?, last_reminded = ? WHERE id = ?"
          ).bind(nextRun, nowUnix, todo.id).run();
        }

        await bot.api.sendMessage(todo.user_id, msg);

      } catch (e) {
        console.error(`Error processing todo ${todo.id}`, e);
      }
    }
  }
};

// 計算下一次執行時間的邏輯 (純 UTC 運算)
function calculateNextRun(currentRemindAt, type) {
  // 轉回 Date 物件 (UTC)
  const date = new Date(currentRemindAt * 1000);
  
  // 為了正確處理「每月」和「每日」的跨日/跨月問題，建議轉成台灣時間操作，再轉回 UTC
  // 因為 "+1 個月" 在 1/31 會變成 2/28 或 3/x，依賴本地曆法比較保險
  // 這裡我們簡單做，先用 UTC 操作，因為間隔通常固定
  
  if (type === TYPE_DAILY) {
    // 加 24 小時
    return currentRemindAt + 24 * 60 * 60;
  } 
  else if (type === TYPE_WEEKLY) {
    // 加 7 天
    return currentRemindAt + 7 * 24 * 60 * 60;
  } 
  else if (type === TYPE_MONTHLY) {
    // 加 1 個月 (小心處理月份長度)
    // 這裡我們使用原本的 Date 物件操作
    let newDate = new Date(date);
    newDate.setMonth(newDate.getMonth() + 1);
    return Math.floor(newDate.getTime() / 1000);
  }
  
  return currentRemindAt; // Fallback
}
