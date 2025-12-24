import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

const TAIPEI_OFFSET = 8 * 60;

// --- 資料庫初始化 (部署時自動建立表) ---
async function initDatabase(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task TEXT NOT NULL,
        remind_at INTEGER NOT NULL,
        cron_rule TEXT,
        all_day INTEGER DEFAULT 0,
        status INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error("資料庫初始化失敗:", e.message);
  }
}

// --- AI 提示詞模板 (英文指令 + 完整輸入輸出範例) ---
function getTaskPrompt(text, now) {
  return `
# ROLE: TASK EXTRACTOR (STRICT JSON OUTPUT ONLY)
# CONTEXT: Current time is ${now.toISOString()} (Taipei Time, UTC+8)
# CRITICAL RULES (MUST FOLLOW EXACTLY):
1. OUTPUT MUST BE VALID JSON WITH NO EXTRA TEXT
2. "task" field: Extract ONLY the core task content. Remove all time/rule words like "remind me", "every", "on Jan 1st". 
3. "time" field: ISO 8601 timestamp in Taipei time (UTC+8) OR null. 
4. "rule" field: Recurrence rule options (see examples below)
5. "isAllDay": true/false. Set true for tasks without specific time.

# PROCESSING STEPS (EXECUTE IN ORDER):
1. Extract pure task content (remove all time/rule phrases)
2. Parse time to Taipei timezone ISO 8601 format
3. Determine recurrence rule based on input
4. Validate JSON structure before output

# USER INPUT:
"${text}"

# COMPLETE EXAMPLES (INPUT -> OUTPUT MAPPING):
// Example 1:
// Input: "每週一到週五晚上8點58分提醒我拿手機"
{
  "task": "拿手機",
  "time": "${new Date(now).setHours(20,58,0,0).toISOString().replace('Z', '+08:00')}",
  "rule": "weekly:1,2,3,4,5",
  "isAllDay": false
}

// Example 2:
// Input: "提醒我1月1號玩arcaea領記憶源點"
{
  "task": "玩arcaea領記憶源點",
  "time": "${new Date(now.getFullYear() + 1, 0, 1).toISOString().replace('Z', '+08:00')}",
  "rule": "yearly:01-01",
  "isAllDay": true
}

// Example 3:
// Input: "每週一到週五晚上9點提醒我拿手機"
{
  "task": "拿手機",
  "time": "${new Date(now).setHours(21,0,0,0).toISOString().replace('Z', '+08:00')}",
  "rule": "weekly:1,2,3,4,5",
  "isAllDay": false
}

// Example 4:
// Input: "明天早上8點開會"
{
  "task": "開會",
  "time": "${new Date(now).setDate(now.getDate() + 1); now.setHours(8,0,0,0); now.toISOString().replace('Z', '+08:00')}",
  "rule": "none",
  "isAllDay": false
}

// Example 5:
// Input: "每天記帳"
{
  "task": "記帳",
  "time": null,
  "rule": "daily",
  "isAllDay": true
}

# FINAL OUTPUT (JSON ONLY, NO OTHER TEXT):
`;
}

function getQueryPrompt(queryText, now) {
  return `
# ROLE: TIME RANGE EXTRACTOR (STRICT JSON OUTPUT ONLY)
# CONTEXT: Current time is ${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} (Taipei Time)
# RULES:
- "start" and "end": Unix timestamps in seconds
- "label": Concise Chinese description for user display

# USER QUERY:
"${queryText}"

# COMPLETE EXAMPLES (INPUT -> OUTPUT MAPPING):
// Example 1:
// Input: "今天"
{"start": ${Math.floor(new Date().setHours(0,0,0,0)/1000)}, "end": ${Math.floor(new Date().setHours(23,59,59,999)/1000)}, "label": "今天"}

// Example 2:
// Input: "昨天"
{"start": ${Math.floor(new Date().setDate(new Date().getDate() - 1); new Date().setHours(0,0,0,0); new Date().getTime()/1000)}, "end": ${Math.floor(new Date().setHours(23,59,59,999)/1000)}, "label": "昨天"}

// Example 3:
// Input: "本週"
{"start": ${Math.floor(new Date().setDate(new Date().getDate() - new Date().getDay() + 1); new Date().setHours(0,0,0,0); new Date().getTime()/1000)}, "end": ${Math.floor(new Date().setDate(new Date().getDate() - new Date().getDay() + 7); new Date().setHours(23,59,59,999); new Date().getTime()/1000)}, "label": "本週"}

# FINAL OUTPUT (JSON ONLY):
`;
}

// AI回應解析
async function parseAIResponse(content) {
  try {
    // 直接解析，不做任何清理
    const jsonStr = content.trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("❌ AI 回應解析失敗:", content);
    throw new Error(`無效的 AI 回應格式: ${e.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    await initDatabase(env);
    const bot = new Bot(env.BOT_TOKEN);

    // --- 1. 訊息解析與分流 ---
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;

      if (text.startsWith('/list')) return await handleQuery(ctx, env, text, "list");
      if (text.startsWith('/history')) return await handleQuery(ctx, env, text, "history");

      const hasComplex = /每|到|號|月|年|週|every|to|day|month|year|week/i.test(text);
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

    // --- 2. AI 處理：新增任務 ---
    async function processTaskWithAI(ctx, env, text) {
      const waitMsg = await ctx.reply("🤖 正在解析任務規則...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      try {
        const prompt = getTaskPrompt(text, now);
        const json = await callAI(env, prompt);
        
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(e => {
          console.warn("刪除等待訊息失敗:", e.message);
        });
        
        await sendConfirmation(ctx, {
          task: json.task || "未命名任務",
          remindAt: json.time ? Math.floor(new Date(json.time).getTime() / 1000) : -1,
          cronRule: (json.rule === 'none' || !json.rule) ? null : json.rule,
          allDay: json.isAllDay ? 1 : 0,
          source: '🧠 AI'
        });
      } catch (e) {
        console.error("AI 處理失敗:", e.message);
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, `❌ AI 解析失敗: ${e.message}`);
      }
    }

    // --- 3. AI 處理：查詢邏輯 ---
    async function handleQuery(ctx, env, text, mode) {
      const queryText = text.replace(/^\/(list|history)\s*/, "").trim();
      if (!queryText) {
          return mode === "list" ? await renderList(ctx, env, "今天") : await renderHistory(ctx, env, "最近");
      }
      
      const waitMsg = await ctx.reply("🔍 正在定位日期範圍...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      try {
        const prompt = getQueryPrompt(queryText, now);
        const range = await callAI(env, prompt);
        
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(e => {
          console.warn("刪除等待訊息失敗:", e.message);
        });
        
        if (mode === "list") await renderList(ctx, env, range.label, range.start, range.end);
        else await renderHistory(ctx, env, range.label, range.start, range.end);
      } catch (e) {
        console.error("查詢處理失敗:", e.message);
        await ctx.reply(`❌ 無法理解時間範圍，請試試「今天」或「昨天」。`);
      }
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

    // --- 5. 儲存與 Callback (SQL 注入修復) ---
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
      
      if (data === "cancel") return ctx.editMessageText("已取消。");
      
      if (data.startsWith("sv|")) {
        const [_, ts, rule, allDay] = data.split("|");
        const taskName = ctx.callbackQuery.message.text.split("\n")[0].replace("📌 任務：", "");
        try {
          await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, all_day, status) VALUES (?, ?, ?, ?, ?, 0)")
            .bind(userId, taskName, parseInt(ts), rule === 'n' ? null : rule, parseInt(allDay)).run();
          return ctx.editMessageText("✅ 儲存成功！");
        } catch (e) {
          console.error("儲存任務失敗:", e.message);
          return ctx.editMessageText("❌ 儲存失敗，請重試。");
        }
      }
      
      if (data === "manage_mode") {
        try {
          const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
          if (!results.length) return ctx.editMessageText("📭 無活躍任務。");
          const kb = new InlineKeyboard();
          results.forEach(t => kb.text(`⬜️ ${t.task}`, `tog|${t.id}|`).row());
          kb.text("❌ 取消", "cancel").text("🗑️ 永久刪除", "conf_del|");
          await ctx.editMessageText("請勾選要刪除的任務：", { reply_markup: kb });
        } catch (e) {
          console.error("管理模式失敗:", e.message);
          ctx.editMessageText("❌ 載入任務失敗。");
        }
      }
      
      if (data.startsWith("tog|")) {
        try {
          const [_, tid, sIds] = data.split("|");
          let sSet = new Set(sIds ? sIds.split(",") : []);
          sSet.has(tid) ? sSet.delete(tid) : sSet.add(tid);
          
          const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
          const kb = new InlineKeyboard();
          const newList = Array.from(sSet).join(",");
          results.forEach(t => kb.text(`${sSet.has(t.id.toString())?"✅":"⬜️"} ${t.task}`, `tog|${t.id}|${newList}`).row());
          kb.text("❌ 取消", "cancel").text("🗑️ 刪除", `conf_del|${newList}`);
          await ctx.editMessageText("請勾選要刪除的任務：", { reply_markup: kb });
        } catch (e) {
          console.error("切換任務失敗:", e.message);
          ctx.answerCallbackQuery("操作失敗，請重試。");
        }
      }
      
      if (data.startsWith("conf_del|")) {
        try {
          const idsStr = data.split("|")[1];
          if (!idsStr || !idsStr.trim()) {
            return ctx.answerCallbackQuery("請至少勾選一個任務。");
          }
          
          const ids = idsStr.split(",").filter(id => id.trim() && /^\d+$/.test(id));
          if (ids.length === 0) {
            return ctx.answerCallbackQuery("無效的任務 ID。");
          }
          
          // SQL 注入防護：驗證 ID 並使用參數化查詢
          const placeholders = ids.map(() => '?').join(',');
          await env.DB.prepare(`
            DELETE FROM todos 
            WHERE id IN (${placeholders}) 
            AND user_id = ?
          `).bind(...ids, userId).run();
          
          await ctx.editMessageText("🗑️ 任務已永久刪除。");
        } catch (e) {
          console.error("刪除任務失敗:", e.message);
          ctx.editMessageText("❌ 刪除失敗，請重試。");
        }
      }
    });

    // --- 6. AI 調用 (URL + 解析) ---
    async function callAI(env, prompt) {
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
      }),
      timeout: 10000
    });
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`AI API 錯誤 ${res.status}`);
    }

    const data = await res.json();
    const content = data.choices[0].message.content;
    const json = JSON.parse(content);
    if (typeof json.task !== 'string') { // 防禦性檢查
      json.task = JSON.stringify(json.task) || "未命名任務"; // 緊急轉換
    }
    return json;
  } catch (e) {
    console.error("AI 調用失敗:", e.message);
    throw new Error("AI 服務暫時不可用");
  }
}

  // --- 7. 修復定時工作 (無時間漂移) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
    const nowTs = Math.floor(Date.now() / 1000);

    try {
      // 1. 處理精確時間提醒
      const { results: timedTasks } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0 AND all_day = 0 AND remind_at > 0 AND remind_at <= ?").bind(nowTs).all();
      for (const todo of timedTasks) {
        try {
          await bot.api.sendMessage(todo.user_id, `🔔 提醒：${todo.task}`);
          if (!todo.cron_rule) {
            await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
          } else {
            await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
            const nextTs = calculateNextFromRule(todo.remind_at, todo.cron_rule);
            await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
          }
        } catch (e) {
          console.error(`任務 ${todo.id} 提醒失敗:`, e.message);
        }
      }

      // 2. 早晚彙整 (9:00 & 21:00)
      const hour = now.getHours();
      const minute = now.getMinutes();
      if ((hour === 9 || hour === 21) && minute < 2) {
        try {
          const { results: allActive } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0").all();
          const userGroups = allActive.reduce((acc, t) => {
            acc[t.user_id] = acc[t.user_id] || [];
            acc[t.user_id].push(t);
            return acc;
          }, {});

          for (const [uid, tasks] of Object.entries(userGroups)) {
            const todayTasks = tasks.filter(t => {
              if (t.remind_at === -1) return true;
              if (t.all_day === 1) {
                const d = new Date(t.remind_at * 1000 + TAIPEI_OFFSET * 60000);
                return d.toLocaleDateString('zh-TW') === now.toLocaleDateString('zh-TW');
              }
              if (t.cron_rule) return checkRuleMatch(now, t.cron_rule);
              return false;
            });

            if (todayTasks.length) {
              const listStr = todayTasks.map(t => `• ${t.task}${t.cron_rule ? ' (🔄)' : ''}`).join("\n");
              const timeLabel = hour === 9 ? "☀️ 早上" : "🌙 晚上";
              await bot.api.sendMessage(uid, `📝 ${timeLabel}任務彙整：\n\n${listStr}`);
              
              for (const t of todayTasks) {
                try {
                  if (!t.cron_rule && (t.all_day === 1 || t.remind_at === -1)) {
                    await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(t.id).run();
                  } else if (t.cron_rule) {
                    await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(uid, t.task, nowTs).run();
                  }
                } catch (e) {
                  console.error(`任務 ${t.id} 歸檔失敗:`, e.message);
                }
              }
            }
          }
        } catch (e) {
          console.error("每日彙整失敗:", e.message);
        }
      }
    } catch (e) {
      console.error("定時工作失敗:", e.message);
    }
  }
};

// --- 8. 修復工具函數 (無時間漂移) ---
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
  // 修復：移除 +60 避免時間漂移
  let date = new Date(lastTs * 1000); 
  
  if (rule === 'daily') {
    date.setDate(date.getDate() + 1);
  } else if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(Number);
    let found = false;
    for (let i = 0; i < 8; i++) {
      date.setDate(date.getDate() + 1);
      const dayOfWeek = date.getDay() === 0 ? 7 : date.getDay();
      if (days.includes(dayOfWeek)) {
        found = true;
        break;
      }
    }
    if (!found) date.setDate(date.getDate() + 1); // 安全 fallback
  } else if (rule.startsWith('monthly:')) {
    const dayOfMonth = parseInt(rule.split(':')[1]);
    date.setMonth(date.getMonth() + 1);
    date.setDate(dayOfMonth);
    // 處理無效日期 (如 2/30)
    if (date.getDate() !== dayOfMonth) {
      date.setMonth(date.getMonth() - 1);
      date.setDate(1);
      date.setMonth(date.getMonth() + 1, 0); // 設為上個月的最後一天
    }
  } else if (rule.startsWith('yearly:')) {
    const [m, d] = rule.split(':')[1].split('-').map(Number);
    date.setFullYear(date.getFullYear() + 1);
    date.setMonth(m - 1);
    date.setDate(d);
  }
  
  // 確保時間在台北時區的 00:00
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function parseTimeLocally(text) {
  const ref = new Date(Date.now() + TAIPEI_OFFSET * 60000);
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  let task = text.replace(r.text, "").replace(/remind me|remember|help me|提醒我|記得|幫我/gi, "").trim();
  let utcTs = Math.floor((r.date().getTime() - TAIPEI_OFFSET * 60000) / 1000);
  return { task: task || "未命名任務", utcTimestamp: utcTs };
}