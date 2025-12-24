import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

const TAIPEI_OFFSET = 8 * 60;

export default {
  async fetch(request, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);

    // --- 1. 訊息解析與分流 ---
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;

      if (text.startsWith('/list')) return await handleQuery(ctx, env, text, "list");
      if (text.startsWith('/history')) return await handleQuery(ctx, env, text, "history");

      const hasComplex = /每|到|號|月|年|週/.test(text);
      const local = parseTimeLocally(text);

      if (hasComplex || !local) return await processTaskWithAI(ctx, env, text);

      await sendConfirmation(ctx, {
        task: local.task,
        remindAt: local.utcTimestamp,
        cronRule: null,
        allDay: 0,
        source: '⚡ 本地'
      });
    });

    // --- 2. AI 處理：新增任務 (支援「本月每天」等複雜邏輯) ---
    async function processTaskWithAI(ctx, env, text) {
      const waitMsg = await ctx.reply("🤖 正在解析任務規則...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      const prompt = `
# Role: Task Extractor (JSON ONLY)
# Context: Now is ${now.toISOString()} (Taipei Time)
# Rules:
1. "rule" options: "none", "daily", "weekly:1,2", "monthly:5", "yearly:MM-DD".
2. If user says "本月每天", set rule to "daily" and task name should include month info if needed.
3. If it's a summary-style task (no specific time or all-day), set "isAllDay": true.
# Input: "${text}"`;

      try {
        const json = await callAI(env, prompt);
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});
        await sendConfirmation(ctx, {
          task: json.task || "未命名任務",
          remindAt: json.time ? Math.floor(new Date(json.time).getTime() / 1000) : -1,
          cronRule: (json.rule === 'none' || !json.rule) ? null : json.rule,
          allDay: json.isAllDay ? 1 : 0,
          source: '🧠 AI'
        });
      } catch (e) { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "❌ AI 解析失敗。"); }
    }

    // --- 3. AI 處理：查詢邏輯 ---
    async function handleQuery(ctx, env, text, mode) {
      const queryText = text.replace(/^\/(list|history)\s*/, "").trim();
      if (!queryText) {
          return mode === "list" ? await renderList(ctx, env, "今天") : await renderHistory(ctx, env, "最近");
      }
      const waitMsg = await ctx.reply("🔍 正在定位日期...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      const prompt = `{"start": number, "end": number, "label": "string"} for query: ${queryText}. Now: ${now.toISOString()}`;
      try {
        const range = await callAI(env, prompt);
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});
        if (mode === "list") await renderList(ctx, env, range.label, range.start, range.end);
        else await renderHistory(ctx, env, range.label, range.start, range.end);
      } catch (e) { await ctx.reply("❌ 無法理解時間，請試試「今天」或「昨天」。"); }
    }

    // --- 4. 渲染清單 ---
    async function renderList(ctx, env, label, startTs = null, endTs = null) {
      const userId = ctx.from.id.toString();
      const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
      const start = startTs || Math.floor(new Date().setHours(0,0,0,0)/1000);
      const end = endTs || Math.floor(new Date().setHours(23,59,59,999)/1000);
      const targetDate = new Date(start * 1000);

      const filtered = results.filter(t => {
        if (!t.cron_rule) return t.remind_at === -1 || (t.remind_at >= start && t.remind_at <= end);
        return checkRuleMatch(targetDate, t.cron_rule);
      });

      if (!filtered.length) return ctx.reply(`📭 ${label} 沒有任務。`);
      let msg = `📋 ${label} 任務清單：\n`;
      filtered.forEach((t, i) => {
        const timeStr = (t.remind_at === -1 || t.all_day) ? "全天" : new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour:'numeric', minute:'numeric'});
        msg += `${i+1}. [${timeStr}] ${t.task} ${t.cron_rule ? '(🔄)' : ''}\n`;
      });
      await ctx.reply(msg, { reply_markup: new InlineKeyboard().text("🗑️ 進入管理模式", "manage_mode") });
    }

    async function renderHistory(ctx, env, label, startTs = null, endTs = null) {
      const userId = ctx.from.id.toString();
      let sql = "SELECT * FROM todos WHERE user_id = ? AND status = 1";
      let params = [userId];
      if (startTs && endTs) { sql += " AND remind_at BETWEEN ? AND ?"; params.push(startTs, endTs); }
      const { results } = await env.DB.prepare(sql + " ORDER BY remind_at DESC LIMIT 20").bind(...params).all();
      if (!results.length) return ctx.reply(`📚 ${label} 無紀錄。`);
      let msg = `📚 ${label} 歷史：\n`;
      results.forEach((t, i) => {
        const d = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'short', day:'numeric', hour:'numeric'});
        msg += `${i+1}. [${d}] ✅ ${t.task}\n`;
      });
      await ctx.reply(msg);
    }

    // --- 5. 儲存與 Callback (包含多選刪除邏輯) ---
    async function sendConfirmation(ctx, state) {
      let timeStr = state.remindAt === -1 ? "無時間限制" : new Date(state.remindAt * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'});
      if (state.allDay) timeStr += " (全天)";
      const kb = new InlineKeyboard()
        .text("✅ 儲存", `sv|${state.remindAt}|${state.cronRule || 'n'}|${state.allDay}`)
        .text("❌ 取消", "cancel");
      await ctx.reply(`📌 任務：${state.task}\n⏰ 時間：${timeStr}\n🔄 規則：${state.cronRule || "單次"}`, { reply_markup: kb });
    }

    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id.toString();
      if (data === "cancel") return ctx.editMessageText("已取消");
      if (data.startsWith("sv|")) {
        const [_, ts, rule, allDay] = data.split("|");
        const taskName = ctx.callbackQuery.message.text.split("\n")[0].replace("📌 任務：", "");
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, all_day, status) VALUES (?, ?, ?, ?, ?, 0)")
          .bind(userId, taskName, parseInt(ts), rule === 'n' ? null : rule, parseInt(allDay)).run();
        return ctx.editMessageText("✅ 儲存成功！");
      }
      if (data === "manage_mode") {
          const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
          if (!results.length) return ctx.editMessageText("📭 無任務。");
          const kb = new InlineKeyboard();
          results.forEach(t => kb.text(`⬜️ ${t.task}`, `tog|${t.id}|`).row());
          kb.text("❌ 取消", "cancel").text("🗑️ 永久刪除", "conf_del|");
          await ctx.editMessageText("請點擊刪除任務：", { reply_markup: kb });
      }
      if (data.startsWith("tog|")) {
          const [_, tid, sIds] = data.split("|");
          let sSet = new Set(sIds ? sIds.split(",") : []);
          sSet.has(tid) ? sSet.delete(tid) : sSet.add(tid);
          const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
          const kb = new InlineKeyboard();
          const newList = Array.from(sSet).join(",");
          results.forEach(t => kb.text(`${sSet.has(t.id.toString())?"✅":"⬜️"} ${t.task}`, `tog|${t.id}|${newList}`).row());
          kb.text("❌ 取消", "cancel").text("🗑️ 永久刪除", `conf_del|${newList}`);
          await ctx.editMessageText("請點擊勾選任務：", { reply_markup: kb });
      }
      if (data.startsWith("conf_del|")) {
          const ids = data.split("|")[1].split(",");
          if (!ids[0]) return ctx.answerCallbackQuery("請至少勾選一個");
          await env.DB.prepare(`DELETE FROM todos WHERE id IN (${ids.map(()=>"?").join(",")}) AND user_id = ?`).bind(...ids, userId).run();
          return ctx.editMessageText("🗑️ 任務已永久刪除。");
      }
    });

    async function callAI(env, prompt) {
      const res = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.POLLINATIONS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: "nova-micro", messages: [{ role: "user", content: prompt }], jsonMode: true })
      });
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    }

    if (request.method === "POST") {
      await bot.init();
      await bot.handleUpdate(await request.json());
      return new Response("OK");
    }
    return new Response("OK");
  },

  // --- 6. 定時提醒與彙整邏輯 (核心：將週期任務加入早晚報) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
    const nowTs = Math.floor(Date.now() / 1000);

    // 1. 處理「精確時間」提醒
    const { results: timedTasks } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0 AND all_day = 0 AND remind_at > 0 AND remind_at <= ?").bind(nowTs).all();
    for (const todo of timedTasks) {
      await bot.api.sendMessage(todo.user_id, `🔔 提醒：${todo.task}`);
      if (!todo.cron_rule) {
        await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
      } else {
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
        const nextTs = calculateNextFromRule(todo.remind_at, todo.cron_rule);
        await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
      }
    }

    // 2. 早晚彙整 (9:00 & 21:00)
    const hour = now.getHours();
    const minute = now.getMinutes();
    if ((hour === 9 || hour === 21) && minute < 2) {
      const { results: allActive } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0").all();
      const userGroups = allActive.reduce((acc, t) => {
          acc[t.user_id] = acc[t.user_id] || [];
          acc[t.user_id].push(t);
          return acc;
      }, {});

      for (const [uid, tasks] of Object.entries(userGroups)) {
          // 過濾出：無時間任務 OR 今天符合規則的週期任務 OR 今天的所有全天任務
          const todayTasks = tasks.filter(t => {
              if (t.remind_at === -1) return true; // 無時間
              if (t.all_day === 1) { // 全天任務
                  const d = new Date(t.remind_at * 1000 + TAIPEI_OFFSET * 60000);
                  if (d.toLocaleDateString('zh-TW') === now.toLocaleDateString('zh-TW')) return true;
              }
              if (t.cron_rule) return checkRuleMatch(now, t.cron_rule); // 週期任務(每天/每週...)
              return false;
          });

          if (todayTasks.length) {
              const listStr = todayTasks.map(t => `• ${t.task}${t.cron_rule ? ' (🔄)' : ''}`).join("\n");
              const timeLabel = hour === 9 ? "☀️ 早上" : "🌙 晚上";
              await bot.api.sendMessage(uid, `📝 ${timeLabel}任務彙整：\n\n${listStr}`);
              
              // 彙整後處理：單次全天任務標記為完成
              for (const t of todayTasks) {
                  if (!t.cron_rule && (t.all_day === 1 || t.remind_at === -1)) {
                      await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(t.id).run();
                  } else if (t.cron_rule) {
                      // 週期任務留歷史副本
                      await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(uid, t.task, nowTs).run();
                  }
              }
          }
      }
    }
  }
};

// --- 工具函數 ---
function checkRuleMatch(targetDate, rule) {
  if (rule === 'daily') return true;
  if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(Number);
    const d = targetDate.getDay() === 0 ? 7 : targetDate.getDay();
    return days.includes(d);
  }
  if (rule.startsWith('monthly:')) return targetDate.getDate() === parseInt(rule.split(':')[1]);
  if (rule.startsWith('yearly:')) {
    const [m, d] = rule.split(':')[1].split('-').map(Number);
    return (targetDate.getMonth() + 1) === m && targetDate.getDate() === d;
  }
  return false;
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

function parseTimeLocally(text) {
  const ref = new Date(Date.now() + TAIPEI_OFFSET * 60000);
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  let task = text.replace(r.text, "").replace(/提醒我|記得|幫我/g, "").trim();
  let utcTs = Math.floor((r.date().getTime() - TAIPEI_OFFSET * 60000) / 1000);
  return { task: task || "未命名任務", utcTimestamp: utcTs };
}
