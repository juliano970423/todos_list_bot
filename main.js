import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

const TAIPEI_OFFSET = 8 * 60;

export default {
  async fetch(request, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);

    // --- 1. 訊息解析與分流 ---
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;

      // 如果是 List 查詢指令
      if (text.startsWith('/list')) {
        return await handleList(ctx, env, text);
      }

      const hasComplex = /每|到|號|月|年|週/.test(text);
      const local = parseTimeLocally(text);

      // 判斷是否需要 AI (如果偵測到複雜週期，或本地解析完全沒抓到時間)
      if (hasComplex || !local) {
        return await processWithAI(ctx, env, text);
      }

      await sendConfirmation(ctx, {
        task: local.task,
        remindAt: local.utcTimestamp,
        cronRule: null,
        source: '⚡ 本地'
      });
    });

    // --- 2. AI 處理 (使用 Nova-Micro) ---
    async function processWithAI(ctx, env, text) {
      const waitMsg = await ctx.reply("🤖 正在思考規則...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      const prompt = `
# Role: 任務解析專家
# Context: 
- 現在台灣時間: ${now.toISOString()}
- 使用者輸入: "${text}"

# Task:
解析使用者輸入。任務可能具備「特定時間」、「週期規則」或「完全沒時間」。

# Field Definitions:
1. "task": 任務內容。**務必去時間化**（移除如"9點"、"每天"、"提醒我"等詞）。
2. "time": 下次執行的 ISO8601 時間（含 +08:00）。
   - 若使用者「沒指定時間」（如：買雞蛋），回傳 null。
   - 若使用者有指定時間（如：今天晚上9點、1月1日），請計算出該時間點。
3. "rule": 
   - 單次任務（包括 10 分鐘後、今天 9 點、某月某日一次性）：回傳 "none"。
   - 週期任務（每、重複）：回傳 "daily"、"weekly:1,3,5"、"monthly:1" 或 "yearly:05-20"。

# Output Format (JSON ONLY):
{"task":"string", "time":"string or null", "rule":"none|daily|weekly|monthly|yearly"}
`;
    try {
        const res = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 
             'Authorization': `Bearer ${env.POLLINATIONS_API_KEY}`,
 							'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: "nova-micro", messages: [{ role: "user", content: prompt }] })
        });
        const data = await res.json();
        const json = JSON.parse(data.choices[0].message.content.match(/\{.*\}/)[0]);
        
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});

        await sendConfirmation(ctx, {
          task: json.task,
          remindAt: json.time ? Math.floor(new Date(json.time).getTime() / 1000) : -1,
          cronRule: json.rule === 'none' ? null : json.rule,
          source: '🧠 AI',
          originalText: text
        });
      } catch (e) {
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "❌ 無法辨識，請輸入具體時間或任務。");
      }
    }

    // --- 3. 確認與儲存邏輯 ---
    async function sendConfirmation(ctx, state) {
      const timeStr = state.remindAt === -1 ? "無時間限制" : new Date(state.remindAt * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'});
      const ruleDesc = state.cronRule || "單次";
      const kb = new InlineKeyboard()
        .text("✅ 儲存", `sv|${state.remindAt}|${state.cronRule || 'n'}`)
        .text("🤖 AI 重試", `retry_ai`)
        .row()
        .text("❌ 取消", "cancel");

      // 將原始文字暫存在對話中 (簡易做法，實務上建議用 KV)
      await ctx.reply(`📌 任務：${state.task}\n⏰ 時間：${timeStr}\n🔄 規則：${ruleDesc}\n(由 ${state.source} 解析)`, { reply_markup: kb });
    }

    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (data === "cancel") return ctx.editMessageText("已取消");
      if (data === "retry_ai") {
        // 這裡需要使用者重新輸入或從訊息解析，為簡化，請使用者重新傳送
        return ctx.reply("請重新傳送一次任務訊息，我會強制使用 AI 分析。");
      }
      
      if (data.startsWith("sv|")) {
        const [_, ts, rule] = data.split("|");
        const taskName = ctx.callbackQuery.message.text.split("\n")[0].replace("📌 任務：", "");
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, status) VALUES (?, ?, ?, ?, 0)")
          .bind(ctx.from.id.toString(), taskName, parseInt(ts), rule === 'n' ? null : rule).run();
        await ctx.editMessageText("✅ 任務已存入清單！");
      }
    });

    // --- 4. 進階 List 功能 ---
    async function handleList(ctx, env, text) {
      const userId = ctx.from.id.toString();
      const now = Math.floor(Date.now() / 1000);
      let sql = "SELECT * FROM todos WHERE user_id = ? AND status = 0";
      let params = [userId];

      if (text.includes("今天")) {
        const endOfDay = Math.floor(new Date().setHours(23,59,59,999) / 1000);
        sql += " AND remind_at >= ? AND remind_at <= ?";
        params.push(now, endOfDay);
      } else if (text.includes("週期")) {
        sql += " AND cron_rule IS NOT NULL";
      } else if (text.includes("無時間")) {
        sql += " AND remind_at = -1";
      }

      const { results } = await env.DB.prepare(sql).bind(...params).all();
      if (!results.length) return ctx.reply("📭 找不到符合條件的任務。");

      let msg = "📋 篩選後的清單：\n";
      results.forEach(t => {
        const timeStr = t.remind_at === -1 ? "隨時" : new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'short', day:'numeric', hour:'numeric', minute:'numeric'});
        msg += `• [${timeStr}] ${t.task} ${t.cron_rule ? '(🔄)' : ''}\n`;
      });
      await ctx.reply(msg);
    }

    // Webhook 處理
    if (request.method === "POST") {
      await bot.init();
      await bot.handleUpdate(await request.json());
      return new Response("OK");
    }
    return new Response("OK");
  },

  // --- 5. 定時提醒 (Cron Job) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
    const nowTs = Math.floor(Date.now() / 1000);

    // A. 處理「有時間」的提醒
    const { results: timedTasks } = await env.DB.prepare(
      "SELECT * FROM todos WHERE status = 0 AND remind_at > 0 AND remind_at <= ?"
    ).bind(nowTs).all();

    for (const todo of timedTasks) {
      await bot.api.sendMessage(todo.user_id, `🔔 時間到！\n任務：${todo.task}`);
      if (!todo.cron_rule) {
        await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
      } else {
        const nextTs = calculateNextFromRule(todo.remind_at, todo.cron_rule);
        await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
      }
    }

    // B. 處理「無時間」的提醒 (每天早上 9:00 與 晚上 21:00)
    const hour = now.getHours();
    const minute = now.getMinutes();
    if ((hour === 9 || hour === 21) && minute < 2) { // 2 分鐘內執行一次即可
      const { results: users } = await env.DB.prepare("SELECT DISTINCT user_id FROM todos WHERE status = 0 AND remind_at = -1").all();
      for (const u of users) {
        const { results: untimed } = await env.DB.prepare("SELECT task FROM todos WHERE user_id = ? AND status = 0 AND remind_at = -1").bind(u.user_id).all();
        if (untimed.length) {
          const list = untimed.map(t => `• ${t.task}`).join("\n");
          await bot.api.sendMessage(u.user_id, `📝 這是您的每日任務彙整：\n\n${list}`);
        }
      }
    }
  }
};

// 工具函數：本地解析
function parseTimeLocally(text) {
  const ref = new Date(Date.now() + TAIPEI_OFFSET * 60000);
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  let task = text.replace(r.text, "").replace(/提醒我|記得|幫我/g, "").trim();
  let utcTs = Math.floor((r.date().getTime() - TAIPEI_OFFSET * 60000) / 1000);
  if (!r.start.isCertain('day') && utcTs < Math.floor(Date.now()/1000)) utcTs += 86400;
  return { task: task || "未命名任務", utcTimestamp: utcTs };
}

// 工具函數：週期計算 (同前版)
function calculateNextFromRule(lastTs, rule) {
  let date = new Date((lastTs + 60) * 1000); 
  if (rule === 'daily') date.setDate(date.getDate() + 1);
  else if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(Number);
    for (let i = 0; i < 8; i++) {
      date.setDate(date.getDate() + 1);
      if (days.includes(date.getDay())) break;
    }
  } else if (rule.startsWith('monthly:')) {
    date.setMonth(date.getMonth() + 1);
    date.setDate(parseInt(rule.split(':')[1]));
  } else if (rule.startsWith('yearly:')) {
    const [m, d] = rule.split(':')[1].split('-').map(Number);
    date.setFullYear(date.getFullYear() + 1);
    date.setMonth(m - 1); date.setDate(d);
  }
  return Math.floor(date.getTime() / 1000);
}
