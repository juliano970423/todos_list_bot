// task.js - 任務處理模組
import { InlineKeyboard, InputFile } from "grammy";
import { formatTimestampToTaipeiTime, formatDateSmart, formatDateTimeSmart, formatShortDateSmart, TAIPEI_OFFSET, getTodayRangeTaipei, getNowTaipei, getMorningReportRangeTaipei, getEveningReportRangeTaipei } from "./time.js";
import { addTodo, getTodos, getTodosByTimeRange, addHistory, updateCronTodoNextTime, getReportState, saveReportState } from "./db.js";
import { calculateNext } from "./time.js";
import { generateSchedulePng } from "./image.js";
import { compareTasksByPriority, getTaskTier } from "./priority.js";

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
// Telegram sendPhoto 只接受 JPEG/PNG；SVG 一律先由 image.js 點陣成 PNG 再以照片發送
//（不再用檔案附件形式）。caption 上限 1024：放得下就併同一則，放不下先送圖再補文字。

// ctx 版：照片 + caption（≤1024 併一則）或照片 + 分批文字
async function replyWithSchedulePhoto(ctx, png, msg, extra = {}) {
  if (msg.length <= 1024) {
    await ctx.replyWithPhoto(new InputFile(png, "schedule.png"), {
      caption: msg,
      parse_mode: "HTML",
      ...extra,
    });
  } else {
    await ctx.replyWithPhoto(new InputFile(png, "schedule.png"), extra);
    await sendChunked(ctx, msg, { parse_mode: "HTML" });
  }
}

// bot.api 版（cron 場景沒有 ctx）；extra 透傳給 sendPhoto（例：逾期清掃按鈕）
async function sendSchedulePhoto(api, chatId, png, msg, extra = {}) {
  if (msg.length <= 1024) {
    await api.sendPhoto(chatId, new InputFile(png, "report.png"), {
      caption: msg,
      parse_mode: "HTML",
      ...extra,
    });
  } else {
    await api.sendPhoto(chatId, new InputFile(png, "report.png"), extra);
    for (const part of chunkText(msg, 4096)) {
      await sendBotMessageHtml(api, chatId, part);
    }
  }
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

  const view = await buildListView(env, userId, label, startTs, endTs, aiResult, results);
  if (!view) return ctx.reply(`😿 喵～${escapeHtml(label)} 沒有待辦事項呢～`);

  // 1) 照片訊息：純圖 + 短標題 caption，不放任何按鈕——
  //    按鈕掛在照片上只能用 editMessageMedia/caption 編輯，實測不可靠
  //    （「管理喵/✅ 按了沒反應」的根因）。改成照片(純圖) + 文字清單(帶按鈕)兩則。
  let photoMsgId = null;
  if (view.png) {
    try {
      const sent = await ctx.replyWithPhoto(new InputFile(view.png, "schedule.png"), {
        caption: view.photoCaption,
        parse_mode: "HTML",
      });
      photoMsgId = sent?.message_id ?? null;
    } catch (e) {
      logSendError("renderList", "照片發送", e);
    }
  }

  // 2) 文字清單：✅ N + 管理喵按鈕掛這則（editMessageText 可靠）；callback 帶照片 id 供就地換圖
  const kb = buildListKb(view.filtered, view.start, view.end, label, photoMsgId, view.canDone);
  await sendChunked(ctx, view.msg, { parse_mode: "HTML", reply_markup: kb });
}

// --- 4b. 清單視圖建構（發送與「標完成後就地更新」共用） ---
// start/end 可為 null（自動帶今天範圍）；results 由呼叫端傳入避免重複查詢
async function buildListView(env, userId, label, start, end, aiResult, results) {
  const todayRange = getTodayRangeTaipei();
  start = start ?? todayRange.start;
  end = end ?? todayRange.end;

   const filtered = results.filter(t => {
    if (t.cron_rule) {
      return recurringMatchesRange(t.cron_rule, start, end);
    }
    return t.remind_at === -1 || (t.remind_at >= start && t.remind_at <= end);
  });
  if (!filtered.length) return null;

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

  // 排序：考試/作業優先（tier 制），同 tier 照時間，無期限(-1)放最後
  filtered.sort((a, b) => compareTasksByPriority(a, b, (t) => effTs.get(t.id)));

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

    msg += `${i + 1}. ${getTaskTier(t.task) === 0 ? "📌 " : ""}[${timeDisplay}] ${escapeHtml(t.task)}\n`;
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

  // 產生圖片（PNG；失敗時 png=null，呼叫端退回純文字）
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

  let png = null;
  try {
    png = await generateSchedulePng(filtered, {
      title: label,
      dateStr: dateRange.length ? `${dateRange[0]}${dateRange.length > 1 ? ' ~ ' + dateRange[1] : ''}` : '',
      type: 'list',
    });
    console.log(`[renderList] PNG 產生成功, ${png.byteLength} bytes`);
  } catch (e) {
    logSendError("renderList", "PNG 產生", e);
  }

  // 照片訊息用短 caption（完整清單文字在另一則文字訊息上，按鈕也掛在那裡）
  let photoCaption = `📋 <b>${escapeHtml(label)} 喵～</b>`;
  if (dateRange.length) {
    photoCaption += `\n🗓 ${escapeHtml(dateRange.join(" ~ "))}`;
  }

  return {
    filtered, effTs, msg, png, photoCaption,
    start, end,
    canDone: !aiResult && msg.length <= 4000, // 文字訊息上限 4096，留餘裕
  };
}

// 清單按鈕：管理喵一律有；每筆「✅ N」只在非查詢模式、文字放得下、≤10 筆時附上。
// callback 帶 photoMsgId：標完成後把上方照片就地換新圖（best-effort，失敗不影響操作）。
// callback_data 上限 64 bytes，放不下就整組不加。
function buildListKb(filtered, start, end, label, photoMsgId, canDone) {
  const kb = new InlineKeyboard();
  const pid = photoMsgId || 0;
  if (canDone && filtered.length <= 10) {
    const enc = new TextEncoder();
    const fits = filtered.every(t => enc.encode(`doneone|${t.id}|${start}|${end}|${label}|${pid}`).length <= 64);
    if (fits) {
      for (let i = 0; i < filtered.length; i += 2) {
        kb.text(`✅ ${i + 1}`, `doneone|${filtered[i].id}|${start}|${end}|${label}|${pid}`);
        if (filtered[i + 1]) kb.text(`✅ ${i + 2}`, `doneone|${filtered[i + 1].id}|${start}|${end}|${label}|${pid}`);
        kb.row();
      }
    }
  }
  kb.text("🗑️ 管理喵", `mg|${start}|${end}`);
  return kb;
}

// 標完成後就地更新清單：
// 新版版面是「照片(純圖無按鈕) + 文字清單(帶按鈕)」兩則，callback 來自文字訊息，
// photoMsgId 由 callback_data 帶入，標完成後把照片 best-effort 換成新圖。
// 舊版單則照片訊息上的按鈕也相容：就地編輯不可靠，改發一則新的文字清單。
async function refreshListView(ctx, env, userId, label, start, end, photoMsgId = null) {
  const results = await getTodos(env, userId, 0);
  const view = await buildListView(env, userId, label, start, end, null, results);
  const isPhoto = !!ctx.callbackQuery?.message?.photo; // 舊版單則照片訊息上的按鈕
  if (!view) {
    // 該範圍已無待辦：就地收尾
    try {
      if (isPhoto) await ctx.editMessageCaption("🎉 全部完成了喵～");
      else await ctx.editMessageText("🎉 全部完成了喵～");
    } catch (e) {
      await ctx.reply("🎉 全部完成了喵～").catch(() => {});
    }
    if (photoMsgId) {
      await ctx.api.editMessageCaption(ctx.chat.id, photoMsgId, { caption: "🎉 全部完成了喵～" }).catch((e) => {
        console.error(`[refreshListView] 照片caption更新失敗(不影響操作): ${e?.message || e}`);
      });
    }
    return;
  }
  const kb = buildListKb(view.filtered, view.start, view.end, label, photoMsgId, view.canDone);
  if (isPhoto) {
    // 舊版照片訊息：改發一則新文字清單（照片留著不再更新）
    await ctx.reply(view.msg, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    return;
  }
  try {
    await ctx.editMessageText(view.msg, { parse_mode: "HTML", reply_markup: kb });
  } catch (e) {
    // 就地編輯失敗（訊息太舊/解析錯誤）：退回發新訊息，確保使用者看得到最新狀態
    logSendError("refreshListView", "就地編輯", e);
    await ctx.reply(view.msg, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  }
  if (photoMsgId && view.png) {
    // 照片換新圖（best-effort：失敗只是圖舊了，清單操作不受影響）
    await ctx.api.editMessageMedia(ctx.chat.id, photoMsgId, { type: "photo", media: new InputFile(view.png, "list.png") }).catch((e) => {
      console.error(`[refreshListView] 照片更新失敗(不影響操作): ${e?.message || e}`);
    });
  }
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

  let png = null;
  try {
    png = await generateSchedulePng(results, {
      title: label,
      dateStr: dateRange.length ? `${dateRange[0]}${dateRange.length > 1 ? ' ~ ' + dateRange[1] : ''}` : '',
      type: 'history',
    });
    console.log(`[renderHistory] PNG 產生成功, ${png.byteLength} bytes`);
  } catch (e) {
    logSendError("renderHistory", "PNG 產生", e);
  }

  if (png) {
    try {
      await replyWithSchedulePhoto(ctx, png, msg);
      return;
    } catch (e) {
      logSendError("renderHistory", "照片發送", e);
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
        // 小月 clamp 到月末（與 calculateNext 同語意：monthly:31 在二月 = 2/28）
        const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
        if (cursor.getUTCDate() === dayOfMonth || (cursor.getUTCDate() === lastDay && dayOfMonth > lastDay)) return true;
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
      // 該月沒有這一天（2/29 非閏年、xx-31 小月）時 clamp 到月末（與 calculateNext 同語意）
      const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
      const isTargetMonth = cursor.getUTCMonth() + 1 === month;
      if (isTargetMonth && (cursor.getUTCDate() === day || (cursor.getUTCDate() === lastDay && day > lastDay))) return true;
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
      const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      hit = (mo + 1) === m && (dd === d2 || (dd === lastDay && d2 > lastDay));
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

// 提醒訊息的鍵盤：單次 ✅/還沒（rdone/rsnooze）；循環 ✅ 只回執（rdone2，不動排程狀態）
// 抽成獨立函式供單元測試——舊版循環任務直接 undefined，提醒訊息完全沒按鈕
export function buildRemindKeyboard(todo) {
  const kb = new InlineKeyboard().text("✅ 做完了", `rdone${todo.cron_rule ? "2" : ""}|${todo.id}`);
  if (!todo.cron_rule) kb.text("還沒", `rsnooze|${todo.id}`);
  return kb;
}

// 處理定時任務提醒
async function processScheduledReminders(bot, env) {
  const nowTs = Math.floor(Date.now() / 1000);
  const nowTaipei = getNowTaipei();
  const currentDayOfWeek = nowTaipei.getDay(); // 0 for Sunday, 1 for Monday, ..., 6 for Saturday
  const currentDayOfWeekISO = currentDayOfWeek === 0 ? 7 : currentDayOfWeek; // Convert to ISO (1 for Mon, ..., 7 for Sun)

  try {
    // 0. 每日彙整（先於提醒：狀態制防漏發，提醒的錯誤不再拖垮當日報告）
    await processDailyReports(bot, env, nowTaipei);

    // 1. 檢查提醒 (精確時間)；ORDER BY 讓最舊的先敲（部署後累積的舊帳有清掃順序）
    const { results: allReminders } = await env.DB.prepare("SELECT * FROM todos WHERE status = 0 AND remind_at > 0 AND remind_at <= ? ORDER BY remind_at ASC").bind(nowTs).all();

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

    // 每 tick 最多敲 10 筆：部署後逾期舊帳一次湧入時分批補敲，避免單次轟炸
    for (const todo of remindersToProcess.slice(0, 10)) {
      // 全天任務夜間靜音：00:00-08:59 不敲鐘（無時刻任務的 remind_at 一律為當日 00:00，
      // 舊行為會在半夜 00:0x 轟一天 🔔）。改為 9 點後第一個 tick 發出，內容同時由早報呈現。
      if (todo.all_day && nowTaipei.getUTCHours() < 9) continue;

      const isSingle = !todo.cron_rule;
      // 提醒附「做完了」按鈕：單次 = ✅ 標完成進歷史／還沒 = 侀眠到明天同一時刻；
      // 循環 = ✅ 只回執（歷史在發送時已寫入，狀態不動，下次照排程提醒）
      const remindKb = buildRemindKeyboard(todo);

      try {
        await sendBotMessageHtml(bot.api, todo.user_id, `🔔 <b>提醒時間到！</b>\n👉 ${escapeHtml(todo.task)}`, remindKb ? { reply_markup: remindKb } : {});
      } catch (e) {
        // 單筆發送失敗：不記錄/不推進（下個 tick 自動重試），也不中斷整輪
        logSendError("提醒", `發送 todo#${todo.id}`, e);
        continue;
      }

      if (isSingle) {
        // 單次任務 -> 記錄歷史 + 改為「已提醒待確認」(status=2)：
        // 等使用者按 ✅ 做完了（status=1 進歷史）或 還沒（status=0 並推遲一天）才了結，
        // 不再自動標完成——任務一直沒回應就會隔天出現在早報「昨日以前未完成」區塊，有按鈕可清。
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
        await env.DB.prepare("UPDATE todos SET status = 2 WHERE id = ?").bind(todo.id).run();
      } else {
        // 循環任務 -> 記錄歷史 + 更新下次時間
        await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(todo.user_id, todo.task, todo.remind_at).run();
        const nextTs = calculateNext(todo.remind_at, todo.cron_rule);
        await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todo.id).run();
      }
    }

  } catch (e) {
    logSendError("Cron", "定時任務", e);
  }
}

// 台北今日日期字串 YYYY-MM-DD（+8h shifted clock 的 UTC 曆法即台北日曆）
function taipeiTodayStr(nowTaipei) {
  const d = nowTaipei || getNowTaipei();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// 每日彙整（早晚報告）— 狀態制防漏發：
// 舊版依賴 m<1 尖峰窗口，cron 延遲 1 分鐘就整天漏發；改為「當天未發且已過目標時刻就發」：
//   早報：09:00 ≤ 台北時間 < 21:00 之間的第一個 tick
//   晚報：台北時間 ≥ 21:00 之後的第一個 tick
// 發送成功（或當天無內容）才寫入 report_state；失敗則下個 tick 自動補發（at-least-once）。

// isolate 記憶體備忘（key = `${kind}:${today}`）：與 D1 report_state 雙保險。
// 即使 DB 建表/寫入暫時失敗（表不存在、D1 打嗝），同一 isolate 內也不會重發第二次。
const dailyReportMemo = new Map();

async function processDailyReports(bot, env, nowTaipei) {
  const h = nowTaipei.getUTCHours();
  const isMorning = h >= 9 && h < 21;
  const isEvening = h >= 21;
  if (!isMorning && !isEvening) return;

  const kind = isMorning ? "morning" : "evening";
  const today = taipeiTodayStr(nowTaipei);
  const memoKey = `${kind}:${today}`;
  if (dailyReportMemo.get(memoKey)) return; // 記憶體備忘：今天已發過
  const lastDate = await getReportState(env, kind);
  if (lastDate === today) {
    dailyReportMemo.set(memoKey, true); // 回填備忘，之後不再打 DB
    return; // 今天已發過
  }
  const timeRange = isMorning ? getMorningReportRangeTaipei() : getEveningReportRangeTaipei();

  // 有未完成待辦的用戶（單人使用情境即本人）
  const { results: userRows } = await env.DB.prepare(
    "SELECT DISTINCT user_id FROM todos WHERE status IN (0, 2)"
  ).all();
  let anySuccess = userRows.length === 0; // 沒有對象也視為當日完成，避免整天重查

  for (const row of userRows) {
    const userId = row.user_id;
    try {
      const allTodos = await getTodos(env, userId, 0);

      // 過濾：週期任務以「範圍內是否會發生」判斷（與 /list 同語意，過期 remind_at 不再漏掉）；
      // 單次任務以 remind_at 落在範圍內判斷
      const filtered = allTodos.filter(t => {
        if (t.cron_rule && t.remind_at > 0) {
          return recurringMatchesRange(t.cron_rule, timeRange.start, timeRange.end);
        }
        return t.remind_at >= timeRange.start && t.remind_at <= timeRange.end;
      });

      // 昨日以前未完成的單次任務（早報專屬提醒區塊；早報範圍是今天 00:00 起，
      // 逾期任務不在主清單範圍內，需要獨立區塊才看得到）
      let overdueRows = [];
      if (isMorning) {
        try {
          const { results } = await env.DB.prepare(
            "SELECT * FROM todos WHERE user_id = ? AND status IN (0, 2) AND remind_at > 0 AND remind_at < ? AND (cron_rule IS NULL OR cron_rule = '' OR cron_rule = 'none' OR cron_rule = 'null') ORDER BY remind_at ASC LIMIT 20"
          ).bind(userId, timeRange.start).all();
          overdueRows = results || [];
        } catch (e) {
          logSendError("每日報告", `查詢逾期任務 ${userId}`, e);
        }
      }

      if (filtered.length > 0 || overdueRows.length > 0) {
        let msg = `📋 <b>${isMorning ? '今日待辦' : '今晚及明日待辦'}</b>\n\n`;

        // 顯示/排序用有效時間（週期任務取範圍內下次發生日；無期限放最後）
        const effTs = new Map();
        for (const t of filtered) {
          if (t.cron_rule && t.remind_at > 0) {
            const occ = nextOccurrenceInRange(t.cron_rule, t.remind_at, timeRange.start, timeRange.end);
            effTs.set(t.id, occ !== null ? occ : t.remind_at);
          } else {
            effTs.set(t.id, t.remind_at);
          }
        }
        // 排序：考試/作業優先（tier 制），同 tier 照時間，無期限放最後
        filtered.sort((a, b) => compareTasksByPriority(a, b, (t) => effTs.get(t.id)));

        filtered.forEach((t, i) => {
          let timeStr = '';
          if (t.cron_rule) {
            const showTs = effTs.get(t.id);
            if (showTs > 0) {
              timeStr = (t.all_day ? formatDateSmart(showTs) + " (全天)" : formatDateTimeSmart(showTs)) + ` (${translateRule(t.cron_rule)})`;
            } else {
              timeStr = `🔄 ${translateRule(t.cron_rule)}`;
            }
          } else if (t.all_day) {
            timeStr = '☀️ ' + formatDateSmart(t.remind_at) + ' (全天)';
          } else if (t.remind_at !== -1) {
            timeStr = formatDateTimeSmart(t.remind_at);
          } else {
            timeStr = '無期限';
          }
          msg += `${i + 1}. ${getTaskTier(t.task) === 0 ? "📌 " : ""}[${timeStr}] ${escapeHtml(t.task)}\n`;
        });

        if (overdueRows.length > 0) {
          msg += `\n⚠️ <b>昨日以前未完成 (${overdueRows.length} 筆)</b>\n`;
          overdueRows.slice(0, 10).forEach((t, i) => {
            msg += `${i + 1}. [${formatDateSmart(t.remind_at)}] ${escapeHtml(t.task)}\n`;
          });
          if (overdueRows.length > 10) msg += `…等共 ${overdueRows.length} 筆喵\n`;
        }

        // 逾期任務一鍵掃掉：callback 時會重查「當下」的逾期單次任務（同早報定義）逐筆標完成
        const reportKb = overdueRows.length > 0
          ? new InlineKeyboard().text(`🧹 這些都完成了（${overdueRows.length} 筆）`, "odone|0")
          : null;
        const reportKbExtra = reportKb ? { reply_markup: reportKb } : {};

        // 產生圖片並發送（PNG 照片；失敗退回純文字）
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
          let png = null;
          try {
            png = await generateSchedulePng(filtered.length ? filtered : overdueRows, {
              title: reportTitle,
              dateStr: dateStr,
              type: reportType,
            });
          } catch (genErr) {
            logSendError("每日報告", "PNG 產生", genErr);
          }
          if (png) {
            try {
              // caption 上限 1024，太長就只送圖，文字另外分批送（sendSchedulePhoto 內處理）
              await sendSchedulePhoto(bot.api, userId, png, msg, reportKbExtra);
            } catch (sendErr) {
              logSendError("每日報告", "照片發送", sendErr);
              const parts = chunkText(msg, 4096);
              for (let i = 0; i < parts.length; i++) {
                await sendBotMessageHtml(bot.api, userId, parts[i], (i === parts.length - 1 && reportKb) ? { reply_markup: reportKb } : {});
              }
            }
          } else {
            const parts = chunkText(msg, 4096);
            for (let i = 0; i < parts.length; i++) {
              await sendBotMessageHtml(bot.api, userId, parts[i], (i === parts.length - 1 && reportKb) ? { reply_markup: reportKb } : {});
            }
          }
        } catch (imgErr) {
          logSendError("每日報告", "圖片流程", imgErr);
          for (const part of chunkText(msg, 4096)) {
            await sendBotMessageHtml(bot.api, userId, part);
          }
        }
      }

      anySuccess = true; // 該用戶流程走完（發送成功或無內容）
    } catch (e) {
      logSendError("每日報告", `處理 ${userId}`, e);
    }
  }

  if (anySuccess) {
    // 先寫記憶體備忘再寫 DB：即使 saveReportState 失敗（表不存在等），本 isolate 也不會重發
    dailyReportMemo.set(memoKey, true);
    await saveReportState(env, kind, today);
    console.log(`[每日報告] ${kind} 完成 (${today})`);
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
  refreshListView,
  renderHistory,
  sendConfirmation,
  sendBatchConfirmation,
  encodeBatchPayload,
  decodeBatchPayload,
  processScheduledReminders,
  processDailyReports,
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
