// ai.js - AI 處理模組
import * as chrono from "chrono-node";

// 台北時間偏移量 (分鐘)
const TAIPEI_OFFSET = 8 * 60;

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

// 本地時間解析
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

export {
  getTaskPrompt,
  getQueryPrompt,
  callAI,
  parseTimeLocally,
  TAIPEI_OFFSET
};