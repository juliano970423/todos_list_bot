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
# SYSTEM ROLE: Time Expression Extractor
# CURRENT TIME (Taipei, UTC+8): ${nowStr}

# OBJECTIVE:
Analyze the USER INPUT and extract the time expression and a human-readable label.

# CRITICAL RULES (Follow Strictly):
1. **timeExpression**: Extract the time/date expression from user input. Return it in a parseable format for the program to calculate the actual timestamps.
   - For specific dates: "today", "tomorrow", "yesterday", "next Monday", "下週一", "下週五", "Jan 1st", "2025/12/27"
   - For relative time: "in 2 days", "2天後", "next week", "下週"
   - For ranges: "this week", "本週", "this month", "本月"
   - DO NOT calculate exact dates or timestamps. Just return the extracted text.
2. **label**: Return a human-readable label in Chinese (中文) describing the time range.
   - Examples: "今天", "明天", "昨天", "下週一", "下週五", "本週", "下週", "3月6日"
   - Must be in Chinese, not English.

# OUTPUT FORMAT (JSON Only):
{
  "timeExpression": "Extracted time expression (e.g., 'tomorrow', '下週一', 'this week')",
  "label": "Chinese label (e.g., '今天', '下週一', '本週')"
}

# USER INPUT:
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
        model: "nova-fast", // 或 "gpt-4o-mini"
        messages: [{ role: "user", content: prompt }],
        jsonMode: true
      }),
      timeout: 15000
    });

    if (!res.ok) {
       const errText = await res.text();
       throw new Error(`API Status ${res.status}: ${errText}`);
    }

    // 先檢查 response 是否為空
    const text = await res.text();
    if (!text || text.trim() === "") {
      throw new Error("API returned empty response");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON response: ${parseError.message}. Raw response: ${text.substring(0, 200)}...`);
    }

    // 檢查 data 結構是否正確
    if (!data || !data.choices || data.choices.length === 0) {
      throw new Error(`Invalid API response structure: missing choices array. Response: ${JSON.stringify(data).substring(0, 200)}...`);
    }

    rawContent = data.choices[0].message?.content || ""; // 保存原始回應

    // 檢查 rawContent 是否為空
    if (!rawContent || rawContent.trim() === "") {
      throw new Error("AI returned empty content");
    }

    // 嘗試清理 Markdown
    const cleanContent = rawContent.replace(/```json|```/g, "").trim();

    // 檢查 cleanContent 是否為空
    if (!cleanContent || cleanContent.trim() === "") {
      throw new Error("Cleaned content is empty after removing Markdown");
    }

    // 直接解析 JSON，不再重試
    let json;
    try {
      json = JSON.parse(cleanContent);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON from AI response: ${parseError.message}. Cleaned content: ${cleanContent.substring(0, 200)}...`);
    }

    return { json, rawContent }; // 回傳物件和原始字串
  } catch (e) {
    // 加強錯誤處理：不再重試，直接報錯
    console.error("AI API Call Error:", e);

    // 將原始回應附加在 error 物件上
    e.rawContent = rawContent;

    // 直接拋出錯誤
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

// 本地查詢時間範圍解析
function parseQueryLocally(queryText) {
  const refDate = new Date(Date.now() + TAIPEI_OFFSET * 60000);
  const text = queryText.toLowerCase();
  const today = new Date(refDate);
  today.setHours(0, 0, 0, 0);

  // 計算當天的開始和結束時間戳（UTC）
  const dayStartTs = Math.floor((today.getTime() - TAIPEI_OFFSET * 60000) / 1000);
  const dayEndTs = dayStartTs + 86400 - 1;

  // 處理 "今天"
  if (text === '今天' || text === 'today') {
    return {
      start: dayStartTs,
      end: dayEndTs,
      label: '今天'
    };
  }

  // 處理 "明天"
  if (text === '明天' || text === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStartTs = Math.floor((tomorrow.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    return {
      start: tomorrowStartTs,
      end: tomorrowStartTs + 86400 - 1,
      label: '明天'
    };
  }

  // 處理 "昨天"
  if (text === '昨天' || text === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStartTs = Math.floor((yesterday.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    return {
      start: yesterdayStartTs,
      end: yesterdayStartTs + 86400 - 1,
      label: '昨天'
    };
  }

  // 處理 "本週" / "this week"
  if (text === '本週' || text === 'this week') {
    const currentDayOfWeek = today.getDay(); // 0 for Sunday, 1 for Monday, ..., 6 for Saturday
    const monday = new Date(today);
    monday.setDate(today.getDate() - (currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1));
    const mondayStartTs = Math.floor((monday.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const sundayEndTs = Math.floor((sunday.getTime() - TAIPEI_OFFSET * 60000) / 1000) + 86400 - 1;
    return {
      start: mondayStartTs,
      end: sundayEndTs,
      label: '本週'
    };
  }

  // 處理 "下週" / "next week"
  if (text === '下週' || text === 'next week') {
    const currentDayOfWeek = today.getDay();
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + (7 - (currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1)));
    const nextMondayStartTs = Math.floor((nextMonday.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    const nextSundayEndTs = Math.floor((nextSunday.getTime() - TAIPEI_OFFSET * 60000) / 1000) + 86400 - 1;
    return {
      start: nextMondayStartTs,
      end: nextSundayEndTs,
      label: '下週'
    };
  }

  // 處理 "N天後" / "in N days"
  const inDaysMatch = text.match(/(?:in|)\s*(\d+)\s*(?:days|天後)/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1]);
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + days);
    const targetStartTs = Math.floor((targetDate.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    return {
      start: targetStartTs,
      end: targetStartTs + 86400 - 1,
      label: `${days}天後`
    };
  }

  // 處理 "本月" / "this month"
  if (text === '本月' || text === 'this month') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const monthStartTs = Math.floor((monthStart.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    const monthEndTs = Math.floor((monthEnd.getTime() - TAIPEI_OFFSET * 60000) / 1000) + 86400 - 1;
    return {
      start: monthStartTs,
      end: monthEndTs,
      label: '本月'
    };
  }

  // 處理 "下週X" / "next X"
  const nextWeekdayMatch = text.match(/(?:下週|next)\s*([0-6]|週?[一二三四五六日]|sun|mon|tue|wed|thu|fri|sat)/i);
  if (nextWeekdayMatch) {
    const dayStr = nextWeekdayMatch[1].toLowerCase();
    let targetDay;

    // 將星期幾映射到數字（0=周日, 1=周一, ..., 6=周六）
    if (/^[0-6]$/.test(dayStr)) {
      targetDay = parseInt(dayStr);
    } else {
      const dayMap = {
        '週日': 0, '周日': 0, '日': 0, 'sun': 0,
        '週一': 1, '周一': 1, '一': 1, 'mon': 1,
        '週二': 2, '周二': 2, '二': 2, 'tue': 2,
        '週三': 3, '周三': 3, '三': 3, 'wed': 3,
        '週四': 4, '周四': 4, '四': 4, 'thu': 4,
        '週五': 5, '周五': 5, '五': 5, 'fri': 5,
        '週六': 6, '周六': 6, '六': 6, 'sat': 6
      };
      targetDay = dayMap[dayStr];
    }

    if (targetDay !== undefined) {
      const currentDayOfWeek = today.getDay();
      const daysUntilNextWeek = 7 - currentDayOfWeek + targetDay;
      const nextWeekday = new Date(today);
      nextWeekday.setDate(today.getDate() + daysUntilNextWeek);
      const nextWeekdayStartTs = Math.floor((nextWeekday.getTime() - TAIPEI_OFFSET * 60000) / 1000);

      const dayLabelMap = {
        0: '週日', 1: '週一', 2: '週二', 3: '週三', 4: '週四', 5: '週五', 6: '週六'
      };

      return {
        start: nextWeekdayStartTs,
        end: nextWeekdayStartTs + 86400 - 1,
        label: `下${dayLabelMap[targetDay]}`
      };
    }
  }

  // 使用 chrono 解析其他日期格式
  const chronoResults = chrono.parse(queryText, refDate, { forwardDate: true });
  if (chronoResults.length > 0) {
    const parsedDate = chronoResults[0].date();
    const dateStart = new Date(parsedDate);
    dateStart.setHours(0, 0, 0, 0);
    const startTs = Math.floor((dateStart.getTime() - TAIPEI_OFFSET * 60000) / 1000);
    const endTs = startTs + 86400 - 1;

    // 生成標籤
    const month = dateStart.getMonth() + 1;
    const day = dateStart.getDate();
    const label = `${month}月${day}日`;

    return {
      start: startTs,
      end: endTs,
      label: label
    };
  }

  // 本地解析失敗
  return null;
}

export {
  getTaskPrompt,
  getQueryPrompt,
  callAI,
  parseTimeLocally,
  parseQueryLocally,
  TAIPEI_OFFSET
};