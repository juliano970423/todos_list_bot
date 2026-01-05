// task.js - 任務處理模組
import { InlineKeyboard } from "grammy";
import { formatTimestampToTaipeiTime, TAIPEI_OFFSET } from "./time.js";
import { addTodo, getTodos, getTodosByTimeRange, updateTodoStatus, addHistory, updateCronTodoNextTime } from "./db.js";
import { calculateNext } from "./time.js";

// 翻譯規則顯示文字
function translateRule(rule) {
    if (!rule || rule === 'none') return "單次";
    if (rule === 'daily') return "每天";
    if (rule.startsWith('weekly:')) {
        const days = rule.split(':')[1];
        if (days === '1,2,3,4,5') return "週一至週五";
        if (days === '6,7') return "週末";
        if (days === '1,3,5') return "週一、週三、週五";
        if (days === '2,4,6') return "週二、週四、週六";
        // 如果是單一天，例如 'weekly:1' 代表週一
        if (/^\d+$/.test(days)) {
            const dayMap = {
                '1': '週一', '2': '週二', '3': '週三',
                '4': '週四', '5': '週五', '6': '週六', '7': '週日'
            };
            return `每${dayMap[days] || '週'}`;
        }
        return "每週";
    }
    if (rule.startsWith('monthly:')) return "每月";
    if (rule.startsWith('yearly:')) return "每年";
    return rule;
}

// --- 4. 渲染清單 (List) ---
async function renderList(ctx, env, label, startTs = null, endTs = null, aiResult = null) {
  const userId = ctx.from.id.toString();
  const results = await getTodos(env, userId, 0);

  const start = startTs || Math.floor(new Date().setHours(0,0,0,0)/1000);
  const end = endTs || Math.floor(new Date().setHours(23,59,59,999)/1000);

  const filtered = results.filter(t => {
    if (t.cron_rule) {
      // 對於週期性任務，需要檢查在指定時間範圍內是否有符合規則的日期
      if (t.cron_rule.startsWith('weekly:')) {
        const days = t.cron_rule.split(':')[1].split(',').map(Number);

        // 檢查時間範圍內是否有符合週期規則的日期
        const startDate = new Date(start * 1000);
        const endDate = new Date(end * 1000);

        // 遍歷時間範圍內的每一天，檢查是否有符合規則的日期
        let currentDate = new Date(startDate);
        while (currentDate <= endDate) {
          const dayOfWeekISO = currentDate.getDay() === 0 ? 7 : currentDate.getDay(); // Convert to ISO (1 for Mon, ..., 7 for Sun)
          if (days.includes(dayOfWeekISO)) {
            return true; // 如果時間範圍內有符合規則的日期，則顯示此任務
          }
          currentDate.setDate(currentDate.getDate() + 1); // 移動到下一天
        }
        return false; // 時間範圍內沒有符合規則的日期
      }
      // daily 週期性任務在任何時間範圍內都顯示
      return t.cron_rule === 'daily';
    }
    return t.remind_at === -1 || (t.remind_at >= start && t.remind_at <= end);
  });

  if (!filtered.length) return ctx.reply(`📭 ${label} 沒有待辦事項。`);

  let msg = `📋 <b>${label} 任務清單：</b>\n`;
  filtered.forEach((t, i) => {
    let timeDisplay = "";

    if (t.cron_rule) {
      // 對於週期性任務，顯示具體時間後加上週期條件
      if (t.remind_at > 0) {
        if (t.all_day) {
          // 對於全天的週期任務，顯示日期和週期條件
          timeDisplay = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'}) + " (全天)" + ` (${translateRule(t.cron_rule)})`;
        } else {
          timeDisplay = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}) + ` (${translateRule(t.cron_rule)})`;
        }
      } else {
        // 如果沒有具體時間，顯示週期條件
        timeDisplay = `🔄 ${translateRule(t.cron_rule)}`;
      }
    } else if (t.all_day) {
      // 對於全天任務，只顯示日期
      timeDisplay = "☀️ " + new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'}) + " (全天)";
    } else if (t.remind_at !== -1) {
      timeDisplay = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
    } else {
      timeDisplay = "無期限";
    }

    msg += `${i+1}. [${timeDisplay}] ${t.task}\n`;
  });
  // 如果有 AI 解析結果，添加到消息末尾
  if (aiResult) {
    msg += `\n\n🔍 <b>AI 解析結果：</b>\n`;
    msg += `<code>標籤: ${aiResult.label || 'N/A'}`;
    if (aiResult.start !== undefined) msg += `\n開始時間: ${new Date(aiResult.start * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'})} (${aiResult.start})`;
    if (aiResult.end !== undefined) msg += `\n結束時間: ${new Date(aiResult.end * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'})} (${aiResult.end})`;
    msg += '</code>';
  }

  await ctx.reply(msg, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("🗑️ 管理模式", "manage_mode")
  });
}

// --- 5. 渲染歷史 (History) ---
async function renderHistory(ctx, env, label, startTs = null, endTs = null) {
  const userId = ctx.from.id.toString();
  let results;
  
  if (startTs && endTs) {
    results = await getTodosByTimeRange(env, userId, startTs, endTs, 1);
  } else {
    results = await getTodos(env, userId, 1);
  }

  if (!results.length) return ctx.reply(`📚 ${label} 無完成紀錄。`);
  let msg = `📚 <b>${label} 完成紀錄：</b>\n`;
  // 按提醒時間從近到遠排序（最近的在前）
  results.sort((a, b) => b.remind_at - a.remind_at);
  results = results.slice(0, 15); // 限制顯示15筆
  results.forEach((t, i) => {
    let timeStr;
    if (t.all_day) {
      // 對於全天任務，只顯示日期
      timeStr = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'}) + " (全天)";
    } else {
      timeStr = new Date(t.remind_at * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
    }
    msg += `${i+1}. [${timeStr}] ✅ ${t.task}\n`;
  });
  await ctx.reply(msg, { parse_mode: "HTML" });
}

// --- 6. 確認與儲存 (UI) ---
async function sendConfirmation(ctx, state) {
  let timeStr;
  if (state.remindAt === -1) {
    timeStr = "無時間限制";
  } else if (state.allDay) {
    // 對於全天任務，只顯示日期，不顯示具體時間
    const date = new Date(state.remindAt * 1000);
    timeStr = date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', year:'numeric', month:'numeric', day:'numeric'});
    timeStr += " (全天)";
  } else {
    timeStr = formatTimestampToTaipeiTime(state.remindAt);
  }

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

// 處理定時任務提醒
async function processScheduledReminders(bot, env) {
  const nowTs = Math.floor(Date.now() / 1000);
  const nowTaipei = new Date(Date.now() + TAIPEI_OFFSET * 60 * 1000);
  const currentDayOfWeek = nowTaipei.getDay(); // 0 for Sunday, 1 for Monday, ..., 6 for Saturday
  const currentDayOfWeekISO = currentDayOfWeek === 0 ? 7 : currentDayOfWeek; // Convert to ISO (1 for Mon, ..., 7 for Sun)

  try {
    // 1. 檢查提醒 (精確時間)
    const { results: allReminders } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0 AND remind_at > 0 AND remind_at <= ?").bind(nowTs).all();

    // 過濾出符合當前星期幾的任務（對於週期性任務）
    const remindersToProcess = [];
    for (const todo of allReminders) {
      if (todo.cron_rule && todo.cron_rule.startsWith('weekly:')) {
        const days = todo.cron_rule.split(':')[1].split(',').map(Number);
        if (days.includes(currentDayOfWeekISO)) {
          remindersToProcess.push(todo);
        }
      } else {
        // 非 weekly 循環任務或單次任務，直接加入處理列表
        remindersToProcess.push(todo);
      }
    }

    for (const todo of remindersToProcess) {
      await bot.api.sendMessage(todo.user_id, `🔔 <b>提醒時間到！</b>\n👉 ${todo.task}`, { parse_mode: "HTML" });

      if (!todo.cron_rule) {
        // 單次任務 -> 記錄歷史 + 標記完成
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
        await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
      } else {
        // 循環任務 -> 記錄歷史 + 更新下次時間
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
        const nextTs = calculateNext(todo.remind_at, todo.cron_rule);
        await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
      }
    }

    // 2. 每日彙整 (早晚 9 點)
    const h = nowTaipei.getUTCHours();
    const m = nowTaipei.getUTCMinutes();
    if ((h === 9 || h === 21) && m < 5) {
       // (簡化版：實際部署可加入彙整通知邏輯)
       // console.log("執行每日彙整檢查...");
    }
  } catch (e) {
    console.error("Cron Error:", e);
  }
}

export {
  renderList,
  renderHistory,
  sendConfirmation,
  processScheduledReminders,
  translateRule
};