// router.js - 路由處理模組
import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";
import { getTaskPrompt, getQueryPrompt, callAI, parseTimeLocally, parseQueryLocally } from "./ai.js";
import { sendConfirmation, renderList, renderHistory, renderRecurringTasks } from "./task.js";
import { addTodo, getTodos, deleteTodosByIds } from "./db.js";
import { TAIPEI_OFFSET, getTodayAndFutureRangeTaipei, getNowTaipei, localDateToUtcTs } from "./time.js";

// ============================================
// 時間解析輔助函數
// ============================================

/**
 * 解析 AI 返回的時間字符串，返回 Date 對象
 * @param {string} timeStr - AI 返回的時間字符串
 * @param {Date} refDate - 參考日期（當前時間）
 * @returns {Date|null} 解析後的日期，解析失敗返回 null
 */
function parseAITimeExpression(timeStr, refDate) {
  if (!timeStr) return null;

  // 檢查 ISO 格式 (YYYY-MM-DDTHH:mm)
  if (timeStr.includes('T')) {
    return new Date(timeStr);
  }

  // 檢查 MM-DD 格式
  if (timeStr.includes('-') && !timeStr.includes('T')) {
    const [month, day] = timeStr.split('-');
    const monthNum = parseInt(month);
    const dayNum = parseInt(day);
    let date = new Date(refDate.getFullYear(), monthNum - 1, dayNum);

    if (date.getTime() <= refDate.getTime()) {
      date = new Date(refDate.getFullYear() + 1, monthNum - 1, dayNum);
    }
    return date;
  }

  let parsedDate = null;

  // today HH:MM
  if (timeStr.includes('today')) {
    const timeMatch = timeStr.match(/today\s*(\d{1,2}):(\d{2})/);
    parsedDate = new Date(refDate);
    if (timeMatch) {
      parsedDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    } else {
      parsedDate.setHours(0, 0, 0, 0);
    }
  }
  // tomorrow HH:MM
  else if (timeStr.includes('tomorrow')) {
    const timeMatch = timeStr.match(/tomorrow\s*(\d{1,2}):(\d{2})/);
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + 1);
    if (timeMatch) {
      parsedDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    } else {
      parsedDate.setHours(0, 0, 0, 0);
    }
  }
  // in N days HH:MM
  else if (timeStr.includes('in ') && timeStr.includes(' days')) {
    const dayMatch = timeStr.match(/in (\d+) days/);
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
    if (dayMatch) {
      parsedDate = new Date(refDate);
      parsedDate.setDate(parsedDate.getDate() + parseInt(dayMatch[1]));
      if (timeMatch) {
        parsedDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
      } else {
        parsedDate.setHours(0, 0, 0, 0);
      }
    }
  }
  // 今天 HH:MM
  else if (timeStr.includes('今天')) {
    const timeMatch = timeStr.match(/今天\s*(\d{1,2}):(\d{2})/);
    parsedDate = new Date(refDate);
    if (timeMatch) {
      parsedDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    } else {
      parsedDate.setHours(0, 0, 0, 0);
    }
  }
  // 明天 HH:MM
  else if (timeStr.includes('明天')) {
    const timeMatch = timeStr.match(/明天\s*(\d{1,2}):(\d{2})/);
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + 1);
    if (timeMatch) {
      parsedDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    } else {
      parsedDate.setHours(0, 0, 0, 0);
    }
  }
  // N 天後 HH:MM
  else if (timeStr.includes('天後')) {
    const dayMatch = timeStr.match(/(\d+) 天後/);
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
    if (dayMatch) {
      parsedDate = new Date(refDate);
      parsedDate.setDate(parsedDate.getDate() + parseInt(dayMatch[1]));
      if (timeMatch) {
        parsedDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
      } else {
        parsedDate.setHours(0, 0, 0, 0);
      }
    }
  }
  // 純時間 HH:MM
  else if (/^\d{1,2}:\d{2}$/.test(timeStr.trim())) {
    const [hour, minute] = timeStr.trim().split(':').map(Number);
    parsedDate = new Date(refDate);
    parsedDate.setHours(hour, minute, 0, 0);
    if (parsedDate.getTime() < refDate.getTime()) {
      parsedDate.setDate(parsedDate.getDate() + 1);
    }
  }
  // 其他：使用 chrono 解析
  else {
    const results = chrono.parse(timeStr, refDate, { forwardDate: true });
    if (results.length > 0) {
      parsedDate = results[0].date();
    } else {
      parsedDate = new Date(timeStr);
    }
  }

  if (parsedDate && !isNaN(parsedDate.getTime())) {
    return parsedDate;
  }
  return null;
}

/**
 * 根據週期規則計算下一個執行時間
 * @param {string} rule - 週期規則 (daily, weekly:1,2,3, monthly:15, yearly:01-01)
 * @param {Date} refDate - 參考日期
 * @returns {Date} 下一個執行時間
 */
function calculateNextFromRule(rule, refDate) {
  let date = new Date(refDate);

  if (rule === 'daily') {
    date.setDate(date.getDate() + 1);
  } else if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(Number);
    const currentDayISO = date.getDay() === 0 ? 7 : date.getDay();
    let offset = 1;
    while (offset <= 7) {
      let potentialDay = (currentDayISO + offset) % 7;
      if (potentialDay === 0) potentialDay = 7;
      if (days.includes(potentialDay)) {
        date.setDate(date.getDate() + offset);
        break;
      }
      offset++;
    }
  } else if (rule.startsWith('monthly:')) {
    const dayOfMonth = parseInt(rule.split(':')[1]);
    if (date.getDate() < dayOfMonth) {
      date.setDate(dayOfMonth);
    } else {
      date.setMonth(date.getMonth() + 1);
      date.setDate(dayOfMonth);
    }
  } else if (rule.startsWith('yearly:')) {
    const [month, day] = rule.split(':')[1].split('-').map(Number);
    date.setMonth(month - 1);
    date.setDate(day);
    if (date.getTime() <= refDate.getTime()) {
      date.setFullYear(date.getFullYear() + 1);
    }
  }

  return date;
}

/**
 * 確保週期性任務的時間在未來
 */
function ensureFutureDate(date, rule, refDate) {
  if (!rule) return date;
  if (date.getTime() > refDate.getTime()) return date;

  const newDate = new Date(date);
  if (rule.startsWith('yearly:')) {
    newDate.setFullYear(newDate.getFullYear() + 1);
  } else if (rule.startsWith('monthly:')) {
    newDate.setMonth(newDate.getMonth() + 1);
  } else if (rule.startsWith('weekly:')) {
    newDate.setDate(newDate.getDate() + 7);
  } else if (rule === 'daily') {
    newDate.setDate(newDate.getDate() + 1);
  }
  return newDate;
}

// 處理訊息的路由
async function handleMessage(ctx, env) {
  const text = ctx.message.text;

  // 指令分流
  if (text.startsWith('/list')) return await handleQuery(ctx, env, text, "list");
  if (text.startsWith('/history')) return await handleQuery(ctx, env, text, "history");

  // 優先本地解析
  const local = parseTimeLocally(text);

  if (local) {
    // 本地解析成功
    await sendConfirmation(ctx, {
      task: local.task,
      remindAt: local.utcTimestamp,
      cronRule: null,
      allDay: 0,
      source: '⚡ 本地快速解析',
      originalText: text
    });
  } else {
    // 本地解析失敗，fallback 到 AI
    return await processTaskWithAI(ctx, env, text);
  }
}

// --- 2. AI 處理核心 (重構版) ---
async function processTaskWithAI(ctx, env, text, isRejudgment = false) {
  let waitMsg;

  if (!isRejudgment) {
    waitMsg = await ctx.reply("🤖 正在思考與解析...");
  }

  const refDate = getNowTaipei();

  try {
    const prompt = getTaskPrompt(text, refDate);
    const { json, rawContent } = await callAI(env, prompt);

    let remindTs = -1;
    let finalRule = json.rule;
    if (finalRule === 'none' || finalRule === 'null') finalRule = null;

    // 處理時間
    if (json.time) {
      let date = parseAITimeExpression(json.time, refDate);
      if (!date) {
        throw new Error(`時間格式無效: ${json.time}`);
      }

      // 如果是週期性任務，確保時間在未來
      if (finalRule) {
        date = ensureFutureDate(date, finalRule, refDate);
      }

      remindTs = localDateToUtcTs(date);
    } else if (finalRule) {
      // 只有規則沒有時間，計算下一個執行時間
      const date = calculateNextFromRule(finalRule, refDate);
      remindTs = localDateToUtcTs(date);
    }

    // yearly 特殊處理：重新用 chrono 解析以獲取正確日期
    if (finalRule && finalRule.startsWith('yearly:') && json.time) {
      const results = chrono.parse(json.time, refDate, { forwardDate: true });
      if (results.length > 0) {
        let date = results[0].date();
        if (date.getTime() <= refDate.getTime()) {
          date.setFullYear(date.getFullYear() + 1);
        }
        remindTs = localDateToUtcTs(date);
      }
    }

    // 處理任務名稱
    let finalTask = json.task;
    if (!finalTask || finalTask === "未命名任務" || finalTask.trim() === "") {
      finalTask = text.replace(/提醒我 | 記得 | 每週 | 每天/g, "").trim();
    }

    // 刪除等待訊息
    if (!isRejudgment && waitMsg) {
      await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    }

    // 發送確認訊息
    await sendConfirmation(ctx, {
      task: finalTask,
      remindAt: remindTs,
      cronRule: finalRule,
      allDay: json.isAllDay ? 1 : 0,
      source: isRejudgment ? '🧠 AI (重新判斷)' : '🧠 AI',
      originalText: text,
      debugRaw: JSON.stringify(json)
    });

  } catch (e) {
    console.error("AI 處理錯誤:", e);
    // 發生錯誤時，回傳完整的錯誤訊息與原始資料供排查
    const errorMsg = `⚠️ <b>解析發生錯誤</b>\n\n` +
                     `❌ <b>錯誤原因：</b> ${e.message}\n` +
                     `📄 <b>原始回應：</b>\n<pre>${e.rawContent || "無內容"}</pre>`;

    // Handle error message based on context
    if (isRejudgment) {
      // If this is a re-judgment from callback, edit the current message
      await ctx.editMessageText(errorMsg, { parse_mode: "HTML" });
    } else {
      // Otherwise, edit the wait message
      if (waitMsg) {
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, errorMsg, { parse_mode: "HTML" }).catch(() => {
          // If editing fails (message doesn't exist), reply with a new message instead
          ctx.reply(errorMsg, { parse_mode: "HTML" });
        });
      }
    }
  }
}

// --- 3. 查詢處理 (List/History) ---
async function handleQuery(ctx, env, text, mode) {
  const queryText = text.replace(/^\/(list|history)\s*/, "").trim();

  // 新增 history 清空功能
  if (mode === "history" && queryText.toLowerCase() === "clear") {
    const userId = ctx.from.id.toString();
    try {
      await deleteTodosByStatus(env, userId, 1); // 刪除 status=1 的歷史記錄
      return await ctx.reply("🗑️ 已清空所有歷史記錄。", { parse_mode: "HTML" });
    } catch (e) {
      return await ctx.reply(`❌ 清空歷史記錄失敗：${e.message}`, { parse_mode: "HTML" });
    }
  }

  if (!queryText) {
      if (mode === "list") {
          // 無參數時顯示今天及未來 7 天的待辦事項
          const { start, end } = getTodayAndFutureRangeTaipei(7);
          return await renderList(ctx, env, "近期一週", start, end, null);
      } else {
          return await renderHistory(ctx, env, "最近");
      }
  }

  // 特殊處理例行性任務查詢
  if (queryText.toLowerCase().includes('例行') ||
      queryText.toLowerCase().includes('重複') ||
      queryText.toLowerCase().includes('每') ||
      queryText.toLowerCase().includes('daily') ||
      queryText.toLowerCase().includes('weekly') ||
      queryText.toLowerCase().includes('monthly') ||
      queryText.toLowerCase().includes('yearly')) {

    const userId = ctx.from.id.toString();
    const results = await getTodos(env, userId, 0);
    const recurringTasks = results.filter(t => t.cron_rule && t.cron_rule !== 'none' && t.cron_rule !== null);

    return await renderRecurringTasks(ctx, env, recurringTasks);
  }

  // 嘗試本地解析（混合架構）
  const localQuery = parseQueryLocally(queryText);

  if (localQuery) {
    // 本地解析成功，直接使用
    if (mode === "list") {
      // 創建一個包含時間範圍信息的對象
      const timeRangeInfo = {
        label: localQuery.label,
        start: localQuery.start,
        end: localQuery.end,
        source: '⚡ 本地快速解析',
        originalQuery: queryText
      };
      return await renderList(ctx, env, localQuery.label, localQuery.start, localQuery.end, timeRangeInfo);
    } else {
      return await renderHistory(ctx, env, localQuery.label, localQuery.start, localQuery.end);
    }
  }

  // 本地解析失敗，使用 AI
  const waitMsg = await ctx.reply("🔍 查詢範圍中...");
  const now = getNowTaipei();

  try {
    const prompt = getQueryPrompt(queryText, now);
    const { json, rawContent } = await callAI(env, prompt);

    await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});

    // 使用本地解析函數計算 AI 提取的 timeExpression
    const parsedRange = parseQueryLocally(json.timeExpression);

    if (parsedRange) {
      if (mode === "list") {
        // 創建一個包含時間範圍信息的對象
        const timeRangeInfo = {
          label: json.label,
          start: parsedRange.start,
          end: parsedRange.end,
          source: '🧠 AI 解析',
          originalQuery: queryText,
          aiExtracted: json.timeExpression,
          aiRaw: rawContent
        };
        await renderList(ctx, env, json.label, parsedRange.start, parsedRange.end, timeRangeInfo);
      } else {
        await renderHistory(ctx, env, json.label, parsedRange.start, parsedRange.end);
      }
    } else {
      // 如果本地解析也失敗，回退到顯示錯誤
      await ctx.reply(`❌ 無法解析時間範圍：${json.timeExpression}`, { parse_mode: "HTML" });
    }
  } catch (e) {
    // 直接報告錯誤，不進行任何包裝
    console.error("AI Query Error:", e);

    // 直接顯示原始錯誤資訊（技術性）
    const errorMsg = `❌ ERROR\n\n` +
                     `<code>${e.name}: ${e.message}</code>\n` +
                     `${e.stack ? `\nStack:\n<code>${e.stack}</code>` : ''}\n` +
                     `${e.rawContent ? `\nRaw response (first 200 chars):\n<code>${e.rawContent.substring(0, 200)}</code>` : ''}`;

    // 如果是 re-judgment context，編輯當前訊息；否則編輯等待訊息
    if (waitMsg) {
      await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, errorMsg, { parse_mode: "HTML" });
    } else {
      await ctx.reply(errorMsg, { parse_mode: "HTML" });
    }
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
      return ctx.editMessageText(`❌ 資庫錯誤：${e.message}`);
    }
  }

  // AI 重新判斷邏輯
  if (data === "rejudge") {
    const msgText = ctx.callbackQuery.message.text;

    // 優先從「原始輸入」欄位提取完整輸入
    // 使用多種正則嘗試匹配
    let originalInput = null;

    // 嘗試匹配 <code> 標籤內的內容
    const codeMatch = msgText.match(/原始輸入：\s*<code>([^<]+)<\/code>/);
    if (codeMatch) {
      originalInput = codeMatch[1].trim();
    }

    // 如果沒有找到，嘗試另一種格式
    if (!originalInput) {
      const altMatch = msgText.match(/原始輸入：(.+?)(?:\n|🛠|$)/);
      if (altMatch) {
        originalInput = altMatch[1].replace(/<[^>]+>/g, "").trim();
      }
    }

    // 如果仍然沒有，從任務內容提取
    const taskMatch = msgText.match(/內容：(.+?)\n/);
    const taskContent = originalInput || (taskMatch ? taskMatch[1].trim() : "未命名任務");

    console.log("[DEBUG] rejudge - originalInput:", originalInput);
    console.log("[DEBUG] rejudge - taskContent:", taskContent);

    // Answer the callback query to prevent timeout
    await ctx.answerCallbackQuery("正在重新分析...");

    // Edit the message to show processing status
    await ctx.editMessageText("🤖 正在重新分析您的請求...");

    // Process the task content again with AI
    return await processTaskWithAI(ctx, env, taskContent, true);
  }

  // 管理模式 - 主選單
  if (data === "manage_mode") {
    const results = await getTodos(env, userId, 0);
    if (!results.length) return ctx.editMessageText("📭 目前無待辦事項。");

    const kb = new InlineKeyboard();
    kb.text("📋 全部任務", "manage_all|").row();
    kb.text("📅 按日期篩選", "manage_date|").row();
    kb.text("🔄 按規則篩選", "manage_rule|").row();
    kb.text("❌ 關閉", "cancel");

    await ctx.editMessageText("🗑️ <b>管理模式</b>\n請選擇篩選方式：", { parse_mode: "HTML", reply_markup: kb });
  }

  // 管理模式 - 全部任務
  if (data === "manage_all|") {
    const results = await getTodos(env, userId, 0);
    if (!results.length) return ctx.editMessageText("📭 目前無待辦事項。");

    const kb = new InlineKeyboard();
    results.forEach(t => kb.text(`⬜️ ${t.task}`, `tog_a|${t.id}|`).row());
    kb.text("⬅️ 返回", "manage_mode").text("🗑️ 刪除選取", "conf_del_a|").row();
    kb.text("❌ 關閉", "cancel");

    await ctx.editMessageText("📋 <b>全部任務</b>\n請勾選要刪除的任務：", { parse_mode: "HTML", reply_markup: kb });
  }

  // 全部任務視圖下的勾選邏輯 (Toggle with All context)
  if (data.startsWith("tog_a|")) {
      const parts = data.split("|");
      const tid = parts[1];
      const sIds = parts[2];

      let sSet = new Set(sIds ? sIds.split(",").filter(x => x) : []);
      sSet.has(tid) ? sSet.delete(tid) : sSet.add(tid);

      const results = await getTodos(env, userId, 0);
      const kb = new InlineKeyboard();
      const newList = Array.from(sSet).join(",");
      results.forEach(t => kb.text(`${sSet.has(t.id.toString())?"✅":"⬜️"} ${t.task}`, `tog_a|${t.id}|${newList}`).row());
      kb.text("⬅️ 返回", "manage_mode").text(`🗑️ 確認刪除 (${sSet.size})`, `conf_del_a|${newList}`).row();
      kb.text("❌ 關閉", "cancel");

      await ctx.editMessageText("📋 <b>全部任務</b>\n請勾選要刪除的任務：", { parse_mode: "HTML", reply_markup: kb });
  }

  // 全部任務視圖下的確認刪除
  if (data.startsWith("conf_del_a|")) {
      const idsStr = data.split("|")[1];
      if (!idsStr) return ctx.answerCallbackQuery("未選擇任何任務");
      const ids = idsStr.split(",").filter(x => x);
      if (!ids.length) return ctx.answerCallbackQuery("未選擇任何任務");

      await deleteTodosByIds(env, ids, userId);
      await ctx.editMessageText(`🗑️ 已刪除 ${ids.length} 個任務。`);
  }

  // 管理模式 - 按日期篩選
  if (data === "manage_date|") {
    const results = await getTodos(env, userId, 0);
    if (!results.length) return ctx.editMessageText("📭 目前無待辦事項。");

    // 按日期分組
    const dateGroups = {};
    results.forEach(t => {
      let dateKey;
      if (t.remind_at === -1) {
        dateKey = "無期限";
      } else {
        const d = new Date(t.remind_at * 1000);
        dateKey = d.toLocaleDateString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'});
      }
      if (!dateGroups[dateKey]) dateGroups[dateKey] = [];
      dateGroups[dateKey].push(t);
    });

    const kb = new InlineKeyboard();
    Object.keys(dateGroups).sort().forEach(dateKey => {
      kb.text(`📅 ${dateKey} (${dateGroups[dateKey].length})`, `md|${dateKey}`).row();
    });
    kb.text("⬅️ 返回", "manage_mode").text("❌ 關閉", "cancel");

    await ctx.editMessageText("📅 <b>按日期篩選</b>\n請選擇日期：", { parse_mode: "HTML", reply_markup: kb });
  }

  // 管理模式 - 顯示特定日期的任務
  if (data.startsWith("md|")) {
    const dateKey = data.substring(3);
    const results = await getTodos(env, userId, 0);

    // 篩選該日期的任務
    const filtered = results.filter(t => {
      if (dateKey === "無期限") return t.remind_at === -1;
      const d = new Date(t.remind_at * 1000);
      const taskDate = d.toLocaleDateString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'});
      return taskDate === dateKey;
    });

    if (!filtered.length) {
      return ctx.editMessageText("📭 該日期無任務。", { reply_markup: new InlineKeyboard().text("⬅️ 返回", "manage_date|") });
    }

    const kb = new InlineKeyboard();
    // 使用 tog_d 格式保持日期上下文
    filtered.forEach(t => kb.text(`⬜️ ${t.task}`, `tog_d|${t.id}||${dateKey}`).row());

    kb.text("⬅️ 返回", "manage_date|").text("🗑️ 刪除選取", `conf_del_d||${dateKey}`).row();
    kb.text("❌ 關閉", "cancel");

    await ctx.editMessageText(`📅 <b>${dateKey} 的任務</b>\n請勾選要刪除的任務：`, { parse_mode: "HTML", reply_markup: kb });
  }

  // 日期視圖下的勾選邏輯 (Toggle with Date context)
  if (data.startsWith("tog_d|")) {
      const parts = data.split("|");
      const tid = parts[1];
      const sIds = parts[2];
      const dateKey = parts[3];

      let sSet = new Set(sIds ? sIds.split(",").filter(x => x) : []);
      sSet.has(tid) ? sSet.delete(tid) : sSet.add(tid);

      const results = await getTodos(env, userId, 0);

      // 篩選該日期的任務
      const filtered = results.filter(t => {
        if (dateKey === "無期限") return t.remind_at === -1;
        const d = new Date(t.remind_at * 1000);
        const taskDate = d.toLocaleDateString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'});
        return taskDate === dateKey;
      });

      const kb = new InlineKeyboard();
      const newList = Array.from(sSet).join(",");
      filtered.forEach(t => kb.text(`${sSet.has(t.id.toString())?"✅":"⬜️"} ${t.task}`, `tog_d|${t.id}|${newList}|${dateKey}`).row());

      kb.text("⬅️ 返回", "manage_date|").text(`🗑️ 確認刪除 (${sSet.size})`, `conf_del_d|${newList}|${dateKey}`).row();
      kb.text("❌ 關閉", "cancel");

      await ctx.editMessageText(`📅 <b>${dateKey} 的任務</b>\n請勾選要刪除的任務：`, { parse_mode: "HTML", reply_markup: kb });
  }

  // 日期視圖下的確認刪除
  if (data.startsWith("conf_del_d|")) {
      const parts = data.split("|");
      const idsStr = parts[1];
      const dateKey = parts[2];

      if (!idsStr) return ctx.answerCallbackQuery("未選擇任何任務");
      const ids = idsStr.split(",").filter(x => x);
      if (!ids.length) return ctx.answerCallbackQuery("未選擇任何任務");

      await deleteTodosByIds(env, ids, userId);
      await ctx.editMessageText(`🗑️ 已刪除 ${ids.length} 個任務。`);
  }

  // 管理模式 - 按規則篩選
  if (data === "manage_rule|") {
    const results = await getTodos(env, userId, 0);
    if (!results.length) return ctx.editMessageText("📭 目前無待辦事項。");

    // 按規則分組
    const ruleGroups = { "單次": [], "每天": [], "每週": [], "每月": [], "每年": [], "其他": [] };

    results.forEach(t => {
      const rule = t.cron_rule;
      if (!rule || rule === 'none' || rule === 'null') {
        ruleGroups["單次"].push(t);
      } else if (rule === 'daily') {
        ruleGroups["每天"].push(t);
      } else if (rule.startsWith('weekly:')) {
        ruleGroups["每週"].push(t);
      } else if (rule.startsWith('monthly:')) {
        ruleGroups["每月"].push(t);
      } else if (rule.startsWith('yearly:')) {
        ruleGroups["每年"].push(t);
      } else {
        ruleGroups["其他"].push(t);
      }
    });

    const kb = new InlineKeyboard();
    Object.keys(ruleGroups).forEach(ruleKey => {
      if (ruleGroups[ruleKey].length > 0) {
        kb.text(`🔄 ${ruleKey} (${ruleGroups[ruleKey].length})`, `mr|${ruleKey}`).row();
      }
    });
    kb.text("⬅️ 返回", "manage_mode").text("❌ 關閉", "cancel");

    await ctx.editMessageText("🔄 <b>按規則篩選</b>\n請選擇規則類型：", { parse_mode: "HTML", reply_markup: kb });
  }

  // 管理模式 - 顯示特定規則的任務
  if (data.startsWith("mr|")) {
    const ruleKey = data.substring(3);
    const results = await getTodos(env, userId, 0);

    // 篩選該規則的任務
    const filtered = results.filter(t => {
      const rule = t.cron_rule;
      if (ruleKey === "單次") return !rule || rule === 'none' || rule === 'null';
      if (ruleKey === "每天") return rule === 'daily';
      if (ruleKey === "每週") return rule && rule.startsWith('weekly:');
      if (ruleKey === "每月") return rule && rule.startsWith('monthly:');
      if (ruleKey === "每年") return rule && rule.startsWith('yearly:');
      if (ruleKey === "其他") return rule && !['daily'].includes(rule) && !rule.startsWith('weekly:') && !rule.startsWith('monthly:') && !rule.startsWith('yearly:');
      return false;
    });

    if (!filtered.length) {
      return ctx.editMessageText("📭 該規則無任務。", { reply_markup: new InlineKeyboard().text("⬅️ 返回", "manage_rule|") });
    }

    const kb = new InlineKeyboard();
    // 使用 tog_r 格式保持规则上下文
    filtered.forEach(t => kb.text(`⬜️ ${t.task}`, `tog_r|${t.id}||${ruleKey}`).row());

    // 如果是週期性任務，顯示特殊刪除選項
    if (ruleKey !== "單次" && ruleKey !== "其他") {
      kb.text("🗑️ 刪除此時間點", `del_time||${ruleKey}`).row();
      kb.text("🗑️ 刪除整個規則", `del_rule||${ruleKey}`).row();
    } else {
      kb.text("🗑️ 刪除選取", `conf_del_r||${ruleKey}`).row();
    }
    kb.text("⬅️ 返回", "manage_rule|").text("❌ 關閉", "cancel");

    await ctx.editMessageText(`🔄 <b>${ruleKey}任務</b>\n請選擇操作：`, { parse_mode: "HTML", reply_markup: kb });
  }

  // 規則視圖下的勾選邏輯 (Toggle with Rule context)
  if (data.startsWith("tog_r|")) {
      const parts = data.split("|");
      const tid = parts[1];
      const sIds = parts[2];
      const ruleKey = parts[3];

      let sSet = new Set(sIds ? sIds.split(",").filter(x => x) : []);
      sSet.has(tid) ? sSet.delete(tid) : sSet.add(tid);

      const results = await getTodos(env, userId, 0);

      // 篩選該規則的任務
      const filtered = results.filter(t => {
        const rule = t.cron_rule;
        if (ruleKey === "單次") return !rule || rule === 'none' || rule === 'null';
        if (ruleKey === "每天") return rule === 'daily';
        if (ruleKey === "每週") return rule && rule.startsWith('weekly:');
        if (ruleKey === "每月") return rule && rule.startsWith('monthly:');
        if (ruleKey === "每年") return rule && rule.startsWith('yearly:');
        if (ruleKey === "其他") return rule && !['daily'].includes(rule) && !rule.startsWith('weekly:') && !rule.startsWith('monthly:') && !rule.startsWith('yearly:');
        return false;
      });

      const kb = new InlineKeyboard();
      const newList = Array.from(sSet).join(",");
      filtered.forEach(t => kb.text(`${sSet.has(t.id.toString())?"✅":"⬜️"} ${t.task}`, `tog_r|${t.id}|${newList}|${ruleKey}`).row());

      // 如果是週期性任務，顯示特殊刪除選項
      if (ruleKey !== "單次" && ruleKey !== "其他") {
        kb.text("🗑️ 刪除此時間點", `del_time|${newList}|${ruleKey}`).row();
        kb.text("🗑️ 刪除整個規則", `del_rule|${newList}|${ruleKey}`).row();
      } else {
        kb.text("🗑️ 刪除選取", `conf_del_r|${newList}|${ruleKey}`).row();
      }
      kb.text("⬅️ 返回", "manage_rule|").text("❌ 關閉", "cancel");

      await ctx.editMessageText(`🔄 <b>${ruleKey}任務</b>\n請勾選要刪除的任務：`, { parse_mode: "HTML", reply_markup: kb });
  }

  // 刪除此時間點（針對週期性任務）
  if (data.startsWith("del_time|")) {
    const parts = data.split("|");
    const idsStr = parts[1];
    const selectedIds = idsStr ? idsStr.split(",").filter(x => x) : [];

    if (!selectedIds.length) {
      return ctx.answerCallbackQuery("請先勾選任務");
    }

    // 只刪除選中的任務（單次刪除，不影響週期規則）
    await deleteTodosByIds(env, selectedIds, userId);
    await ctx.editMessageText(`🗑️ 已刪除 ${selectedIds.length} 個任務（僅此時間點）。`, { parse_mode: "HTML" });
  }

  // 刪除整個規則（針對週期性任務）
  if (data.startsWith("del_rule|")) {
    const parts = data.split("|");
    const idsStr = parts[1];
    const selectedIds = idsStr ? idsStr.split(",").filter(x => x) : [];

    if (!selectedIds.length) {
      return ctx.answerCallbackQuery("請先勾選任務");
    }

    const results = await getTodos(env, userId, 0);

    // 獲取選中任務的規則，並刪除所有相同規則的任務
    const selectedTasks = results.filter(t => selectedIds.includes(t.id.toString()));
    const rulesToDelete = [...new Set(selectedTasks.map(t => t.cron_rule).filter(r => r && r !== 'none' && r !== 'null'))];

    if (!rulesToDelete.length) {
      // 如果沒有週期規則，就只刪除選中的
      await deleteTodosByIds(env, selectedIds, userId);
      await ctx.editMessageText(`🗑️ 已刪除 ${selectedIds.length} 個任務。`, { parse_mode: "HTML" });
    } else {
      // 刪除所有符合這些規則的任務
      const tasksWithSameRule = results.filter(t => rulesToDelete.includes(t.cron_rule));
      const idsToDelete = tasksWithSameRule.map(t => t.id);
      await deleteTodosByIds(env, idsToDelete, userId);
      await ctx.editMessageText(`🗑️ 已刪除 ${idsToDelete.length} 個任務（整個規則）。`, { parse_mode: "HTML" });
    }
  }

  // 規則視圖下的確認刪除
  if (data.startsWith("conf_del_r|")) {
      const parts = data.split("|");
      const idsStr = parts[1];
      const ruleKey = parts[2];

      if (!idsStr) return ctx.answerCallbackQuery("未選擇任何任務");
      const ids = idsStr.split(",").filter(x => x);
      if (!ids.length) return ctx.answerCallbackQuery("未選擇任何任務");

      await deleteTodosByIds(env, ids, userId);
      await ctx.editMessageText(`🗑️ 已刪除 ${ids.length} 個任務。`);
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
