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
   - Extract time expressions from user input, but do not calculate exact dates.
   - If user says specific time (e.g. "9pm", "9:30", "9點"), return just that time: "9:00", "9:30", "9:00".
   - If user says specific date (e.g. "Jan 1st", "1月1號"), return just that date: "01-01", "01-01".
   - If user says both date and time (e.g. "Jan 1st at 9pm"), return both: "2026-01-01T21:00".
   - If no specific time/date mentioned, return null.
3. **rule** (Recurrence):
   - **DEFAULT: null** (This is a one-time task).
   - ONLY use "daily" if user EXPLICITLY says "Every day", "Daily", "Each day".
   - **Weekly mapping (Monday starts at 1):**
     - Use "weekly:1" (Mon), "weekly:2" (Tue), "weekly:3" (Wed), "weekly:4" (Thu), "weekly:5" (Fri), "weekly:6" (Sat), "weekly:7" (Sun).
   - For multiple days:
     - "Mon-Fri" -> "weekly:1,2,3,4,5"
     - "Weekends" -> "weekly:6,7"
     - "Mon, Wed, Fri" -> "weekly:1,3,5"
   - "Tonight at 9pm" -> rule: null.
4. **isAllDay**: true if no specific hour:minute is mentioned (e.g., "Buy milk tomorrow"), OR for events like "Jan 1st" that are typically all-day. For recurring daily/weekly events, set to false unless explicitly all-day.

# USER INPUT:
"${text}"

# OUTPUT FORMAT (JSON Only):
{
  "task": "Clean text without time",
  "time": "Time/Date string as extracted from user input" or null,
  "rule": "daily", "weekly:1,2,3,4,5" (for Mon-Fri), etc., or null,
  "isAllDay": true/false
}
`;
}

function getQueryPrompt(queryText, now) {
  const nowStr = getTaipeiTimeString(now);
  return `
# ROLE: Expert Time Parser
# CURRENT TIME: ${nowStr} (Taipei Time, UTC+8)

# TASK
Parse the user's natural language time description into a precise Unix timestamp range.

# RULES
1. TIMEZONE: Must use Asia/Taipei (UTC+8).
2. DURATION LOGIC:
   - "Today": Start from 00:00:00 to 23:59:59.
   - "Last Week": Calculate the previous Mon-Sun range.
3. OUTPUT: Strictly return a valid JSON object. No conversational filler.

# OUTPUT FORMAT
{
  "start": number, // Unix timestamp in seconds
  "end": number,   // Unix timestamp in seconds
  "label": "string" // Human-readable date range in Chinese
}

# INPUT QUERY
"${queryText}"
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