// email_digest.js - 郵件摘要功能
// 設計原則:
// 1. 信箱連線參數 100% 來自 EMAIL_ACCOUNTS (JSON secret) 或扁平設定 (POP3_*)，程式不綁服務商
// 2. 目前支援 POP3；IMAP 保留插槽（於 POP3_EMAIL fetch 分派處加一個 case 即可）
// 3. 送 AI 前內容先去識別化，生成後再複掃一次
// 4. 發現「待辦型」任務自動加入天天待辦清單（報名型只摘要）
// 5. 郵件摘要呼叫強模型 (預設 openai/gpt-6-luna)；一般一句話辨識維持輕量 openai-fast
import * as chrono from "chrono-node";
import { fetchMail, buildRedactor } from "./pop3.js";
import { addTodosBatch, getEmailState, saveEmailState } from "./db.js";
import { getNowTaipei, localDateToUtcTs, formatDateTimeSmart, formatDateSmart } from "./time.js";
import { callAI } from "./ai.js";
import { parseAITimeExpression } from "./router.js";

const MAX_DIGEST_MAILS = 25;
const LOOKBACK_HOURS_FIRST = 48;
const MAX_MAIL_TEXT = 8000;   // 送 AI 的單信內文上限（抓整信，不再只給片段）
const AI_PARALLEL = 5;        // 一信一呼叫的並行批次大小
const MAX_MSG_CHARS = 3860;

const CATEGORY_EMOJI = {
  "課程": "📚",
  "作業/考試": "📝",
  "行政/系統": "🏛️",
  "社團/活動": "🎪",
  "財務/繳費": "💰",
  "其他": "📌",
};

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function maskUser(u) { const s = String(u || ""); return s.length <= 2 ? "***" : s.slice(0, 2) + "***"; }

function taipeiTodayStr() {
  return getNowTaipei().toISOString().slice(0, 10);
}

// ============== 信箱設定 (全上游: env/secrets) ==============
export function getMailboxes(env, fallbackChatId = null) {
  let list = [];
  const raw = env.EMAIL_ACCOUNTS;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const a of arr) {
          if (!a || !a.host || !a.user) continue;
          const name = String(a.name || (maskUser(a.user) + "@" + String(a.host)));
          list.push({
            key: String(a.name || name),
            name,
            protocol: String(a.protocol || "pop3").toLowerCase(),
            host: String(a.host),
            port: parseInt(a.port || 995),
            mode: String(a.mode || "tls").toLowerCase(),
            user: String(a.user),
            pass: String(a.pass || ""),
            chatId: a.chat_id ? String(a.chat_id) : (fallbackChatId || null),
            lookbackHours: a.lookback_hours != null ? parseFloat(a.lookback_hours) : LOOKBACK_HOURS_FIRST,
            maxMails: a.max_mails != null ? parseInt(a.max_mails) : MAX_DIGEST_MAILS,
            redact: Array.isArray(a.redact_patterns) ? a.redact_patterns.map(String) : [],
            emailModel: String(a.email_model || env.EMAIL_AI_MODEL || "openai/gpt-6-luna"),
            enabled: a.enabled !== false,
          });
        }
      }
    } catch (e) {
      console.error("[email_digest] EMAIL_ACCOUNTS 解析失敗:", e.message);
    }
  }
  // 扁平設定 fallback (最少只要 POP3_HOST/POP3_USER/POP3_PASS 三個 secret 就能動)
  if (!list.length && env.POP3_HOST && env.POP3_USER) {
    list.push({
      key: "default",
      name: env.POP3_LABEL || "學校信箱",
      protocol: String(env.POP3_PROTOCOL || "pop3").toLowerCase(),
      host: env.POP3_HOST,
      port: parseInt(env.POP3_PORT || 995),
      mode: String(env.POP3_TLS || "tls").toLowerCase(),
      user: env.POP3_USER,
      pass: env.POP3_PASS || "",
      chatId: fallbackChatId,
      lookbackHours: parseFloat(env.POP3_LOOKBACK_HOURS || LOOKBACK_HOURS_FIRST),
      maxMails: parseInt(env.EMAIL_MAX_MAILS || MAX_DIGEST_MAILS),
      redact: [],
      emailModel: env.EMAIL_AI_MODEL || "openai/gpt-6-luna",
      enabled: true,
    });
  }
  // 目前僅支援 pop3；imap 配置先保留在 EMAIL_ACCOUNTS 裡（未來擴充不需要改設定格式）
  return list.filter((m) => m.enabled && m.protocol === "pop3");
}

// ============== AI 摘要 prompt（一信一呼叫） ==============

// 主旨清理：展開折行、壓縮空白、去 [Image N] 佔位
//（信件 header 折行常把單字切斷，如 "Progra\r\nmming" → 原樣顯示變 "Progra mming"）
export function cleanSubject(s) {
  return String(s || "")
    .replace(/\[Image\s*\d+\]/gi, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildMailPrompt(mail, idx, total, nowStr) {
  return `
# SYSTEM ROLE: Email digest assistant (Traditional Chinese output)
# CURRENT TIME (Taipei, UTC+8): ${nowStr}
# 你這次只處理第 ${idx}/${total} 封信，專注把這封讀完整。

# 信件內容:
寄件者: ${mail.from}
主旨: ${mail.subject}
時間: ${mail.sent}
內文:
"""
${mail.text}
"""

# 輸出欄位:
1. category: 只能選一個："課程", "作業/考試", "行政/系統", "社團/活動", "財務/繳費", "其他"
2. title: 繁中短標題 ≤16 字（例：「程設作業8發布」「註冊費繳納通知」），不要照抄英文主旨
3. summary: 繁中 1 句 ≤40 字。把內文裡所有「截止/期限/due/以前/前繳交/必須於…前/last date」的日期時間逐段掃過，
   有期限就必須明確寫出（例：「11/24(二) 08:00 前繳交程式作業」）。學生只看摘要就要知道幾號前要做完。不得發明信中沒有的資訊。
4. should_todo: 布林值。
   - true = 「待辦型」：不需要報名/出席，只要在某時間前「主動完成某動作」（繳作業/報告、繳費、回填表單、領文件、體檢…）。
   - false = 「報名型/參考型」：要先報名才生效的活動講座、純宣導、純參考公告。
   判斷不確定 → false（寧可只摘要不自動加待辦）。
5. deadline: 要主動完成的期限。should_todo=true 時原則上必填——把內文裡出現的每一個日期時間都檢查一遍，
   取與「要完成的動作」綁定的那個（多個時取最終截止）。格式例："2026-11-24 08:00"、"Friday 23:59"、"tomorrow"。
   硬規則：內文若出現「截止日期／截止時間／繳交期限／Due date／deadline」任一字樣，
   必須提取緊接其後的日期時間填入 deadline，此情況下 summary 必須寫出該日期，
   禁止輸出「期限未見於文字內容」。
   只有整封信真的完全找不到任何期限資訊才允許 null，此時 summary 結尾寫「期限未見於文字內容（可能在圖片或附件）」。
   禁止捏造：期限必須真的出現在信件內容中。
6. task_hint: 只在 should_todo=true 且能一句話明確敘述時寫（繁中、≤25字、動賓結構、不含時間詞，例："繳交程式作業"）。否則 null。

# OUTPUT FORMAT (JSON Only，不要 markdown 圍籬):
{"category":"作業/考試","title":"...","summary":"...","should_todo":true,"deadline":"2026-11-24 08:00","task_hint":"繳交程式作業"}`;
}

// deadline 文字 → { ts, allDay }
export function parseDeadlineText(text, refClockLocal) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  let d = null;
  try { d = parseAITimeExpression(s, refClockLocal); } catch { d = null; }
  if (!d) { try { const c = chrono.parse(s, refClockLocal); d = c.length ? c[0].date() : null; } catch { d = null; } }
  if (!d || isNaN(d.getTime())) return null;
  const hasTime = /\d{1,2}:\d{2}/.test(s);
  if (!hasTime) {
    d.setHours(23, 59, 0, 0);
    return { ts: localDateToUtcTs(d), allDay: 1 };
  }
  return { ts: localDateToUtcTs(d), allDay: 0 };
}

// ============== 摘要後 items ==============

export async function buildDigestItems(env, mails, aiDigest, redactor, nowTs) {
  const refClock = getNowTaipei();
  let existing = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT task, remind_at FROM todos WHERE status IN (0, 2) AND remind_at > 0 ORDER BY remind_at DESC LIMIT 500"
    ).all();
    existing = results || [];
  } catch {}

  const items = [];
  for (let i = 0; i < aiDigest.length; i++) {
    const row = aiDigest[i] || {};
    let mailIdx = i;
    const idNum = parseInt(String(row.id || "").replace(/\D/g, ""), 10) - 1;
    if (Number.isInteger(idNum) && idNum >= 0 && idNum < mails.length) mailIdx = idNum;
    const mail = mails[mailIdx];
    if (!mail) continue;
    if (!row.category && !row.summary && !row.deadline && !row.task_hint) continue;

    // AI 輸出的內容再過一次去識別化（AI 重寫進來的文字）
    const summary = redactor(String(row.summary || "")).slice(0, 120);
    const hint = row.task_hint ? redactor(String(row.task_hint)).slice(0, 60) : "";
    // 報名型/參考型 (should_todo=false) 一律只摘要，不自動加待辦
    const shouldTodo = row.should_todo === undefined ? true : !!row.should_todo;
    const dl = row.deadline ? parseDeadlineText(String(row.deadline), refClock) : null;

    const item = {
      mailId: String(mailIdx + 1).padStart(3, "0"),
      category: CATEGORY_EMOJI[row.category] ? String(row.category) : "其他",
      title: redactor(String(row.title || "")).slice(0, 24),
      summary: summary || "(無摘要)",
      subject: mail.subject || "",
      from: mail.from || "",
      sent: mail.sent || "",
      deadlineText: row.deadline ? String(row.deadline) : null,
      shouldTodo,
      task: null,
      remindAt: -1,
      cronRule: null,
      allDay: 0,
      valid: false,
    };
    // 自動加入條件：待辦型 + 有明確期限 + 有明確行動句 + 未來合理時間 + 不與既有重複
    if (dl && dl.ts > nowTs - 3600 && shouldTodo && hint) {
      item.task = hint.trim();
      item.remindAt = dl.ts;
      item.allDay = dl.allDay;
      const dup = existing.some((t) => t.task === item.task && Number(t.remind_at) === item.remindAt);
      if (item.task && !dup) item.valid = true;
    } else if (dl) {
      // 報名型/參考型但有期限 → 保留期限顯示做摘要用途
      item.deadlineTs = dl.ts;
      item.deadlineAllDay = dl.allDay;
    }
    items.push(item);
  }
  return items;
}

// ============== 訊息渲染 ==============

export function renderDigestMessage(mailboxName, todayStr, items) {
  // 有期限的（已加入待辦或僅摘要但有期限）排前面，依時間先後；無期限的放後面
  const deadlineTs = (it) => (it.valid && it.remindAt > 0 ? it.remindAt : (it.deadlineTs > 0 ? it.deadlineTs : 0));
  const sorted = items.map((it, idx) => ({ it, idx })).sort((a, b) => {
    const da = deadlineTs(a.it), db = deadlineTs(b.it);
    if (da > 0 && db > 0) return da - db || a.idx - b.idx;
    if (da > 0) return -1;
    if (db > 0) return 1;
    return a.idx - b.idx;
  }).map((x) => x.it);
  const catTotal = new Map();
  for (const it of sorted) catTotal.set(it.category, (catTotal.get(it.category) || 0) + 1);
  const catSeen = new Set();
  let msg = `📬 <b>${esc(mailboxName)} ・ Email 摘要</b>\n🗓 ${esc(todayStr)} ・ ${items.length} 封\n`;
  let n = 0;
  for (const it of sorted) {
    if (!catSeen.has(it.category)) {
      catSeen.add(it.category);
      const emoji = CATEGORY_EMOJI[it.category] || "📌";
      msg += `\n${emoji} <b>${esc(it.category)} (${catTotal.get(it.category)})</b>\n`;
    }
    n++;
      const title = it.title || cleanSubject(it.subject) || "(無主旨)";
      msg += `${n}. <b>${esc(title)}</b>\n`;
      msg += `   ${esc(it.summary)}\n`;
      msg += `   ✉ ${esc(it.from || "")}${it.sent ? " · " + esc(it.sent) : ""}\n`;
      if (it.valid && it.remindAt > 0 && it.added !== false) {
        const timeStr = it.allDay ? `${formatDateSmart(it.remindAt)} (全天)` : formatDateTimeSmart(it.remindAt);
        msg += `   ✅ 已自動加入待辦：<b>${esc(it.task)}</b>\n`;
        msg += `      到期：${esc(timeStr)}\n`;
      } else if (it.valid && it.remindAt > 0) {
        const timeStr = it.allDay ? `${formatDateSmart(it.remindAt)} (全天)` : formatDateTimeSmart(it.remindAt);
        msg += `   ⚠️ 待辦加入失敗：<b>${esc(it.task)}</b>\n`;
        msg += `      到期：${esc(timeStr)}\n`;
      } else if (it.deadlineText) {
        const tag = it.shouldTodo === false ? "報名/參考型，僅摘要" : "無法轉待辦，僅摘要";
        msg += `   ⏰ 期限：<b>${esc(it.deadlineText)}</b>（${tag}）\n`;
      }
  }
  // 安全截斷：只能整行切，避免把 <b>...</b> 切一半導致 Telegram 400
  if (msg.length > MAX_MSG_CHARS) {
    let out = "", cut = false;
    for (const line of msg.split("\n")) {
      if (out.length + line.length + 1 > MAX_MSG_CHARS) { cut = true; break; }
      out += (out ? "\n" : "") + line;
    }
    msg = out + (cut ? "\n…（以下略）" : "");
  }
  return msg;
}

// 內文解不出文字的信（純圖片/附件/解碼失敗）分流：不進 AI，合併成一行提示
// 回傳 { content, blank, note } — note 為空時表示沒有空白信
export function splitBlankMails(mails) {
  const content = mails.filter((m) => !m.bodyEmpty);
  const blank = mails.filter((m) => m.bodyEmpty);
  const note = blank.length
    ? `\n\n⚠️ ${blank.length} 封內文為空（可能只有圖片/附件）：` +
      blank.map((m) => esc(cleanSubject(m.subject) || "(無主旨)")).join("、")
    : "";
  return { content, blank, note };
}

// ============== 單一信箱流程 ==============

const STAGE_LABEL = {
  greeting: "伺服器連線成功但問候語異常",
  user: "使用者名稱被拒",
  pass: "驗證失敗（帳號或密碼）",
  stat: "STAT 失敗",
  session: "連線中斷或協定錯誤",
};

async function processOneMailbox(api, env, mb, { force = false, log = () => {} } = {}) {
  const state = await getEmailState(env, mb.key);
  const today = taipeiTodayStr();
  const nowTs = Math.floor(Date.now() / 1000);
  const knownUids = new Set(state.processed);
  const target = mb.chatId || env.DIGEST_CHAT_ID || null;
  const isFirstRun = state.processed.length === 0;
  const sinceTs = isFirstRun ? nowTs - Math.round(mb.lookbackHours * 3600) : null;

  log(`[${mb.key}] processed=${state.processed.length} lastDate=${state.lastDigestDate} firstRun=${isFirstRun}`);

  if (!force && state.lastDigestDate === today) {
    log(`[${mb.key}] 今日已跑過，跳過`);
    return { key: mb.key, name: mb.name, skipped: true, count: 0 };
  }
  if (!target) {
    log(`[${mb.key}] 沒有 chat 目標（DB 沒有任何 user_id，也沒設 DIGEST_CHAT_ID），跳過`);
    return { key: mb.key, name: mb.name, skipped: true, count: 0 };
  }

  const res = await fetchMail(mb, { knownUids, sinceTs, maxCount: mb.maxMails || MAX_DIGEST_MAILS, full: true });
  if (!res.ok) {
    const stageMsg = STAGE_LABEL[res.stage] || res.stage || "未知錯誤";
    if (target && api) {
      try {
        await api.sendMessage(target, `❌ <b>${esc(mb.name)}</b> 郵件檢查失敗喵：\n${esc(stageMsg)}\n<code>${esc(String(res.error || "")).slice(0, 140)}</code>`, { parse_mode: "HTML" });
      } catch {}
    }
    return { key: mb.key, name: mb.name, skipped: false, ok: false, stage: res.stage, error: String(res.error || "") };
  }

  if (!res.mails.length) {
    await saveEmailState(env, mb.key, [...knownUids], today);
    return { key: mb.key, name: mb.name, skipped: false, ok: true, count: 0 };
  }

  // 去識別化: 全域 REDACT_PATTERNS (換行分隔) + 信箱設定內的 patterns
  const extraPatterns = [
    ...(env.REDACT_PATTERNS ? String(env.REDACT_PATTERNS).split(/\r?\n/) : []),
    ...mb.redact,
  ];
  const redactor = buildRedactor(extraPatterns);

  // 內文解不出文字的信（純圖片/附件/解碼失敗）不進 AI：合併成一行提示，省下 N 次呼叫，
  // 也避免摘要被「空白郵件/空白信件」這類垃圾條目佔滿
  const { content: contentMails, blank: blankMails, note: blankNote } = splitBlankMails(res.mails);

  const aiMails = contentMails.map((m) => ({
    from: redactor(m.from),
    subject: redactor(cleanSubject(m.subject)),
    sent: m.ts ? new Date(m.ts * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-") : "",
    text: redactor(m.text || "").slice(0, MAX_MAIL_TEXT),
  }));

  const nowStr = new Date(nowTs * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-");

  // 一信一呼叫（AI_PARALLEL 封一批並行）：每封信拿到完整內文與完整注意力，
  // 單封失敗只影響該封（標記 AI 摘要失敗），不再像舊版 25 封擠一個 prompt 集體降質
  const rows = new Array(aiMails.length).fill(null);
  for (let i = 0; i < aiMails.length; i += AI_PARALLEL) {
    const chunk = aiMails.slice(i, i + AI_PARALLEL);
    const settled = await Promise.allSettled(chunk.map((m, j) =>
      callAI(env, buildMailPrompt(m, i + j + 1, aiMails.length, nowStr), { model: mb.emailModel })
    ));
    settled.forEach((r, j) => {
      const idx = i + j;
      if (r.status === "fulfilled" && r.value?.json && typeof r.value.json === "object") {
        rows[idx] = { id: String(idx + 1).padStart(3, "0"), ...r.value.json };
      } else {
        const reason = r.status === "rejected" ? (r.reason?.message || String(r.reason || "")) : "無 JSON 回覆";
        console.error(`[email_digest][${mb.key}] 信件#${idx + 1} AI 失敗: ${reason}`);
      }
    });
  }
  const aiJson = rows.filter(Boolean);
  const failedCount = rows.length - aiJson.length;

  const items = aiJson.length ? await buildDigestItems(env, contentMails, aiJson, redactor, nowTs) : [];

  // 先把待辦寫進 DB，再渲染訊息 — 這樣訊息裡的 ✅ 才反映真實結果
  const validItems = items.filter((i) => i.valid);
  let addErrMsg = null;
  if (validItems.length) {
    try {
      await addTodosBatch(env, String(target), validItems.map((v) => ({ task: v.task, remindAt: v.remindAt, cronRule: null, allDay: v.allDay })));
      validItems.forEach((v) => { v.added = true; });
    } catch (e) {
      console.error(`[email_digest][${mb.key}] 自動加入待辦失敗:`, e);
      addErrMsg = String(e?.message || e);
      validItems.forEach((v) => { v.added = false; });
    }
  }

  //組訊息
  let msg;
  if (items.length) {
    msg = renderDigestMessage(mb.name, today, items);
    if (failedCount > 0) msg += `\n\n⚠️ ${failedCount} 封 AI 摘要失敗（未列入清單）`;
    if (blankNote) msg += blankNote;
    if (validItems.length && addErrMsg === null) {
      msg += `\n\n✅ <b>已自動加入 ${validItems.length} 筆待辦喵～</b>（之後可用 /list 檢視，🗑️ 認定誤植可刪除）`;
    } else if (addErrMsg !== null) {
      msg += `\n\n⚠️ 自動加入待辦失敗喵：<code>${esc(addErrMsg).slice(0, 120)}</code>`;
    }
  } else if (!contentMails.length && blankMails.length) {
    // 全是空白信：只送合併提示（不送「AI 摘要無回覆」的原始清單）
    msg = `📬 <b>${esc(mb.name)} ・ Email 摘要</b>\n🗓 ${esc(today)} ・ ${res.mails.length} 封` + blankNote;
  } else {
    msg = `📬 <b>${esc(mb.name)} ・ Email 摘要</b>\n🗓 ${esc(today)} ・ ${res.mails.length} 封 (AI 摘要無回覆，附原始清單)\n\n` +
      res.mails.map((m, i) => `${i + 1}. ${esc(cleanSubject(m.subject)) || "(無主旨)"}\n   ✉ ${esc(m.from)}`).join("\n");
    if (blankNote) msg += blankNote;
  }

  if (target && api) {
    // HTML 解析失敗的保險：改送純文字（剝掉標籤），確保使用者至少收得到內容
    try {
      await api.sendMessage(target, msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error(`[email_digest][${mb.key}] HTML 送出失敗，改純文字重送:`, e.message);
      try {
        const plain = msg.replace(/<[^>]+>/g, "");
        await api.sendMessage(target, plain);
      } catch (e2) {
        console.error(`[email_digest][${mb.key}] 送出摘要失敗:`, e2);
        return { key: mb.key, name: mb.name, skipped: false, ok: false, stage: "send", error: String(e2?.message || e2) };
      }
    }
  }

  const newUids = res.mails.map((m) => m.uid);
  await saveEmailState(env, mb.key, [...state.processed, ...newUids], today);
  return { key: mb.key, name: mb.name, skipped: false, ok: true, count: res.mails.length, digestItems: items.length, autoAdded: validItems.length, addErrMsg };
}

// ============== 排程 / 手動入口 ==============

export async function runEmailDigest(api, env, { force = false, log = () => {}, chatId = null } = {}) {
  // 單人使用情境：cron 觸發時沒有訊息來源，自動從 DB 推導 chat 目標
  // （私人聊天中 chat_id == user_id，提醒/每日報告也是這樣推導的）
  let effectiveChatId = chatId;
  if (!effectiveChatId) {
    try {
      const { results } = await env.DB.prepare("SELECT DISTINCT user_id FROM todos LIMIT 1").all();
      if (results && results.length) {
        effectiveChatId = String(results[0].user_id);
        log(`chat 目標自動推導：${effectiveChatId}`);
      }
    } catch (e) {
      log(`chat 目標自動推導失敗：${e.message}`);
    }
  }
  const mbs = getMailboxes(env, effectiveChatId);
  if (!mbs.length) return { results: [], note: "no mailboxes configured" };
  const results = [];
  for (const mb of mbs) {
    try {
      results.push(await processOneMailbox(api, env, mb, { force, log }));
    } catch (e) {
      console.error(`[email_digest][${mb.key}]`, e);
      results.push({ key: mb.key, name: mb.name, skipped: false, ok: false, stage: "unknown", error: String(e?.message || e) });
    }
  }
  return { results };
}

// /email_now 手動觸發（本機 / bot 對話框中的 ctx 也可以）
// 單飛機制：同一個 chat 同時只跑一輪，避免並發造成重複抓信/重複加入待辦
const emailNowRunning = new Set();

export async function handleEmailNow(ctx, env) {
  const runKey = String(ctx.chat.id);
  if (emailNowRunning.has(runKey)) {
    return ctx.reply("⏳ 上一輪摘要還在跑喵（約 10-30 秒），先等它完成再按喔");
  }
  emailNowRunning.add(runKey);
  const wait = await ctx.reply("📬 喵～正在檢查信箱並做 AI 摘要…（約 10-30 秒）");
  // 佔位訊息一定收回：HTML 編輯 → 純文字編輯 → 刪除後改發新訊
  const finish = async (text) => {
    try {
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, text, { parse_mode: "HTML" });
      return;
    } catch {}
    const plain = text.replace(/<[^>]+>/g, "");
    try {
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, plain);
      return;
    } catch {}
    try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    try { await ctx.reply(plain); } catch {}
  };
  try {
    const { results } = await runEmailDigest(ctx.api, env, { force: true, log: (s) => console.log("[email_now]", s), chatId: String(ctx.chat.id) });
    const parts = [];
    for (const r of results) {
      if (r.skipped) parts.push(`⏭ <b>${esc(r.name)}</b>：今日摘要已送過，跳過`);
      else if (r.ok) parts.push(`✅ <b>${esc(r.name)}</b>：${r.count} 封新信${r.autoAdded ? `，已自動加入 ${r.autoAdded} 筆待辦` : ""}`);
      else parts.push(`❌ <b>${esc(r.name)}</b>：${esc(r.stage || "")} — <code>${esc(String(r.error || "")).slice(0, 90)}</code>`);
    }
    let summary;
    if (!results.length) summary = `📭 尚未設定任何 Email 信箱喵。\n\n<b>設定方式（二選一）：</b>\n1. 簡單版 secrets：<code>POP3_HOST</code> / <code>POP3_PORT</code> / <code>POP3_TLS</code> / <code>POP3_USER</code> / <code>POP3_PASS</code>\n2. 進階版：<code>EMAIL_ACCOUNTS</code> secret 放 JSON，可設定多個信箱`;
    else summary = `📬 <b>Email 檢查完成喵～</b>\n${parts.join("\n")}`;
    await finish(summary);
  } catch (e) {
    await finish(`❌ 摘要流程異常喵：<code>${esc(String(e?.message || e)).slice(0, 160)}</code>`);
  } finally {
    emailNowRunning.delete(runKey);
  }
}

// /email_status 狀態檢視
export async function handleEmailStatus(ctx, env) {
  const mbs = getMailboxes(env, null);
  if (!mbs.length) {
    return ctx.reply("📭 喵～目前還沒有設定 Email 信箱。\n\n設定請見 /help 的「信箱摘要」段落。", { parse_mode: "HTML" });
  }
  const lines = [];
  for (const mb of mbs) {
    const st = await getEmailState(env, mb.key);
    lines.push(`📪 <b>${esc(mb.name)}</b> (key 先別管)\n   ⚙️ ${esc(mb.protocol)}://${esc(maskUser(mb.user))}@${esc(mb.host)}:${mb.port} (${esc(mb.mode)})\n   🕐 上次摘要：${esc(st.lastDigestDate || "還沒跑過")}\n   📂 已追蹤 UID：${st.processed.length}`);
  }
  const redNote = env.REDACT_PATTERNS ? `有設定` : "使用內建預設";
  return ctx.reply(`📬 <b>Email 摘要狀態喵～</b>\n\n${lines.join("\n")}\n\n🗄 設定來源：${env.EMAIL_ACCOUNTS ? "<code>EMAIL_ACCOUNTS</code> (JSON)" : "扁平設定 (POP3_*)"}\n🤖 摘要模型：${esc(mbs[0].emailModel)}\n🈸 去識別化：${redNote}`, { parse_mode: "HTML" });
}

// /email_raw 診斷：把 AI 實際吃到的主旨+內文原樣貼出來（不寫狀態、不影響 processed UIDs）
// 用法：/email_raw [N] — N 抓幾封（預設 5、上限 15）
export async function handleEmailRaw(ctx, env) {
  const mbs = getMailboxes(env, String(ctx.chat.id));
  if (!mbs.length) {
    return ctx.reply("📭 喵～還沒設定信箱，設定方式見 /help 的「信箱摘要」段落。");
  }
  const mb = mbs[0];
  // ctx.match 是指令後面的參數字串（grammy）；沒給就用預設 5
  const argN = parseInt(String(ctx.match || "").trim(), 10);
  const maxCount = Number.isInteger(argN) && argN > 0 ? Math.min(argN, 15) : 5;
  const wait = await ctx.reply(`🔍 <b>${esc(mb.name)}</b> 抓最近 ${maxCount} 封信，看 AI 實際收到的內容…`, { parse_mode: "HTML" });
  try {
    const res = await fetchMail(mb, { knownUids: new Set(), maxCount, full: true });
    if (!res.ok) {
      const t = `❌ 抓信失敗喵：${esc(String(res.error || "")).slice(0, 280)}`;
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, t).catch(() => {});
      return;
    }
    if (!res.mails.length) {
      await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "📭 信箱裡沒有信喵").catch(() => {});
      return;
    }
    for (let i = 0; i < res.mails.length; i++) {
      const m = res.mails[i];
      const body = String(m.text || "").slice(0, 900);
      const total = String(m.text || "").length;
      const emptyMark = m.bodyEmpty ? " ⚠️<b>信件本體解不出文字</b>（以下僅主旨）" : "";
      const msg = `📥 <b>信件 ${i + 1}/${res.mails.length}</b>（AI 實際輸入，去噪後 ${total} 字）${emptyMark}\n` +
        `主旨：${esc(cleanSubject(m.subject)) || "(無主旨)"}\n寄件：${esc(m.from)}\n時間：${esc(m.date || "")}\n` +
        `─────────────\n<code>${esc(body) || "(空的！這就是摘要抓不到資訊的原因)"}</code>`;
      try {
        await ctx.reply(msg, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(`信件 ${i + 1}（純文字）\n主旨：${cleanSubject(m.subject)}\n\n${body}`).catch(() => {});
      }
    }
    try { await ctx.api.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ 診斷失敗：${esc(String(e?.message || e)).slice(0, 200)}`).catch(() => {});
  }
}
