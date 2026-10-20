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
const MAX_SNIPPET = 700;
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

// ============== AI 摘要 prompt ==============

function buildPrompt(mails, nowStr) {
  const items = mails.map((m, i) => ({
    id: String(i + 1).padStart(3, "0"),
    from: (m.from || "").slice(0, 80),
    subject: (m.subject || "").slice(0, 160),
    sent: m.sent || "",
    snippet: (m.snippet || "").slice(0, MAX_SNIPPET),
  }));
  return `
# SYSTEM ROLE: Email classification & digest assistant (Traditional Chinese output)
# CURRENT TIME (Taipei, UTC+8): ${nowStr}

# OBJECTIVE: 為每一封信產生分類/摘要/期限/是否可直接轉為待辦。輸出讓學生一分鐘看完就知道今天要做什麼。

# 信件內容 mailList (JSON):
${JSON.stringify(items, null, 1)}

# 針對每封信輸出 5 欄 (mailList 的 id 要原樣保留):
1. **category**: 只能選一個分類："課程", "作業/考試", "行政/系統", "社團/活動", "財務/繳費", "其他"
2. **summary**: 繁體中文 1 句，≤ 40 字。講出最關鍵的資訊（課名/日期/繳費金額/地點等）。不要發明信件中沒有的資訊。
3. **should_todo**: 布林值 (true/false)。兩類信件要區分:
   - true = 「待辦型」：收件人「不用另外報名/不出席」、只需要在某時間前「主動完成某動作」的信（例：繳交作業/報告、繳註冊費學費、回填表單/文件、領取文件辦理、服裝儀容檢查、書面通知要修正）。
   - false = 「報名型/參考型」：要「先報名才生效」的活動講座營隊（最後去不去由自己決定的）、純宣導通知、純參考公告。
   判斷不確定 → false（寧可只摘要不加入待辦）。
4. **deadline**: 只有「要主動完成的期限/屆日」才填（作業截止日、繳費截止日、報名截止日都可以填，供摘要顯示），用英文可解析格式:
   - 相對:"tomorrow", "in 2 days", "next Monday"
   - 星期: "Friday" 或 "Friday 23:59"
   - 明確日期: "January 15" / "2027-01-15" / "2027-01-15 23:59"
   其餘一律 null（寧可漏掉, 不可捏造）。
5. **task_hint**: 只在 should_todo=true 且能一句話明確敘述時寫（繁中、≤25字、動賓結構、不含時間詞，例："繳交資演習題第1回"、"繳納註冊費"）。報名型/無明確動作 → null。

# 規則
- 全部繁體中文輸出（deadline/格式欄保留英文）。
- 一封信一條；id 與 mailList 對不上時仍然保留原樣 id。
- snippet 通常是主旨+前幾行的純文字化碎訊息，從中抓核心資訊即可。

# OUTPUT FORMAT (JSON Only):
{
  "digest": [
    {"id":"001","category":"作業/考試","summary":"...","should_todo":true,"deadline":"Friday 23:59" or null,"task_hint":"..." or null}
  ]
}`;
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
      "SELECT task, remind_at FROM todos WHERE status = 0 AND remind_at > 0 ORDER BY remind_at DESC LIMIT 500"
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
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.category)) groups.set(it.category, []);
    groups.get(it.category).push(it);
  }
  let msg = `📬 <b>${esc(mailboxName)} ・ Email 摘要</b>\n🗓 ${esc(todayStr)} ・ ${items.length} 封\n`;
  let n = 0;
  for (const [cat, group] of groups) {
    const emoji = CATEGORY_EMOJI[cat] || "📌";
    msg += `\n${emoji} <b>${esc(cat)} (${group.length})</b>\n`;
    for (const it of group) {
      n++;
      msg += `${n}. <b>${esc(it.subject) || "(無主旨)"}</b>\n`;
      msg += `   ${esc(it.summary)}\n`;
      msg += `   ✉ ${esc(it.from || "")}${it.sent ? " · " + esc(it.sent) : ""}\n`;
      if (it.valid && it.remindAt > 0) {
        const timeStr = it.allDay ? `${formatDateSmart(it.remindAt)} (全天)` : formatDateTimeSmart(it.remindAt);
        msg += `   ✅ 已自動加入待辦：<b>${esc(it.task)}</b>\n`;
        msg += `      到期：${esc(timeStr)}\n`;
      } else if (it.deadlineText) {
        const tag = it.shouldTodo === false ? "報名/參考型，僅摘要" : "無法轉待辦，僅摘要";
        msg += `   ⏰ 期限：<b>${esc(it.deadlineText)}</b>（${tag}）\n`;
      }
    }
  }
  return msg.slice(0, MAX_MSG_CHARS);
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
    log(`[${mb.key}] 沒有 chat 目標（設 DIGEST_CHAT_ID 或信箱 chat_id），跳過`);
    return { key: mb.key, name: mb.name, skipped: true, count: 0 };
  }

  const res = await fetchMail(mb, { knownUids, sinceTs, maxCount: mb.maxMails || MAX_DIGEST_MAILS, topLines: 120 });
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

  const aiMails = res.mails.map((m) => ({
    from: redactor(m.from),
    subject: redactor(m.subject),
    sent: m.ts ? new Date(m.ts * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-") : "",
    snippet: redactor(m.snippet).slice(0, MAX_SNIPPET),
  }));

  const nowStr = new Date(nowTs * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-");

  let aiJson = null;
  try {
    const ai = await callAI(env, buildPrompt(aiMails, nowStr), { model: mb.emailModel });
    aiJson = ai.json && Array.isArray(ai.json.digest) ? ai.json.digest : null;
  } catch (e) {
    console.error(`[email_digest][${mb.key}] AI 失敗:`, e.message);
    if (target && api) {
      try { await api.sendMessage(target, `⚠️ <b>${esc(mb.name)}</b> AI 摘要失敗喵：<code>${esc(String(e.message || "")).slice(0, 160)}</code>`, { parse_mode: "HTML" }); } catch {}
    }
    return { key: mb.key, name: mb.name, skipped: false, ok: false, stage: "ai", error: String(e.message || "") };
  }

  const items = aiJson ? await buildDigestItems(env, res.mails, aiJson, redactor, nowTs) : [];

  //組訊息
  let msg;
  if (items.length) {
    msg = renderDigestMessage(mb.name, today, items);
  } else {
    msg = `📬 <b>${esc(mb.name)} ・ Email 摘要</b>\n🗓 ${esc(todayStr)} ・ ${res.mails.length} 封 (AI 摘要無回覆，附原始清單)\n\n` +
      res.mails.map((m, i) => `${i + 1}. ${esc(m.subject) || "(無主旨)"}\n   ✉ ${esc(m.from)}`).join("\n");
  }

  // 自動把待辦型項目加入清單（使用者不用按按鈕）
  const validItems = items.filter((i) => i.valid);
  let addErrMsg = null;
  if (validItems.length) {
    try {
      await addTodosBatch(env, String(target), validItems.map((v) => ({ task: v.task, remindAt: v.remindAt, cronRule: null, allDay: v.allDay })));
      msg += `\n\n✅ <b>已自動加入 ${validItems.length} 筆待辦喵～</b>（之後可用 /list 檢視，🗑️ 認定誤植可刪除）`;
    } catch (e) {
      console.error(`[email_digest][${mb.key}] 自動加入待辦失敗:`, e);
      addErrMsg = String(e?.message || e);
      msg += `\n\n⚠️ 自動加入待辦失敗喵：<code>${esc(addErrMsg).slice(0, 120)}</code>`;
    }
  }

  if (target && api) {
    try {
      await api.sendMessage(target, msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error(`[email_digest][${mb.key}] 送出摘要失敗:`, e);
      return { key: mb.key, name: mb.name, skipped: false, ok: false, stage: "send", error: String(e?.message || e) };
    }
  }

  const newUids = res.mails.map((m) => m.uid);
  await saveEmailState(env, mb.key, [...state.processed, ...newUids], today);
  return { key: mb.key, name: mb.name, skipped: false, ok: true, count: res.mails.length, digestItems: items.length, autoAdded: validItems.length, addErrMsg };
}

// ============== 排程 / 手動入口 ==============

export async function runEmailDigest(api, env, { force = false, log = () => {}, chatId = null } = {}) {
  const mbs = getMailboxes(env, chatId);
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
export async function handleEmailNow(ctx, env) {
  const wait = await ctx.reply("📬 喵～正在檢查信箱並做 AI 摘要…（約 10-30 秒）");
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
  try {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, summary, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(summary, { parse_mode: "HTML" });
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
