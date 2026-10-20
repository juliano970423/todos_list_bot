// task.js - 任務處理模組
import { InlineKeyboard, InputFile } from "grammy";
import { formatTimestampToTaipeiTime, formatDateSmart, formatDateTimeSmart, formatShortDateSmart, TAIPEI_OFFSET, getTodayRangeTaipei, getNowTaipei, getMorningReportRangeTaipei, getEveningReportRangeTaipei } from "./time.js";
import { addTodo, getTodos, getTodosByTimeRange, updateTodoStatus, addHistory, updateCronTodoNextTime } from "./db.js";
import { calculateNext } from "./time.js";
import { generateScheduleImage } from "./image.js";

// 翻譯規則顯示文字
function translateRule(rule) {
    if (!rule || rule === 'none' || rule === 'null') return "單次";
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
    // 支援更多關鍵字
    if (rule.includes('every')) return "每";
    if (rule.includes('each')) return "每";
    return rule;
}

// --- 圖片發送輔助 ---
// 注意：Telegram sendPhoto 只接受 JPEG/PNG，會拒收 SVG；
// SVG 改以文件 (document) 發送，客戶端可預覽，caption 與按鈕照常用。
function toSvgDocument(svgBuffer, name = "schedule.svg") {
  return new InputFile(svgBuffer, name);
}

// Workers 的 console 對 Error 物件序列化不完整，一律打出 message + stack + Telegram 描述
function logSendError(tag, stage, e) {
  const detail = e?.response?.description || e?.description || "";
  console.error(`[${tag}] ${stage}失敗: ${e?.name || "Error"}: ${e?.message || e}${detail ? ` | TG: ${detail}` : ""}`);
  if (e?.stack) console.error(`[${tag}] stack: ${String(e.stack).slice(0, 800)}`);
}

// --- 4. 渲染清單 (List) ---
async function renderList(ctx, env, label, startTs = null, endTs = null, aiResult = null) {
  const userId = ctx.from.id.toString();
  const results = await getTodos(env, userId, 0);

  // start/end 必須在最前面宣告（例行分支的 mg 按鈕會用到，若放後面會 TDZ crash）
  const todayRange = getTodayRangeTaipei();
  const start = startTs ?? todayRange.start;
  const end = endTs ?? todayRange.end;

  // 如果是例行性任務查詢，直接返回所有週期性任務
  if (label === "例行性任務清單") {
    const recurringTasks = results.filter(t => t.cron_rule && t.cron_rule !== 'none' && t.cron_rule !== null);

    if (!recurringTasks.length) return ctx.reply(`📋 <b>${escapeHtml(label)}</b>\n😿 喵～目前沒有例行性任務呢～`, { parse_mode: "HTML" });

    let msg = `📋 <b>${escapeHtml(label)}</b>\n`;
    const nowTsList = Math.floor(Date.now() / 1000);
    recurringTasks.forEach((t, i) => {
      let timeDisplay = "";

      if (t.remind_at > 0 && t.cron_rule) {
        // 顯示下次發生日，而不是資料庫裡可能已過期的 remind_at
        const nextTs = calculateNext(t.remind_at, t.cron_rule, nowTsList);
        if (nextTs && nextTs > 0) {
          timeDisplay = "下次 " + (t.all_day
            ? formatDateSmart(nextTs) + " (全天)"
            : formatDateTimeSmart(nextTs)) + ` (${translateRule(t.cron_rule)})`;
        } else {
          timeDisplay = `🔄 ${translateRule(t.cron_rule)}`;
        }
      } else {
        timeDisplay = `🔄 ${translateRule(t.cron_rule)}`;
      }

      msg += `${i+1}. [${timeDisplay}] ${escapeHtml(t.task)}\n`;
    });

    return await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("🗑️ 管理喵", "mg|0|0")
    });
  }

   const filtered = results.filter(t => {
    if (t.cron_rule) {
      return recurringMatchesRange(t.cron_rule, start, end);
    }
    return t.remind_at === -1 || (t.remind_at >= start && t.remind_at <= end);
  });
  if (!filtered.length) return ctx.reply(`😿 喵～${escapeHtml(label)} 沒有待辦事項呢～`);

  // 週期任務以「範圍內下次發生日」作為顯示與排序依據，避免舊 remind_at 誤導（如 /list 明年 顯示去年的日期）
  const effTs = new Map();
  for (const t of filtered) {
    if (t.cron_rule && t.remind_at > 0) {
      const occ = nextOccurrenceInRange(t.cron_rule, t.remind_at, start, end);
      effTs.set(t.id, occ !== null ? occ : t.remind_at);
    } else {
      effTs.set(t.id, t.remind_at);
    }
  }

  // 排序：先發生的在前面，無期限(-1)放最後
  filtered.sort((a, b) => {
    const ea = effTs.get(a.id), eb = effTs.get(b.id);
    if (ea === -1) return 1;
    if (eb === -1) return -1;
    return ea - eb;
  });

  let msg = `📋 <b>${escapeHtml(label)} 任務清單喵～</b>\n`;
  filtered.forEach((t, i) => {
    let timeDisplay = "";

    if (t.cron_rule) {
      const showTs = effTs.get(t.id);
      if (showTs > 0) {
        if (t.all_day) {
          timeDisplay = formatDateSmart(showTs) + " (全天)" + ` (${translateRule(t.cron_rule)})`;
        } else {
          timeDisplay = formatDateTimeSmart(showTs) + ` (${translateRule(t.cron_rule)})`;
        }
      } else {
        timeDisplay = `🔄 ${translateRule(t.cron_rule)}`;
      }
    } else if (t.all_day) {
      timeDisplay = "☀️ " + formatDateSmart(t.remind_at) + " (全天)";
    } else if (t.remind_at !== -1) {
      timeDisplay = formatDateTimeSmart(t.remind_at);
    } else {
      timeDisplay = "無期限";
    }

    msg += `${i+1}. [${timeDisplay}] ${escapeHtml(t.task)}\n`;
  });

  // 如果有時間範圍信息（本地解析或 AI）
  if (aiResult && (aiResult.source || aiResult.aiExtracted)) {
    msg += `\n\n🔍 <b>查詢時間範圍：</b>\n`;
    msg += `<code>標籤：${escapeHtml(aiResult.label || label)}\n`;
    msg += `來源：${escapeHtml(aiResult.source || 'N/A')}`;
    if (aiResult.start !== undefined) {
      msg += `\n開始：${new Date(aiResult.start * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'})} (${aiResult.start})`;
    }
    if (aiResult.end !== undefined) {
      msg += `\n結束：${new Date(aiResult.end * 1000).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'})} (${aiResult.end})`;
    }
    if (aiResult.originalQuery) {
      msg += `\n查詢：${escapeHtml(aiResult.originalQuery)}`;
    }
    if (aiResult.aiExtracted) {
      msg += `\nAI 提取：${escapeHtml(aiResult.aiExtracted)}`;
    }
    if (aiResult.aiRaw) {
      msg += `\nAI 原始回應：${escapeHtml(aiResult.aiRaw.substring(0, 200))}...`;
    }
    msg += '</code>';
  }

  // 產生圖片並發送
  const dateRange = [];
  if (filtered.length > 0) {
    const firstEff = effTs.get(filtered[0].id);
    if (firstEff > 0) dateRange.push(formatDateStr(firstEff));
    if (filtered.length > 1) {
      const last = filtered[filtered.length - 1];
      const lastEff = effTs.get(last.id);
      if (lastEff > 0) dateRange.push(formatDateStr(lastEff));
    }
  }

  let imgBuffer = null;
  try {
    imgBuffer = generateScheduleImage(filtered, {
      title: label,
      dateStr: dateRange.length ? `${dateRange[0]}${dateRange.length > 1 ? ' ~ ' + dateRange[1] : ''}` : '',
      type: 'list',
    });
    console.log(`[renderList] SVG 產生成功, ${imgBuffer.length} bytes`);
  } catch (e) {
    logSendError("renderList", "SVG 產生", e);
  }

  if (imgBuffer) {
    try {
      // caption 上限 1024 字：放得下就附在圖片上，放不下就先送圖、再分批送文字
      if (msg.length <= 1024) {
        await ctx.replyWithDocument(toSvgDocument(imgBuffer), {
          caption: msg,
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🗑️ 管理喵", `mg|${start}|${end}`)
        });
      } else {
        await ctx.replyWithDocument(toSvgDocument(imgBuffer), {
          reply_markup: new InlineKeyboard().text("🗑️ 管理喵", `mg|${start}|${end}`)
        });
        await sendChunked(ctx, msg, { parse_mode: "HTML" });
      }
      return;
    } catch (e) {
      logSendError("renderList", "SVG 文件發送", e);
    }
  }
  await sendChunked(ctx, msg, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("🗑️ 管理喵", `mg|${start}|${end}`)
  });
}

// 文字訊息 >4096 會被 Telegram 拒收，切成多段送出
async function sendChunked(ctx, msg, options = {}) {
  const chunks = chunkText(msg, 4096);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await ctx.reply(chunks[i], i === chunks.length - 1 ? options : {});
    } catch (e) {
      const isParseErr = /parse entities|BAD entity|can't parse/i.test(String(e?.description || e?.message || ""));
      if (isParseErr && options.parse_mode) {
        // HTML 解析失敗的保底：用純文字重送該段
        await ctx.reply(chunks[i]).catch(() => {});
      } else {
        throw e;
      }
    }
  }
}

// bot.api 版的 HTML 發送（cron 場景沒有 ctx），HTML 解析失敗自動改純文字
async function sendBotMessageHtml(api, chatId, text, options = {}) {
  try {
    return await api.sendMessage(chatId, text, { parse_mode: "HTML", ...options });
  } catch (e) {
    const desc = String(e?.description || e?.message || "");
    if (/parse entities|BAD entity|can't parse/i.test(desc)) {
      return api.sendMessage(chatId, text);
    }
    throw e;
  }
}

// 輔助：格式化時間戳為 YYYY/M/D（帶年）
function formatDateStr(ts) {
  return formatShortDateSmart(ts);
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

  if (!results.length) {
    // 如果是清空操作後的查詢
    if (label === "最近" && startTs === null && endTs === null) {
      return ctx.reply(`📚 ${escapeHtml(label)} 無完成紀錄喵～`, { parse_mode: "HTML" });
    }
    return ctx.reply(`📚 ${escapeHtml(label)} 無完成紀錄喵～`, { parse_mode: "HTML" });
  }

  let msg = `📚 <b>${escapeHtml(label)} 完成紀錄喵～</b>\n`;
  // 按提醒時間從近到遠排序（最近的在前）
  results.sort((a, b) => b.remind_at - a.remind_at);
  results = results.slice(0, 15); // 限制顯示 15 筆
  results.forEach((t, i) => {
    let timeStr;
    if (t.all_day) {
      timeStr = formatDateSmart(t.remind_at) + " (全天)";
    } else {
      timeStr = formatDateTimeSmart(t.remind_at);
    }
    msg += `${i+1}. [${timeStr}] ✅ ${escapeHtml(t.task)}\n`;
  });

  // 產生圖片並發送
  const dateRange = [];
  if (results.length > 0) {
    if (results[0].remind_at > 0) dateRange.push(formatDateStr(results[0].remind_at));
    if (results.length > 1) {
      const last = results[results.length - 1];
      if (last.remind_at > 0) dateRange.push(formatDateStr(last.remind_at));
    }
  }

  let imgBuffer = null;
  try {
    imgBuffer = generateScheduleImage(results, {
      title: label,
      dateStr: dateRange.length ? `${dateRange[0]}${dateRange.length > 1 ? ' ~ ' + dateRange[1] : ''}` : '',
      type: 'history',
    });
    console.log(`[renderHistory] SVG 產生成功, ${imgBuffer.length} bytes`);
  } catch (e) {
    logSendError("renderHistory", "SVG 產生", e);
  }

  if (imgBuffer) {
    try {
      if (msg.length <= 1024) {
        await ctx.replyWithDocument(toSvgDocument(imgBuffer, "history.svg"), {
          caption: msg,
          parse_mode: "HTML",
        });
      } else {
        await ctx.replyWithDocument(toSvgDocument(imgBuffer, "history.svg"), {});
        await sendChunked(ctx, msg, { parse_mode: "HTML" });
      }
      return;
    } catch (e) {
      logSendError("renderHistory", "SVG 文件發送", e);
    }
  }
  await sendChunked(ctx, msg, { parse_mode: "HTML" });
}

// --- 批次 payload 編解碼 (stateless: 數據藏在訊息文本，callback 只帶短 key) ---
function encodeBatchPayload(items) {
  const minimal = items.map(it => ({
    t: String(it.task).slice(0, 200),
    ts: parseInt(it.remindAt),
    r: (!it.cronRule || it.cronRule === 'null') ? null : it.cronRule,
    a: it.allDay ? 1 : 0
  }));
  const json = JSON.stringify(minimal);
  // utf8-safe base64（不用 escape/unescape，改用 TextEncoder；Workers/Node 都有）
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBatchPayload(str) {
  if (!str) throw new Error("缺少批次資料");
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const json = new TextDecoder("utf-8").decode(bytes);
  const arr = JSON.parse(json);
  if (!Array.isArray(arr)) throw new Error("批次資料格式錯誤");
  return arr.map(o => ({
    task: String(o.t || "").slice(0, 200),
    remindAt: parseInt(o.ts),
    cronRule: o.r || null,
    allDay: o.a ? 1 : 0
  }));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeHtml(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Telegram 文字訊息上限 4096（caption 1024）；把訊息切成多段送
function chunkText(msg, limit = 4096) {
  const text = String(msg ?? "");
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.6) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// 週期任務是否會在 [startTs, endTs]（UTC 秒）範圍內執行
// 一律用台北時鐘（+8h shifted）判斷星期/日期，避免 UTC 日期錯位
function recurringMatchesRange(cronRule, startTs, endTs) {
  if (!cronRule || cronRule === 'none' || cronRule === 'null') return false;
  const TAIPEI_CLOCK_MS = TAIPEI_OFFSET * 60000;
  const startAbs = Number(startTs) * 1000;
  const endAbs = Number(endTs) * 1000;
  if (!Number.isFinite(startAbs) || !Number.isFinite(endAbs) || endAbs < startAbs) return false;

  if (cronRule === 'daily') return true;

  if (cronRule.startsWith('weekly:')) {
    let days = [];
    try {
      days = cronRule.split(':')[1].split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 7);
    } catch { return false; }
    if (!days.length) return false;
    const cursor = new Date(startAbs + TAIPEI_CLOCK_MS);
    while (cursor.getTime() - TAIPEI_CLOCK_MS <= endAbs) {
      const iso = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay();
      if (days.includes(iso)) return true;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return false;
  }

  if (cronRule.startsWith('monthly:')) {
    const dayOfMonth = parseInt(cronRule.split(':')[1]);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return false;
    const cursor = new Date(startAbs + TAIPEI_CLOCK_MS);
    while (cursor.getTime() - TAIPEI_CLOCK_MS <= endAbs) {
      if (cursor.getUTCDate() === dayOfMonth) return true;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return false;
  }

  if (cronRule.startsWith('yearly:')) {
    let month = 0, day = 0;
    try {
      [month, day] = cronRule.split(':')[1].split('-').map(Number);
    } catch { return false; }
    if (month < 1 || month > 12) return false;
    const cursor = new Date(startAbs + TAIPEI_CLOCK_MS);
    while (cursor.getTime() - TAIPEI_CLOCK_MS <= endAbs) {
      if (cursor.getUTCMonth() + 1 === month && cursor.getUTCDate() === day) return true;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return false;
  }

  return false;
}

// 週期任務在 [startTs, endTs] 範圍內的第一次發生日（顯示用）
// 時:分沿用 baseTs（原 remind_at）；若 baseTs 本身就在範圍內或無規則，回傳 null（呼叫端直接顯示原時間）
// 台北日曆判斷，與 recurringMatchesRange 同一套語意
function nextOccurrenceInRange(cronRule, baseTs, startTs, endTs) {
  if (!cronRule || cronRule === 'none' || cronRule === 'null') return null;
  const base = Number(baseTs);
  if (!Number.isFinite(base) || base <= 0) return null;
  const start = Number(startTs), end = Number(endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (base >= start && base <= end) return null;

  const TAIPEI_CLOCK_MS = TAIPEI_OFFSET * 60000;
  const clock = new Date(base * 1000 + TAIPEI_CLOCK_MS);
  const hh = clock.getUTCHours(), mm = clock.getUTCMinutes(), ss = clock.getUTCSeconds();

  const cursor = new Date(start * 1000 + TAIPEI_CLOCK_MS);
  cursor.setUTCHours(0, 0, 0, 0);
  const endClock = end * 1000 + TAIPEI_CLOCK_MS;
  for (let i = 0; i < 400 && cursor.getTime() <= endClock; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const y = cursor.getUTCFullYear(), mo = cursor.getUTCMonth(), dd = cursor.getUTCDate();
    let hit = false;
    if (cronRule === 'daily') hit = true;
    else if (cronRule.startsWith('weekly:')) {
      const iso = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay();
      hit = cronRule.split(':')[1].split(',').map(s => parseInt(s.trim())).includes(iso);
    } else if (cronRule.startsWith('monthly:')) {
      const want = parseInt(cronRule.split(':')[1]);
      const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      // 該月沒有 31 日時 clamp 到月末（與 calculateNext 同語意）
      hit = dd === want || (dd === lastDay && want > lastDay);
    } else if (cronRule.startsWith('yearly:')) {
      const [m, d2] = cronRule.split(':')[1].split('-').map(Number);
      hit = (mo + 1) === m && dd === d2;
    }
    if (hit) {
      const ts = Math.floor(Date.UTC(y, mo, dd, hh, mm, ss) / 1000) - TAIPEI_OFFSET * 60;
      if (ts >= start && ts <= end) return ts;
    }
  }
  return null;
}

// --- 6. 確認與儲存 (UI) ---
async function sendConfirmation(ctx, state) {
  let timeStr;
  if (state.remindAt === -1) {
    timeStr = "無時間限制喵";
  } else if (state.allDay) {
    // 對於全天任務，只顯示日期，不顯示具體時間
    const date = new Date(state.remindAt * 1000);
    timeStr = date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', year:'numeric', month:'numeric', day:'numeric'});
    timeStr += " (全天)";
  } else {
    timeStr = formatTimestampToTaipeiTime(state.remindAt);
  }

  const ruleText = state.cronRule ? translateRule(state.cronRule) : "單次";

  // 使用簡單的回調數據格式，避免超過 Telegram 的 64 位元組限制
  // 實際任務內容會從訊息文本中提取（見 router.js 的 rejudge 處理）
  const rejudgeCallback = "rejudge";

  const kb = new InlineKeyboard()
    .text("✅ 確認儲存喵", `sv|${state.remindAt}|${state.cronRule || 'n'}|${state.allDay}`)
    .text("❌ 取消", "cancel")
    .row()
    .text("🤖 AI 重新判斷喵", rejudgeCallback);

  let msg = `📌 <b>任務確認喵～</b>\n` +
            `📝 內容：${escapeHtml(state.task)}\n` +
            `⏰ 時間：${escapeHtml(timeStr)}\n` +
            `🔄 規則：${escapeHtml(ruleText)}\n` +
            `🔍 來源：${escapeHtml(state.source)}`;

  // 保存原始输入文本（用于 rejudge）
  if (state.originalText) {
    msg += `\n💬 原始輸入：<code>${escapeHtml(state.originalText).slice(0, 500)}</code>`;
  }

  // 如果有 debugRaw，顯示在訊息下方 (使用單行代碼格式，避免過長)
  if (state.debugRaw) {
      msg += `\n\n🛠 <b>AI 原始數據：</b>\n<code>${escapeHtml(state.debugRaw).slice(0, 800)}</code>`;
  }

  if (msg.length > 4096) msg = msg.slice(0, 4090) + "…";

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
}

// --- 6b. 批次確認與儲存 (一次新增多筆 + 邏輯錯誤檢查顯示) ---
// items: [{task, remindAt, cronRule, allDay, valid, errors[], warnings[], source}]
async function sendBatchConfirmation(ctx, items, opts = {}) {
  const validItems = items.filter(it => it.valid);
  const invalidCount = items.length - validItems.length;

  let msg = `📌 <b>批次任務確認喵～</b> (共 ${items.length} 筆，有效 ${validItems.length} 筆${invalidCount ? `，${invalidCount} 筆有問題` : ''})\n`;

  items.forEach((it, idx) => {
    let timeStr;
    if (it.remindAt === -1) {
      timeStr = "無期限";
    } else if (it.allDay) {
      timeStr = formatDateSmart(it.remindAt) + " (全天)";
    } else {
      timeStr = formatDateTimeSmart(it.remindAt);
    }
    const ruleText = it.cronRule ? translateRule(it.cronRule) : "單次";
    const mark = it.valid ? "✅" : "❌";
    msg += `\n${mark} <b>${idx + 1}.</b> ${escapeHtml(it.task)}\n   ⏰ ${escapeHtml(timeStr)} | 🔄 ${escapeHtml(ruleText)}`;
    if (it.warnings && it.warnings.length) {
      it.warnings.forEach(w => { msg += `\n   ⚠️ ${escapeHtml(w)}`; });
    }
    if (it.errors && it.errors.length) {
      it.errors.forEach(e => { msg += `\n   ⛔ ${escapeHtml(e)}`; });
    }
  });

  msg += `\n\n🔍 來源：${escapeHtml(opts.source || '🧠 AI (批次)')}`;
  if (opts.originalText) {
    msg += `\n💬 原始輸入：<code>${escapeHtml(opts.originalText).slice(0, 500)}</code>`;
  }
  if (opts.debugRaw) {
    msg += `\n\n🛠 <b>AI 原始數據：</b>\n<code>${escapeHtml(opts.debugRaw).slice(0, 800)}</code>`;
  }

  if (!validItems.length) {
    msg += `\n\n❌ 沒有可儲存的有效任務，請修改後重試喵～`;
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  // stateless 批次數據：只存有效任務，避免把錯誤任務寫入
  const payload = encodeBatchPayload(validItems);
  msg += `\n\nBATCH_DATA:${payload}`;

  const kb = new InlineKeyboard()
    .text(`✅ 全部儲存 (${validItems.length}筆)`, "svall")
    .text("❌ 取消", "cancel")
    .row()
    .text("🤖 AI 重新判斷喵", "rejudge");

  // 若有多筆，逐筆儲存按鈕（每行一個，callback 只帶 index，數據從訊息解析）
  if (validItems.length > 1 && validItems.length <= 5) {
    kb.row();
    validItems.forEach((_, i) => {
      kb.text(`存#${i + 1}`, `svone|${i}`);
    });
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
}

// 處理定時任務提醒
async function processScheduledReminders(bot, env) {
  const nowTs = Math.floor(Date.now() / 1000);
  const nowTaipei = getNowTaipei();
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
      await sendBotMessageHtml(bot.api, todo.user_id, `🔔 <b>提醒時間到！</b>\n👉 ${escapeHtml(todo.task)}`);

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
    console.log(`[每日报告] 当前台北时间: ${h}:${m}, nowTaipei: ${nowTaipei.toISOString()}`);
    if ((h === 9 || h === 21) && m < 1) {
      console.log(`[每日报告] 触发报告发送，isMorning: ${h === 9}`);
      const isMorning = (h === 9);
      const timeRange = isMorning ? getMorningReportRangeTaipei() : getEveningReportRangeTaipei();
      console.log(`[每日报告] 时间范围: ${timeRange.start} - ${timeRange.end}`);

      // 获取所有有待办事项的用户
      const { results: userRows } = await env.DB.prepare(
        "SELECT DISTINCT user_id FROM todos WHERE status = 0"
      ).all();
      console.log(`[每日报告] 找到 ${userRows.length} 个有待办的用户`);

      for (const row of userRows) {
        const userId = row.user_id;
        console.log(`[每日报告] 处理用户 ${userId}`);

        // 获取用户所有未完成的待办
        const allTodos = await getTodos(env, userId, 0);
        console.log(`[每日报告] 用户 ${userId} 有 ${allTodos.length} 个未完成的待办`);

        // 过滤出在报告时间范围内的任务（包括周期任务）
        const filtered = allTodos.filter(t => {
          if (t.cron_rule) {
            // 周期任务：检查下次执行时间是否在报告时间范围内
            return t.remind_at >= timeRange.start && t.remind_at <= timeRange.end;
          }
          // 单次任务：检查是否在时间范围内
          return t.remind_at >= timeRange.start && t.remind_at <= timeRange.end;
        });
        console.log(`[每日报告] 用户 ${userId} 过滤后有 ${filtered.length} 个待办在报告范围内`);

        if (filtered.length > 0) {
          let msg = `📋 <b>${isMorning ? '今日待辦 (9:00-24:00)' : '今晚及明日待辦 (21:00-24:00)'}</b>\n\n`;

          // 排序：先发生的在前面
          filtered.sort((a, b) => {
            if (a.remind_at === -1) return 1;
            if (b.remind_at === -1) return -1;
            return a.remind_at - b.remind_at;
          });

          filtered.forEach((t, i) => {
            let timeStr = '';
            if (t.cron_rule) {
              timeStr = `🔄 ${translateRule(t.cron_rule)}`;
            } else if (t.all_day) {
              timeStr = '☀️ ' + formatDateSmart(t.remind_at) + ' (全天)';
            } else if (t.remind_at !== -1) {
              timeStr = formatDateTimeSmart(t.remind_at);
            } else {
              timeStr = '無期限';
            }
            msg += `${i + 1}. [${timeStr}] ${escapeHtml(t.task)}\n`;
          });

          try {
            console.log(`[每日报告] 准备发送消息给用户 ${userId}`);

            // 產生圖片並發送（SVG 以文件形式發送，sendPhoto 會拒收 SVG）
            try {
              const reportType = isMorning ? 'morning' : 'evening';
              const reportTitle = isMorning ? '今日待辦' : '今晚及明日待辦';
              // 用真實 instant 渲染台北日期（getNowTaipei 是 +8h shifted clock，不可再套 timeZone）
              const dateStr = new Date(Date.now()).toLocaleString('zh-TW', {
                timeZone: 'Asia/Taipei',
                month: 'numeric',
                day: 'numeric',
                weekday: 'short',
              });
              let imgBuffer = null;
              try {
                imgBuffer = generateScheduleImage(filtered, {
                  title: reportTitle,
                  dateStr: dateStr,
                  type: reportType,
                });
                console.log(`[每日报告] SVG 產生成功, ${imgBuffer.length} bytes, user=${userId}`);
              } catch (genErr) {
                logSendError("每日报告", "SVG 產生", genErr);
              }
              const reportChunks = chunkText(msg, 4096);
              const sendReportText = async () => {
                for (const part of reportChunks) {
                  await sendBotMessageHtml(bot.api, userId, part);
                }
              };
              if (imgBuffer) {
                try {
                  // caption 上限 1024，太長就只送圖，文字另外分批送
                  if (msg.length <= 1024) {
                    await bot.api.sendDocument(userId, toSvgDocument(imgBuffer, "report.svg"), {
                      caption: msg,
                      parse_mode: "HTML",
                    });
                  } else {
                    await bot.api.sendDocument(userId, toSvgDocument(imgBuffer, "report.svg"), {});
                    await sendReportText();
                  }
                } catch (sendErr) {
                  logSendError("每日报告", "SVG 文件發送", sendErr);
                  await sendReportText();
                }
              } else {
                await sendReportText();
              }
            } catch (imgErr) {
              logSendError("每日报告", "圖片流程", imgErr);
              for (const part of chunkText(msg, 4096)) {
                await sendBotMessageHtml(bot.api, userId, part);
              }
            }

            console.log(`[每日报告] 成功发送报告给用户 ${userId}`);
          } catch (e) {
            logSendError("每日报告", `发送报告给 ${userId}`, e);
          }
        }
      }
    } else {
      console.log(`[每日报告] 未到报告时间，当前: ${h}:${m}`);
    }
  } catch (e) {
    logSendError("Cron", "定時任務", e);
  }
}

// --- 7. 渲染例行性任務列表 ---
async function renderRecurringTasks(ctx, env, tasks) {
  if (!tasks || tasks.length === 0) {
    return await ctx.reply(`📋 <b>例行性任務清單：</b>\n😿 喵～目前沒有例行性任務呢～`, { parse_mode: "HTML" });
  }

  let msg = `📋 <b>例行性任務清單喵～</b>\n`;
  tasks.forEach((t, i) => {
    let timeDisplay = "";

    if (t.remind_at > 0) {
      if (t.all_day) {
        timeDisplay = formatDateSmart(t.remind_at) + " (全天)";
      } else {
        timeDisplay = formatDateTimeSmart(t.remind_at);
      }
      timeDisplay += ` (${translateRule(t.cron_rule)})`;
    } else {
      timeDisplay = `🔄 ${translateRule(t.cron_rule)}`;
    }

    msg += `${i+1}. [${timeDisplay}] ${escapeHtml(t.task)}\n`;
  });

  return await sendChunked(ctx, msg, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("🗑️ 管理喵", "manage_mode")
  });
}

export {
  renderList,
  renderHistory,
  sendConfirmation,
  sendBatchConfirmation,
  encodeBatchPayload,
  decodeBatchPayload,
  processScheduledReminders,
  translateRule,
  renderRecurringTasks,
  escapeHtml,
  unescapeHtml,
  chunkText,
  sendChunked,
  sendBotMessageHtml,
  recurringMatchesRange,
  nextOccurrenceInRange
};
