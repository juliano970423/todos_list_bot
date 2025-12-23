import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

const TAIPEI_OFFSET = 8 * 60;

export default {
  async fetch(request, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);

    // --- 1. 訊息解析與分流 ---
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;

      if (text.startsWith('/list')) {
        return await handleList(ctx, env, text);
      }

      const hasComplex = /每|到|號|月|年|週/.test(text);
      const local = parseTimeLocally(text);

      // 如果有複雜週期或本地完全抓不到時間，交給 AI
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
# Role: Task Extractor (JSON ONLY)
# Context: Now is ${now.toISOString()}
# User Input: "${text}"

# Task:
Extract task, time, and recurrence rule. 
**STRICT RULE: RESPONSE MUST BE ONLY A JSON OBJECT. NO EXPLANATION. NO MARKDOWN BLOCK.**

# Field Definitions:
- "task": Clean task name (remove time keywords).
- "time": Next ISO8601 string (with +08:00) or null.
- "rule": "none", "daily", "weekly:1,2", "monthly:5", or "yearly:MM-DD".

# Example Output:
{"task":"拿手機","time":"2025-12-23T21:00:00+08:00","rule":"weekly:1,2,3,4,5"}

# Final Request:
Process "${text}" and return JSON.`;

      try {
        const res = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${env.POLLINATIONS_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            model: "nova-micro", 
            messages: [{ role: "user", content: prompt }],
            jsonMode: true 
          })
        });

        const data = await res.json();
        const rawContent = data.choices[0].message.content;

        // 核心修正：跨行匹配 JSON 內容
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI output format invalid");
        
        const json = JSON.parse(jsonMatch[0]);
        
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});

        await sendConfirmation(ctx, {
          task: json.task || "未命名任務",
          // 修正：如果 json.time 為 null，應存入 -1
          remindAt: json.time ? Math.floor(new Date(json.time).getTime() / 1000) : -1,
          cronRule: (json.rule === 'none' || !json.rule) ? null : json.rule,
          source: '🧠 AI'
        });

      } catch (e) {
        console.error("Parse Error:", e);
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "❌ 無法辨識，請輸入具體時間或任務內容。");
      }
    }

    // --- 3. 確認與儲存邏輯 ---
    async function sendConfirmation(ctx, state) {
      const timeStr = state.remindAt === -1 ? "無時間限制 (早晚彙整)" : new Date(state.remindAt * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'});
      const ruleDesc = state.cronRule || "單次";
      
      const kb = new InlineKeyboard()
        .text("✅ 儲存", `sv|${state.remindAt}|${state.cronRule || 'n'}`)
        .text("❌ 取消", "cancel");

      await ctx.reply(`📌 任務：${state.task}\n⏰ 時間：${timeStr}\n🔄 規則：${ruleDesc}\n(由 ${state.source} 解析)`, { reply_markup: kb });
    }

    // --- Callback Query 處理 ---
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (data === "cancel") return ctx.editMessageText("已取消");
      
      if (data.startsWith("sv|")) {
        const [_, ts, rule] = data.split("|");
        // 從訊息擷取任務名稱
        const taskName = ctx.callbackQuery.message.text.split("\n")[0].replace("📌 任務：", "");
        
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, status) VALUES (?, ?, ?, ?, 0)")
          .bind(ctx.from.id.toString(), taskName, parseInt(ts), rule === 'n' ? null : rule)
          .run();
          
        await ctx.editMessageText("✅ 任務已存入清單！");
      }
    });

    // --- 4. List 查詢功能 ---
    async function handleList(ctx, env, text) {
      const userId = ctx.from.id.toString();
      let sql = "SELECT * FROM todos WHERE user_id = ? AND status = 0";
      let params = [userId];

      if (text.includes("今天")) {
        const now = Math.floor(Date.now() / 1000);
        const endOfDay = Math.floor(new Date().setHours(23,59,59,999) / 1000);
        sql += " AND remind_at >= ? AND remind_at <= ?";
        params.push(now, endOfDay);
      } else if (text.includes("週期")) {
        sql += " AND cron_rule IS NOT NULL";
      } else if (text.includes("無時間")) {
        sql += " AND remind_at = -1";
      }

      const { results } = await env.DB.prepare(sql).bind(...params).all();
      if (!results.length) return ctx.reply("📭 目前沒有符合條件的待辦任務。");

      let msg = "📋 任務清單：\n";
      results.forEach(t => {
        const timeStr = t.remind_at === -1 ? "隨時" : new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'short', day:'numeric', hour:'numeric', minute:'numeric'});
        msg += `• [${timeStr}] ${t.task} ${t.cron_rule ? '(🔄)' : ''}\n`;
      });
      await ctx.reply(msg);
    }

    // Webhook 入口
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

    // A. 處理有時間的提醒
    const { results: timedTasks } = await env.DB.prepare(
      "SELECT * FROM todos WHERE status = 0 AND remind_at > 0 AND remind_at <= ?"
    ).bind(nowTs).all();

    for (const todo of timedTasks) {
      await bot.api.sendMessage(todo.user_id, `🔔 提醒：${todo.task}`);
      if (!todo.cron_rule) {
        await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
      } else {
        const nextTs = calculateNextFromRule(todo.remind_at, todo.cron_rule);
        await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
      }
    }

    // B. 早晚彙整 (9:00, 21:00)
    const hour = now.getHours();
    const minute = now.getMinutes();
    if ((hour === 9 || hour === 21) && minute < 2) {
      const { results: users } = await env.DB.prepare("SELECT DISTINCT user_id FROM todos WHERE status = 0 AND remind_at = -1").all();
      for (const u of users) {
        const { results: items } = await env.DB.prepare("SELECT task FROM todos WHERE user_id = ? AND status = 0 AND remind_at = -1").bind(u.user_id).all();
        if (items.length) {
          const list = items.map(i => `• ${i.task}`).join("\n");
          await bot.api.sendMessage(u.user_id, `📝 每日任務匯整：\n\n${list}`);
        }
      }
    }
  }
};

// --- 工具函數 ---
function parseTimeLocally(text) {
  const ref = new Date(Date.now() + TAIPEI_OFFSET * 60000);
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  let task = text.replace(r.text, "").replace(/提醒我|記得|幫我/g, "").trim();
  let utcTs = Math.floor((r.date().getTime() - TAIPEI_OFFSET * 60000) / 1000);
  return { task: task || "未命名任務", utcTimestamp: utcTs };
}

function calculateNextFromRule(lastTs, rule) {
  let date = new Date((lastTs + 60) * 1000); 
  if (rule === 'daily') date.setDate(date.getDate() + 1);
  else if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(Number);
    for (let i = 0; i < 8; i++) {
      date.setDate(date.getDate() + 1);
      if (days.includes(date.getDay() === 0 ? 7 : date.getDay())) break;
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
