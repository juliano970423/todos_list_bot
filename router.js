// router.js - 路由處理模組
import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";
import { getTaskPrompt, getQueryPrompt, callAI, parseTimeLocally } from "./ai.js";
import { sendConfirmation, renderList, renderHistory } from "./task.js";
import { addTodo, getTodos, deleteTodosByIds } from "./db.js";
import { TAIPEI_OFFSET } from "./time.js";

// 處理訊息的路由
async function handleMessage(ctx, env) {
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
}

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

    // 處理時間 - 由 JavaScript 解析 AI 提取的時間字符串
    if (json.time) {
      const refDate = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      let date;

      // 檢查時間字符串是否包含 ISO 格式日期時間 (YYYY-MM-DDTHH:mm)
      if (json.time.includes('T')) {
        // 如果是 ISO 格式，直接解析
        date = new Date(json.time);
      }
      // 檢查時間字符串是否包含日期格式 (MM-DD)
      else if (json.time.includes('-') && !json.time.includes('T')) {
        // 如果時間字符串是 "MM-DD" 格式，需要構建完整的日期
        const [month, day] = json.time.split('-');
        // 使用 Date 構造函數構建日期，避免字符串解析問題
        const monthNum = parseInt(month);
        const dayNum = parseInt(day);
        date = new Date(refDate.getFullYear(), monthNum - 1, dayNum);

        // 如果日期已過，則設為明年
        if (date.getTime() <= refDate.getTime()) {
          date = new Date(refDate.getFullYear() + 1, monthNum - 1, dayNum);
        }
      } else {
        // 新增：解析 AI 返回的模糊時間格式（支援中英文）
        // 處理 "today 20:52", "tomorrow", "in 2 days", "today 20:52" 等英文格式
        let parsedDate = null;

        // 處理 "today HH:MM" 格式
        if (json.time.includes('today')) {
          const timeMatch = json.time.match(/today\s*(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const [, hour, minute] = timeMatch;
            parsedDate = new Date(refDate);
            parsedDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
          } else {
            parsedDate = new Date(refDate);
            parsedDate.setHours(0, 0, 0, 0);
          }
        }
        // 處理 "tomorrow HH:MM" 格式
        else if (json.time.includes('tomorrow')) {
          const timeMatch = json.time.match(/tomorrow\s*(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const [, hour, minute] = timeMatch;
            parsedDate = new Date(refDate);
            parsedDate.setDate(parsedDate.getDate() + 1);
            parsedDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
          } else {
            parsedDate = new Date(refDate);
            parsedDate.setDate(parsedDate.getDate() + 1);
            parsedDate.setHours(0, 0, 0, 0);
          }
        }
        // 處理 "in N days HH:MM" 格式
        else if (json.time.includes('in ') && json.time.includes(' days')) {
          const dayMatch = json.time.match(/in (\d+) days/);
          const timeMatch = json.time.match(/(\d{1,2}):(\d{2})/);
          if (dayMatch) {
            const days = parseInt(dayMatch[1]);
            parsedDate = new Date(refDate);
            parsedDate.setDate(parsedDate.getDate() + days);
            if (timeMatch) {
              const [, hour, minute] = timeMatch;
              parsedDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
            } else {
              parsedDate.setHours(0, 0, 0, 0);
            }
          }
        }
        // 處理 "今天 HH:MM" 格式（保留對中文的支持）
        else if (json.time.includes('今天')) {
          const timeMatch = json.time.match(/今天\s*(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const [, hour, minute] = timeMatch;
            parsedDate = new Date(refDate);
            parsedDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
          } else {
            parsedDate = new Date(refDate);
            parsedDate.setHours(0, 0, 0, 0);
          }
        }
        // 處理 "明天 HH:MM" 格式（保留對中文的支持）
        else if (json.time.includes('明天')) {
          const timeMatch = json.time.match(/明天\s*(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const [, hour, minute] = timeMatch;
            parsedDate = new Date(refDate);
            parsedDate.setDate(parsedDate.getDate() + 1);
            parsedDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
          } else {
            parsedDate = new Date(refDate);
            parsedDate.setDate(parsedDate.getDate() + 1);
            parsedDate.setHours(0, 0, 0, 0);
          }
        }
        // 處理 "N天後 HH:MM" 格式（保留對中文的支持）
        else if (json.time.includes('天後')) {
          const dayMatch = json.time.match(/(\d+)天後/);
          const timeMatch = json.time.match(/(\d{1,2}):(\d{2})/);
          if (dayMatch) {
            const days = parseInt(dayMatch[1]);
            parsedDate = new Date(refDate);
            parsedDate.setDate(parsedDate.getDate() + days);
            if (timeMatch) {
              const [, hour, minute] = timeMatch;
              parsedDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
            } else {
              parsedDate.setHours(0, 0, 0, 0);
            }
          }
        }
        // 處理純時間格式如 "20:58", "21:00" 等
        else if (/^\d{1,2}:\d{2}$/.test(json.time.trim())) {
          const [hour, minute] = json.time.trim().split(':').map(Number);
          parsedDate = new Date(refDate);
          parsedDate.setHours(hour, minute, 0, 0);

          // 如果時間已過，則設為明天
          if (parsedDate.getTime() < refDate.getTime()) {
            parsedDate.setDate(parsedDate.getDate() + 1);
          }
        }
        // 如果以上格式都不匹配，使用 chrono 解析（現在會更好地處理英文）
        else {
          const results = chrono.parse(json.time, refDate, { forwardDate: true });

          if (results.length > 0) {
            parsedDate = results[0].date();
          } else {
            // 如果 chrono 無法解析，嘗試直接解析
            parsedDate = new Date(json.time);
          }
        }

        if (parsedDate && !isNaN(parsedDate.getTime())) {
          date = parsedDate;
        } else {
          throw new Error(`時間格式無效 (Invalid Date): ${json.time}`);
        }
      }

      // 如果是週期性任務，確保時間是未來的
      if (json.rule && (json.rule.startsWith('daily') || json.rule.startsWith('weekly:') || json.rule.startsWith('monthly:') || json.rule.startsWith('yearly:'))) {
        if (date.getTime() <= refDate.getTime()) {
          // 如果日期已過，根據規則類型計算下一個日期
          if (json.rule.startsWith('yearly:')) {
            date.setFullYear(date.getFullYear() + 1);
          } else if (json.rule.startsWith('monthly:')) {
            date.setMonth(date.getMonth() + 1);
          } else if (json.rule.startsWith('weekly:')) {
            date.setDate(date.getDate() + 7);
          } else if (json.rule === 'daily') {
            date.setDate(date.getDate() + 1);
          }
        }
      }

      // 修正時區偏移
      remindTs = Math.floor((date.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    } else if (json.rule) {
      // 如果沒有提供時間但有規則（週期性任務），計算下一個執行時間
      const refDate = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      let date = new Date(refDate); // 從當前時間開始計算

      if (json.rule.startsWith('daily')) {
        // 每日任務，設為明天
        date.setDate(date.getDate() + 1);
      } else if (json.rule.startsWith('weekly:')) {
        // 週期性週任務，計算下一個符合規則的日期
        const days = json.rule.split(':')[1].split(',').map(Number);
        const currentDayOfWeekISO = date.getDay() === 0 ? 7 : date.getDay(); // Convert to ISO (1 for Mon, ..., 7 for Sun)

        let nextDayOffset = 1;
        let found = false;

        while (nextDayOffset <= 7 && !found) {
          let potentialDay = (currentDayOfWeekISO + nextDayOffset) % 7;
          if (potentialDay === 0) potentialDay = 7; // Sunday should be 7, not 0
          if (days.includes(potentialDay)) {
            found = true;
            date.setDate(date.getDate() + nextDayOffset);
          } else {
            nextDayOffset++;
          }
        }
      } else if (json.rule.startsWith('monthly:')) {
        // 月度任務，計算下一個符合規則的日期
        const dayOfMonth = parseInt(json.rule.split(':')[1]);
        const currentDay = refDate.getDate();

        if (currentDay < dayOfMonth) {
          // 如果當月的指定日期還沒到，就設為本月的該日期
          date.setDate(dayOfMonth);
        } else {
          // 如果當月的指定日期已過，就設為下個月的該日期
          date.setMonth(date.getMonth() + 1);
          date.setDate(dayOfMonth);
        }
      } else if (json.rule.startsWith('yearly:')) {
        // 年度任務，計算下一個符合規則的日期
        const monthDay = json.rule.split(':')[1]; // 格式為 MM-DD
        const [month, day] = monthDay.split('-').map(Number);
        const currentMonth = refDate.getMonth();
        const currentDay = refDate.getDate();

        date.setMonth(month - 1); // 月份從0開始
        date.setDate(day);

        // 如果今年的日期已過，則設為明年
        if (date.getTime() <= refDate.getTime()) {
          date.setFullYear(date.getFullYear() + 1);
        }
      }

      // 修正時區偏移
      remindTs = Math.floor((date.getTime() - TAIPEI_OFFSET * 60000) / 1000);
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

    // 如果是 yearly 規則，需要特殊處理時間
    if (finalRule && finalRule.startsWith('yearly:')) {
      // 對於 yearly 任務，需要計算下一個相符的日期
      const refDate = new Date(Date.now() + TAIPEI_OFFSET * 60000);
      const results = chrono.parse(json.time, refDate, { forwardDate: true });

      if (results.length > 0) {
        let date = results[0].date();
        // 確保日期是未來的
        if (date.getTime() <= refDate.getTime()) {
          // 如果日期已過，設為明年
          date.setFullYear(date.getFullYear() + 1);
        }
        remindTs = Math.floor((date.getTime() - TAIPEI_OFFSET * 60000) / 1000);
      }
    }

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
      if (mode === "list") {
          // 無參數時顯示最近一週的任務
          const now = new Date();
          const startOfWeek = new Date(now);
          startOfWeek.setDate(now.getDate() - 7); // 最近7天
          const startTs = Math.floor(startOfWeek.setHours(0,0,0,0)/1000);
          const endTs = Math.floor(new Date().setHours(23,59,59,999)/1000);
          return await renderList(ctx, env, "近期", startTs, endTs, null);
      } else {
          return await renderHistory(ctx, env, "最近");
      }
  }

  const waitMsg = await ctx.reply("🔍 查詢範圍中...");
  const now = new Date(Date.now() + TAIPEI_OFFSET * 60000);

  try {
    const prompt = getQueryPrompt(queryText, now);
    const { json } = await callAI(env, prompt);

    await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});

    if (mode === "list") await renderList(ctx, env, json.label, json.start, json.end, json);
    else await renderHistory(ctx, env, json.label, json.start, json.end);
  } catch (e) {
    // 如果是 JSON 解析錯誤，嘗試從原始回應中提取 JSON 部分
    if (e.message.includes("JSON") && e.rawContent) {
      try {
        // 尋找 JSON 部分
        const jsonMatch = e.rawContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const jsonStr = jsonMatch[0];
          const json = JSON.parse(jsonStr);

          if (mode === "list") await renderList(ctx, env, json.label, json.start, json.end);
          else await renderHistory(ctx, env, json.label, json.start, json.end);
          return;
        }
      } catch (parseErr) {
        // 如果仍然解析失敗，顯示錯誤
      }
    }

    await ctx.reply(`❌ 查詢範圍解析失敗：${e.message}\n原始回應：${e.rawContent || "null"}`);
  }
}

// 處理回調查詢的路由
async function handleCallbackQuery(ctx, env) {
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
      await addTodo(env, userId, taskName, ts, rule, allDay);
      return ctx.editMessageText(`✅ 已儲存任務：<b>${taskName}</b>`, { parse_mode: "HTML" });
    } catch (e) {
      return ctx.editMessageText(`❌ 資料庫錯誤：${e.message}`);
    }
  }

  // 管理模式
  if (data === "manage_mode") {
    const results = await getTodos(env, userId, 0);
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

      const results = await getTodos(env, userId, 0);
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

      await deleteTodosByIds(env, ids, userId);
      await ctx.editMessageText(`🗑️ 已刪除 ${ids.length} 個任務。`);
  }
}

export {
  handleMessage,
  handleCallbackQuery
};