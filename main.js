import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

// 台北時間偏移量 (分鐘)
const TAIPEI_OFFSET = 8 * 60;

// --- 資料庫初始化 ---
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

// --- 輔助：取得人類可讀的台北時間 (給 AI 當參考) ---
function getTaipeiTimeString(dateObj) {
  return dateObj.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

// --- AI 提示詞模板 (針對您的需求優化) ---
function getTaskPrompt(text, now) {
  const nowStr = getTaipeiTimeString(now);
  
  return `
# SYSTEM ROLE: Task Scheduler & Extractor
# CURRENT TIME (Taipei, UTC+8): ${nowStr}

# OBJECTIVE:
Analyze the USER INPUT and extract structured data (JSON).

# CRITICAL RULES (Follow Strictly):
1. **task**: Extract the core activity. Remove time keywords (e.g., "remind me", "tomorrow", "at 9pm").
2. **time**: 
   - Output ISO 8601 format with timezone: "YYYY-MM-DDTHH:mm:ss+08:00".
   - If the user implies a time (e.g. "tonight", "Jan 1st"), CALCULATE the exact date based on CURRENT TIME.
   - If "Jan 1st" is in the past relative to now, assume NEXT YEAR.
   - If no time specified, use null.
3. **rule** (Recurrence): 
   - **DEFAULT: null** (This is a one-time task).
   - ONLY use "daily", "weekly:1", etc., if user EXPLICITLY says "Every day", "Daily", "Each week".
   - "Tonight at 9pm" -> rule: null (It is NOT daily).
4. **isAllDay**: true if no specific hour:minute is mentioned (e.g., "Buy milk tomorrow").

# USER INPUT:
"${text}"

# OUTPUT FORMAT (JSON Only):
{
  "task": "Clean text without time",
  "time": "ISO-8601-String" or null,
  "rule": "daily" or "weekly:X" or null,
  "isAllDay": true/false
}
`;
}

function getQueryPrompt(queryText, now) {
  const nowStr = getTaipeiTimeString(now);
  return `
# ROLE: Time Range Calculator
# CURRENT TIME: ${nowStr}
# INPUT: "${queryText}"
# OUTPUT JSON: {"start": UNIX_TIMESTAMP, "end": UNIX_TIMESTAMP, "label": "Display Name"}
`;
}

export default {
  async fetch(request, env, ctx) {
    await initDatabase(env);
    const bot = new Bot(env.BOT_TOKEN);

    // --- 1. 訊息接收與分流 ---
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;

      // 指令分流
      if (text.startsWith('/list')) return await handleQuery(ctx, env, text, "list");
      if (text.startsWith('/history')) return await handleQuery(ctx, env, text, "history");

      // 判斷是否需要 AI (包含複雜關鍵字)
      // 增加關鍵字覆蓋率，確保 "提醒我..." 這種句子會進 AI
      const forceAI = /每|到|週|月|年|every|daily|week|month|year|remind|提醒|記得|幫我/i.test(text);
      
      // 嘗試本地解析 (Chrono) 作為備案或簡單句處理
      const local = parseTimeLocally(text);

      // 如果有複雜關鍵字，或是本地解析不出具體時間(或者解析失敗)，就丟給 AI
      if (forceAI || !local) {
        return await processTaskWithAI(ctx, env, text);
      }

      // 本地解析成功且是簡單語句
      await sendConfirmation(ctx, {
        task: local.task,
        remindAt: local.utcTimestamp,
        cronRule: null,
        allDay: 0,
        source: '⚡ 本地快速解析'
      });
    });

    // --- 2. AI 處理核心 (包含詳細錯誤回報) ---
    async function processTaskWithAI(ctx, env, text) {
      const waitMsg = await ctx.reply("🤖 正在思考與解析...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      try {
        const prompt = getTaskPrompt(text, now);
        
        // 呼叫 AI，並獲取原始回傳字串
        const { json, rawContent } = await callAI(env, prompt);
        
        // 驗證並處理 AI 回傳的數據
        let remindTs = -1;
        
        // 處理時間
        if (json.time) {
          // 嘗試解析 ISO 時間
          let dateObj = new Date(json.time);
          
          // 如果 AI 忘記給時區 (防呆)，強制加上 +08:00
          if (json.time.indexOf('+') === -1 && json.time.indexOf('Z') === -1) {
             dateObj = new Date(json.time + "+08:00");
          }

          if (isNaN(dateObj.getTime())) {
             // 時間解析失敗，拋出錯誤供使用者排查
             throw new Error(`時間格式無效 (Invalid Date): ${json.time}`);
          }
          
          remindTs = Math.floor(dateObj.getTime() / 1000);
        }

        // 處理任務名稱 (如果 AI 把任務名稱吃掉了，用原文補救)
        let finalTask = json.task;
        if (!finalTask || finalTask === "未命名任務" || finalTask.trim() === "") {
            // 嘗試移除常見的觸發詞，保留剩餘部分
            finalTask = text.replace(/提醒我|記得|每週|每天/g, "").trim();
        }

        // 處理規則 (過濾 none/null 字串)
        let finalRule = json.rule;
        if (finalRule === 'none' || finalRule === 'null') finalRule = null;

        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
        
        // 發送確認訊息，並附帶 "除錯資訊" (因為您要求更多資訊)
        await sendConfirmation(ctx, {
          task: finalTask,
          remindAt: remindTs,
          cronRule: finalRule,
          allDay: json.isAllDay ? 1 : 0,
          source: '🧠 AI',
          debugRaw: JSON.stringify(json) // 傳送原始 JSON 給確認函式顯示
        });

      } catch (e) {
        console.error("AI 處理錯誤:", e);
        // 發生錯誤時，回傳完整的錯誤訊息與原始資料供排查
        const errorMsg = `⚠️ <b>解析發生錯誤</b>\n\n` +
                         `❌ <b>錯誤原因：</b> ${e.message}\n` +
                         `📄 <b>原始回應：</b>\n<pre>${e.rawContent || "無內容"}</pre>`;
                         
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, errorMsg, { parse_mode: "HTML" });
      }
    }

    // --- 3. 查詢處理 (List/History) ---
    async function handleQuery(ctx, env, text, mode) {
      const queryText = text.replace(/^\/(list|history)\s*/, "").trim();
      if (!queryText) {
          return mode === "list" ? await renderList(ctx, env, "今天") : await renderHistory(ctx, env, "最近");
      }
      
      const waitMsg = await ctx.reply("🔍 查詢範圍中...");
      const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      
      try {
        const prompt = getQueryPrompt(queryText, now);
        const { json } = await callAI(env, prompt);
        
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
        
        if (mode === "list") await renderList(ctx, env, json.label, json.start, json.end);
        else await renderHistory(ctx, env, json.label, json.start, json.end);
      } catch (e) {
        await ctx.reply(`❌ 查詢範圍解析失敗：${e.message}\n原始回應：${e.rawContent || "null"}`);
      }
    }

    // --- 4. 渲染清單 (List) ---
    async function renderList(ctx, env, label, startTs = null, endTs = null) {
      const userId = ctx.from.id.toString();
      const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
      
      const start = startTs || Math.floor(new Date().setHours(0,0,0,0)/1000);
      const end = endTs || Math.floor(new Date().setHours(23,59,59,999)/1000);

      const filtered = results.filter(t => {
        if (t.cron_rule) return true; // 週期性任務總是顯示
        return t.remind_at === -1 || (t.remind_at >= start && t.remind_at <= end);
      });

      if (!filtered.length) return ctx.reply(`📭 ${label} 沒有待辦事項。`);
      
      let msg = `📋 <b>${label} 任務清單：</b>\n`;
      filtered.forEach((t, i) => {
        let timeDisplay = "";
        
        if (t.cron_rule) {
          timeDisplay = `🔄 ${translateRule(t.cron_rule)}`;
          if (t.remind_at > 0) {
            timeDisplay += " " + new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit', hour12:false});
          }
        } else if (t.all_day) {
          timeDisplay = "☀️ 全天";
        } else if (t.remind_at !== -1) {
          timeDisplay = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
        } else {
          timeDisplay = "無期限";
        }

        msg += `${i+1}. [${timeDisplay}] ${t.task}\n`;
      });
      await ctx.reply(msg, { 
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🗑️ 管理模式", "manage_mode") 
      });
    }

    // --- 5. 渲染歷史 (History) ---
    async function renderHistory(ctx, env, label, startTs = null, endTs = null) {
      const userId = ctx.from.id.toString();
      let sql = "SELECT * FROM todos WHERE user_id = ? AND status = 1";
      let params = [userId];
      if (startTs && endTs) { sql += " AND remind_at BETWEEN ? AND ?"; params.push(startTs, endTs); }
      
      const { results } = await env.DB.prepare(sql + " ORDER BY remind_at DESC LIMIT 15").bind(...params).all();
      
      if (!results.length) return ctx.reply(`📚 ${label} 無完成紀錄。`);
      let msg = `📚 <b>${label} 完成紀錄：</b>\n`;
      results.forEach((t, i) => {
        const d = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
        msg += `${i+1}. [${d}] ✅ ${t.task}\n`;
      });
      await ctx.reply(msg, { parse_mode: "HTML" });
    }

    // --- 6. 確認與儲存 (UI) ---
    async function sendConfirmation(ctx, state) {
      let timeStr = state.remindAt === -1 ? "無時間限制" : new Date(state.remindAt * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false});
      if (state.allDay) timeStr += " (全天)";
      
      const ruleText = state.cronRule ? translateRule(state.cronRule) : "單次";
      
      const kb = new InlineKeyboard()
        .text("✅ 確認儲存", `sv|${state.remindAt}|${state.cronRule || 'n'}|${state.allDay}`)
        .text("❌ 取消", "cancel");
      
      let msg = `📌 <b>任務確認</b>\n` +
                `📝 內容：${state.task}\n` +
                `⏰ 時間：${timeStr}\n` +
                `🔄 規則：${ruleText}\n` +
                `🔍 來源：${state.source}`;
      
      // 如果有 debugRaw，顯示在訊息下方 (使用單行代碼格式，避免過長)
      if (state.debugRaw) {
          msg += `\n\n🛠 <b>AI 原始數據：</b>\n<code>${state.debugRaw}</code>`;
      }

      await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
    }

    function translateRule(rule) {
        if (!rule || rule === 'none') return "單次";
        if (rule === 'daily') return "每天";
        if (rule.startsWith('weekly:')) return "每週";
        if (rule.startsWith('monthly:')) return "每月";
        if (rule.startsWith('yearly:')) return "每年";
        return rule;
    }

    // --- 7. Callback 互動處理 ---
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id.toString();
      
      if (data === "cancel") return ctx.editMessageText("已取消操作。");
      
      // 儲存邏輯
      if (data.startsWith("sv|")) {
        const [_, ts, rule, allDay] = data.split("|");
        // 從原始訊息中提取任務名稱 (使用 Regex 抓取 "📝 內容：" 後面的字)
        const match = ctx.callbackQuery.message.text.match(/內容：(.+)/);
        const taskName = match ? match[1].trim() : "未命名任務";
        
        try {
          await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, all_day, status) VALUES (?, ?, ?, ?, ?, 0)")
            .bind(userId, taskName, parseInt(ts), rule === 'n' ? null : rule, parseInt(allDay)).run();
          return ctx.editMessageText(`✅ 已儲存任務：<b>${taskName}</b>`, { parse_mode: "HTML" });
        } catch (e) {
          return ctx.editMessageText(`❌ 資料庫錯誤：${e.message}`);
        }
      }

      // 管理模式
      if (data === "manage_mode") {
        const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
        if (!results.length) return ctx.editMessageText("📭 目前無待辦事項。");
        
        const kb = new InlineKeyboard();
        results.forEach(t => kb.text(`⬜️ ${t.task}`, `tog|${t.id}|`).row());
        kb.text("❌ 關閉", "cancel").text("🗑️ 刪除選取項目", "conf_del|");
        
        await ctx.editMessageText("請勾選要刪除的任務：", { reply_markup: kb });
      }

      // 勾選邏輯 (Toggle)
      if (data.startsWith("tog|")) {
          const [_, tid, sIds] = data.split("|");
          let sSet = new Set(sIds ? sIds.split(",") : []);
          sSet.has(tid) ? sSet.delete(tid) : sSet.add(tid);
          
          const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = 0").bind(userId).all();
          const kb = new InlineKeyboard();
          const newList = Array.from(sSet).join(",");
          results.forEach(t => kb.text(`${sSet.has(t.id.toString())?"✅":"⬜️"} ${t.task}`, `tog|${t.id}|${newList}`).row());
          kb.text("❌ 關閉", "cancel").text(`🗑️ 確認刪除 (${sSet.size})`, `conf_del|${newList}`);
          
          await ctx.editMessageText("請勾選要刪除的任務：", { reply_markup: kb });
      }

      // 確認刪除
      if (data.startsWith("conf_del|")) {
          const idsStr = data.split("|")[1];
          if (!idsStr) return ctx.answerCallbackQuery("未選擇任何任務");
          const ids = idsStr.split(",").filter(x => x);
          if (!ids.length) return ctx.answerCallbackQuery("未選擇任何任務");

          const placeholders = ids.map(()=>'?').join(',');
          await env.DB.prepare(`DELETE FROM todos WHERE id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
          await ctx.editMessageText(`🗑️ 已刪除 ${ids.length} 個任務。`);
      }
    });

    // --- 8. AI API 調用 (強化版：回傳 raw content) ---
    async function callAI(env, prompt) {
      let rawContent = "";
      try {
        const res = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${env.POLLINATIONS_API_KEY}`,
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ 
            model: "nova-micro", // 或 "gpt-4o-mini"
            messages: [{ role: "user", content: prompt }], 
            jsonMode: true 
          }),
          timeout: 15000
        });
        
        if (!res.ok) {
           const errText = await res.text();
           throw new Error(`API Status ${res.status}: ${errText}`);
        }

        const data = await res.json();
        rawContent = data.choices[0].message.content; // 保存原始回應
        
        // 嘗試清理 Markdown
        const cleanContent = rawContent.replace(/```json|```/g, "").trim();
        const json = JSON.parse(cleanContent);
        
        return { json, rawContent }; // 回傳物件和原始字串
      } catch (e) {
        // 將原始回應附加在 error 物件上，方便外層 catch 使用
        e.rawContent = rawContent; 
        throw e;
      }
    }

  // --- 9. 定時任務 (Cron Trigger) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    const nowTs = Math.floor(Date.now() / 1000);
    const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);

    try {
      // 1. 檢查提醒 (精確時間)
      const { results } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0 AND all_day = 0 AND remind_at > 0 AND remind_at <= ?").bind(nowTs).all();
      
      for (const todo of results) {
        await bot.api.sendMessage(todo.user_id, `🔔 <b>提醒時間到！</b>\n👉 ${todo.task}`, { parse_mode: "HTML" });
        
        if (!todo.cron_rule) {
          // 單次任務 -> 標記完成
          await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
        } else {
          // 循環任務 -> 記錄歷史 + 更新下次時間
          await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
          const nextTs = calculateNext(todo.remind_at, todo.cron_rule);
          await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
        }
      }

      // 2. 每日彙整 (早晚 9 點)
      const h = now.getUTCHours();
      const m = now.getUTCMinutes();
      if ((h === 9 || h === 21) && m < 5) {
         // (簡化版：實際部署可加入彙整通知邏輯)
         // console.log("執行每日彙整檢查...");
      }
    } catch (e) {
      console.error("Cron Error:", e);
    }
  }
};

// --- 10. 工具函數 ---
function calculateNext(lastTs, rule) {
  // 基於上次設定的時間計算下次時間 (避免時間漂移)
  let d = new Date(lastTs * 1000);
  
  if (rule === 'daily') d.setDate(d.getDate() + 1);
  else if (rule.startsWith('weekly:')) d.setDate(d.getDate() + 7);
  else if (rule.startsWith('monthly:')) d.setMonth(d.getMonth() + 1);
  else if (rule.startsWith('yearly:')) d.setFullYear(d.getFullYear() + 1);
  
  return Math.floor(d.getTime() / 1000);
}

function parseTimeLocally(text) {
  const refDate = new Date(Date.now() + TAIPEI_OFFSET * 60000);
  const results = chrono.parse(text, refDate, { forwardDate: true });
  if (!results.length) return null;
  
  const r = results[0];
  // 移除時間文字和常見廢話
  let task = text.replace(r.text, "").replace(/提醒我|記得|幫我|remind me/gi, "").trim();
  if (!task) task = "未命名任務";
  
  const date = r.date();
  // 修正 Chrono 時區偏移 (假設解析結果為本地時間)
  const utcTs = Math.floor((date.getTime() - TAIPEI_OFFSET * 60000) / 1000);
  
  return { task, utcTimestamp: utcTs };
}
