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
        return await handleList(ctx, env);
      }

      const hasComplex = /每|到|號|月|年|週/.test(text);
      const local = parseTimeLocally(text);

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

    // --- 2. AI 處理 ---
    async function processWithAI(ctx, env, text) {
      const waitMsg = await ctx.reply("🤖 正在思考規則...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      const prompt = `
# Role: Task Extractor (JSON ONLY)
# Context: Now is ${now.toISOString()}
# User Input: "${text}"
# Task: Extract task, time, and recurrence rule. 
**STRICT RULE: RESPONSE MUST BE ONLY A JSON OBJECT. NO EXPLANATION. NO MARKDOWN BLOCK.**
# Field Definitions:
- "task": Clean task name.
- "time": Next ISO8601 string (with +08:00) or null.
- "rule": "none", "daily", "weekly:1,2", "monthly:5", or "yearly:MM-DD".`;

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
        const jsonMatch = data.choices[0].message.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI output format invalid");
        const json = JSON.parse(jsonMatch[0]);
        
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});

        await sendConfirmation(ctx, {
          task: json.task || "未命名任務",
          remindAt: json.time ? Math.floor(new Date(json.time).getTime() / 1000) : -1,
          cronRule: (json.rule === 'none' || !json.rule) ? null : json.rule,
          source: '🧠 AI'
        });
      } catch (e) {
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "❌ 解析失敗。");
      }
    }

    // --- 3. 確認與儲存邏輯 ---
    async function sendConfirmation(ctx, state) {
      const timeStr = state.remindAt === -1 ? "無時間限制" : new Date(state.remindAt * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'});
      const kb = new InlineKeyboard()
        .text("✅ 儲存", `sv|${state.remindAt}|${state.cronRule || 'n'}`)
        .text("❌ 取消", "cancel");

      await ctx.reply(`📌 任務：${state.task}\n⏰ 時間：${timeStr}\n🔄 規則：${state.cronRule || "單次"}\n(由 ${state.source} 解析)`, { reply_markup: kb });
    }

    // --- 4. Callback Query 處理 (包含多選刪除) ---
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id.toString();

      if (data === "cancel") return ctx.editMessageText("已取消");

      if (data.startsWith("sv|")) {
        const [_, ts, rule] = data.split("|");
        const taskName = ctx.callbackQuery.message.text.split("\n")[0].replace("📌 任務：", "");
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, status) VALUES (?, ?, ?, ?, 0)")
          .bind(userId, taskName, parseInt(ts), rule === 'n' ? null : rule).run();
        return ctx.editMessageText("✅ 任務已存入清單！");
      }

      if (data === "manage_mode") {
        return await renderManageInterface(ctx, env, "");
      }

      if (data.startsWith("tog|")) {
        const [_, targetId, selectedStr] = data.split("|");
        let selectedSet = new Set(selectedStr ? selectedStr.split(",") : []);
        if (selectedSet.has(targetId)) selectedSet.delete(targetId);
        else selectedSet.add(targetId);
        return await renderManageInterface(ctx, env, Array.from(selectedSet).join(","));
      }

      if (data.startsWith("conf_del|")) {
        const selectedIds = data.split("|")[1];
        if (!selectedIds) return ctx.answerCallbackQuery({ text: "請至少選擇一項！", show_alert: true });
        const ids = selectedIds.split(",");
        const placeholders = ids.map(() => "?").join(",");
        await env.DB.prepare(`DELETE FROM todos WHERE id IN (${placeholders}) AND user_id = ?`)
          .bind(...ids, userId).run();
        await ctx.answerCallbackQuery({ text: "刪除成功！" });
        return ctx.editMessageText("✅ 選定的任務已成功刪除。");
      }
    });

    // --- 5. 渲染管理介面 (多選按鈕) ---
    async function renderManageInterface(ctx, env, selectedIdsStr) {
      const userId = ctx.from.id.toString();
      const selectedIds = selectedIdsStr ? selectedIdsStr.split(",") : [];
      const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();

      if (!results.length) return ctx.editMessageText("📭 沒有可管理的任務。");

      const kb = new InlineKeyboard();
      results.forEach(t => {
        const isSelected = selectedIds.includes(t.id.toString());
        const icon = isSelected ? "✅" : "⬜️";
        kb.text(`${icon} ${t.task}`, `tog|${t.id}|${selectedIdsStr}`).row();
      });
      kb.text("❌ 取消", "cancel").text("🗑️ 確認刪除", `conf_del|${selectedIdsStr}`);

      await ctx.editMessageText("請點擊任務進行多選，完成後按下確認刪除：", { reply_markup: kb });
    }

    // --- 6. List 查詢功能 ---
    async function handleList(ctx, env) {
      const userId = ctx.from.id.toString();
      const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
      if (!results.length) return ctx.reply("📭 目前沒有待辦任務。");

      let msg = "📋 任務清單：\n";
      results.forEach((t, i) => {
        const timeStr = t.remind_at === -1 ? "隨時" : new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'short', day:'numeric', hour:'numeric', minute:'numeric'});
        msg += `${i+1}. [${timeStr}] ${t.task}\n`;
      });
      const kb = new InlineKeyboard().text("🗑️ 進入刪除模式", "manage_mode");
      await ctx.reply(msg, { reply_markup: kb });
    }

    if (request.method === "POST") {
      await bot.init();
      await bot.handleUpdate(await request.json());
      return new Response("OK");
    }
    return new Response("OK");
  },

  // --- 7. 定時提醒 (Cron Job) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
    const nowTs = Math.floor(Date.now() / 1000);

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
