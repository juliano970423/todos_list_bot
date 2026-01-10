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
1. **task**: Extract the core activity. Remove time keywords (e.g., "remind me", "tomorrow", "at 9pm", "提醒我", "記得", "幫我", "要").
2. **time**:
   - Extract time expressions from user input, but do not calculate exact dates/times. Instead, return a parseable format for the program to calculate. Use English formats for better parsing.
   - If user says specific time (e.g. "9pm", "9:30", "9點", "晚上8點58分"), return in format like: "21:00", "21:30", "21:00", "20:58".
   - If user says specific date (e.g. "Jan 1st", "1月1號", "兩天後", "後天", "明天", "今天", "下週一"), return in English parseable format like: "Jan 1st", "January 1st", "tomorrow", "today", "next Monday".
   - For relative time expressions like "N天後" (N days later), "N週後" (N weeks later), "N個月後" (N months later), "N年後" (N years later), return in English parseable format: "in 2 days" for "兩天後", "in 1 week" for "一週後", "in 1 month" for "一個月後", "in 1 year" for "一年後".
   - For "今天" (today), return in English parseable format: "today".
   - For "明天" (tomorrow), return in English parseable format: "tomorrow".
   - For "後天" (the day after tomorrow), return in English parseable format: "in 2 days".
   - If user says both date and time (e.g. "Jan 1st at 9pm", "兩天後晚上9點", "今天下午8點52分"), return in English parseable format: "Jan 1st 21:00", "in 2 days 20:52", "today 20:52", "tomorrow 20:52".
   - If no specific time/date mentioned, return null.
3. **rule** (Recurrence):
   - **DEFAULT: null** (This is a one-time task).
   - CRITICAL: If a specific date is mentioned (e.g., "1月1號", "Jan 1st", "兩天後", "後天", "明天") *without any explicit recurrence keywords* (like "每年", "每週", "每日"), the 'rule' MUST be 'null'. Do NOT infer recurrence from specific dates alone.
   - CRITICAL: For relative time expressions like "N天後" (N days later), "N週後" (N weeks later), "N個月後" (N months later), "N年後" (N years later), the 'rule' MUST be 'null'. These are ONE-TIME events, NOT recurring.
   - ONLY use "daily" if user EXPLICITLY says "Every day", "Daily", "Each day", "每天".
   - ONLY use "weekly:X" if user EXPLICITLY says "Every week on X", "每周X", "每週X".
   - ONLY use "weekly:1,2,3,4,5" if user says "週一到週五", "Monday to Friday", "Mon-Fri".
   - ONLY use "weekly:1,2,3,4,5,6" if user says "週一到週六".
   - ONLY use "weekly:6,7" if user says "週末", "weekends".
   - ONLY use "monthly:X" if user EXPLICITLY says "Every month on X", "每月X".
   - ONLY use "yearly:X" if user EXPLICITLY says "Every year on X", "每年X", "每年的X".
   - "Tonight at 9pm" -> rule: null.
4. **isAllDay**: true if no specific hour:minute is mentioned (e.g., "Buy milk tomorrow"), OR for events like "Jan 1st" that are typically all-day. For recurring daily/weekly events, set to false unless explicitly all-day.

# USER INPUT:
"${text}"

# OUTPUT FORMAT (JSON Only):
{
  "task": "Clean text without time",
  "time": "Time/Date string as extracted from user input" or null,
  "rule": "daily", "weekly:1,2,3,4,5", "monthly:X", "yearly:X", etc., or null,
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
   - "Today" or "今天": Start from 00:00:00 to 23:59:59.
   - "Yesterday" or "昨天": Start from previous day 00:00:00 to 23:59:59.
   - "This Week" or "本週": Start from Monday 00:00:00 to Sunday 23:59:59.
   - Date ranges like "2025/12/27": Start from 00:00:00 to 23:59:59 on that day.
3. OUTPUT: Strictly return a valid JSON object. No conversational filler or comments.
4. LABEL LANGUAGE: The "label" field in the output must be in Chinese (中文), not English. Examples:
   - For "today" or "今天": label should be "今天"
   - For "yesterday" or "昨天": label should be "昨天"
   - For "this week" or "本週": label should be "本週"

# OUTPUT FORMAT (Return JSON only, no other text):
{
  "start": number,
  "end": number,
  "label": "string"
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