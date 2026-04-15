// ai.js - AI 處理模組
import * as chrono from "chrono-node";
import { TAIPEI_OFFSET, getNowTaipei, localDateToUtcTs, getDayRangeTaipei, getDateRangeTaipei } from "./time.js";

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

// 本地時間解析（支援中文 + chrono）
function parseTimeLocally(text) {
  const refDate = getNowTaipei();
  const today = new Date(refDate);
  today.setHours(0, 0, 0, 0);

  let parsedDate = null;
  let matchedText = "";

  // 清理輸入文本
  const cleanText = text.replace(/提醒我|記得|幫我|remind me/gi, "").trim();

  // ====== 1. 具體日期匹配 (M/D, M月D日, MM-DD 等) ======

  // M月D日 格式
  const monthDayMatch = cleanText.match(/(\d{1,2})月(\d{1,2})[日號]?/);
  if (monthDayMatch && !parsedDate) {
    const month = parseInt(monthDayMatch[1]);
    const day = parseInt(monthDayMatch[2]);
    parsedDate = new Date(refDate);
    parsedDate.setMonth(month - 1, day);
    if (parsedDate < refDate) {
      parsedDate.setFullYear(parsedDate.getFullYear() + 1);
    }
    matchedText = monthDayMatch[0];
  }

  // M/D 或 MM/DD 格式
  const slashDateMatch = cleanText.match(/(\d{1,2})\/(\d{1,2})/);
  if (slashDateMatch && !parsedDate) {
    const month = parseInt(slashDateMatch[1]);
    const day = parseInt(slashDateMatch[2]);
    parsedDate = new Date(refDate);
    parsedDate.setMonth(month - 1, day);
    if (parsedDate < refDate) {
      parsedDate.setFullYear(parsedDate.getFullYear() + 1);
    }
    matchedText = slashDateMatch[0];
  }

  // ====== 2. 中文相對日期匹配 ======

  // 今天
  if (/今天|today/i.test(cleanText) && !parsedDate) {
    parsedDate = new Date(refDate);
    matchedText = cleanText.match(/今天|today/i)?.[0] || "";
  }
  // 明天
  else if (/明天|tomorrow/i.test(cleanText) && !parsedDate) {
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + 1);
    matchedText = cleanText.match(/明天|tomorrow/i)?.[0] || "";
  }
  // 後天
  else if (/後天/i.test(cleanText) && !parsedDate) {
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + 2);
    matchedText = "後天";
  }
  // N天後
  else if (/(\d+)\s*天後/i.test(cleanText) && !parsedDate) {
    const match = cleanText.match(/(\d+)\s*天後/i);
    const days = parseInt(match[1]);
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + days);
    matchedText = match[0];
  }
  // N週後
  else if (/(\d+)\s*[週周]後/i.test(cleanText) && !parsedDate) {
    const match = cleanText.match(/(\d+)\s*[週周]後/i);
    const weeks = parseInt(match[1]);
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + weeks * 7);
    matchedText = match[0];
  }
  // 下週X / 下周X
  else if (/下[週周]([一二三四五六日天])/i.test(cleanText) && !parsedDate) {
    const match = cleanText.match(/下[週周]([一二三四五六日天])/i);
    const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    const targetDay = dayMap[match[1]];
    const currentDay = refDate.getDay() === 0 ? 7 : refDate.getDay();
    const daysUntilNextWeek = (7 - currentDay) + targetDay;
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + daysUntilNextWeek);
    matchedText = match[0];
  }
  // 這週X / 这週X / 本週X
  else if (/(?:這|这|本)[週周]([一二三四五六日天])/i.test(cleanText) && !parsedDate) {
    const match = cleanText.match(/(?:這|这|本)[週周]([一二三四五六日天])/i);
    const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    const targetDay = dayMap[match[1]];
    const currentDay = refDate.getDay() === 0 ? 7 : refDate.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    parsedDate = new Date(refDate);
    parsedDate.setDate(parsedDate.getDate() + daysUntil);
    matchedText = match[0];
  }

  // ====== 3. 中文時間匹配 ======

  // 如果已經匹配到日期，嘗試匹配時間
  if (parsedDate) {
    // 上午/早上/早 X點
    const morningMatch = cleanText.match(/上午|早上?|早/);
    // 下午/午後 X點
    const afternoonMatch = cleanText.match(/下午|午後/);
    // 晚上/晚 X點
    const eveningMatch = cleanText.match(/晚上?|晚/);

    // X點X分 或 X點 或 X:XX
    const timeMatch = cleanText.match(/(\d{1,2})[點点時](\d{1,2})?[分]?|(\d{1,2}):(\d{2})/);

    if (timeMatch) {
      let hour = parseInt(timeMatch[1] || timeMatch[3]);
      const minute = parseInt(timeMatch[2] || timeMatch[4] || 0);

      // 處理 12小時制
      if (morningMatch) {
        // 上午：12點 = 0點，其他不變
        if (hour === 12) hour = 0;
      } else if (afternoonMatch) {
        // 下午：小於12的加12
        if (hour < 12) hour += 12;
      } else if (eveningMatch) {
        // 晚上：小於12的加12
        if (hour < 12) hour += 12;
      }

      parsedDate.setHours(hour, minute, 0, 0);
      matchedText += " " + (morningMatch?.[0] || afternoonMatch?.[0] || eveningMatch?.[0] || "") + " " + (timeMatch[0] || "");
      matchedText = matchedText.trim();
    } else {
      // 沒有具體時間，設為全天（中午）
      parsedDate.setHours(12, 0, 0, 0);
    }
  }

  // ====== 4. Fallback 到 chrono ======

  if (!parsedDate) {
    const results = chrono.parse(cleanText, refDate, { forwardDate: true });
    if (results.length) {
      const r = results[0];
      parsedDate = r.date();
      matchedText = r.text;
    }
  }

  // ====== 5. 返回結果 ======

  if (!parsedDate) return null;

  // 提取任務名稱（移除時間相關文字）
  let task = cleanText
    .replace(matchedText, "")
    .replace(/今天|明天|後天|晚上?|早上?|上午|下午|午後/gi, "")
    .replace(/\d{1,2}[月\/]\d{1,2}[日號]?/gi, "")
    .replace(/[\d]+[點点時分]/gi, "")
    .replace(/下[週周][一二三四五六日天]?|這[週周][一二三四五六日天]?|本[週周][一二三四五六日天]?/gi, "")
    .replace(/\d+\s*天後|\d+\s*[週周]後/gi, "")
    .trim();

  if (!task) task = "未命名任務";

  const utcTs = localDateToUtcTs(parsedDate);

  return { task, utcTimestamp: utcTs };
}

// 本地查詢時間範圍解析（使用統一的時區函數）
function parseQueryLocally(queryText) {
  const refDate = getNowTaipei();
  const text = queryText.toLowerCase();
  const today = new Date(refDate);
  today.setHours(0, 0, 0, 0);

  // 處理 "今天"
  if (text === '今天' || text === 'today') {
    const { start, end } = getDayRangeTaipei(today);
    return { start, end, label: '今天' };
  }

  // 處理 "明天"
  if (text === '明天' || text === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const { start, end } = getDayRangeTaipei(tomorrow);
    return { start, end, label: '明天' };
  }

  // 處理 "昨天"
  if (text === '昨天' || text === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const { start, end } = getDayRangeTaipei(yesterday);
    return { start, end, label: '昨天' };
  }

  // 處理 "後天"
  if (text === '後天' || text === '后天') {
    const dayAfter = new Date(today);
    dayAfter.setDate(dayAfter.getDate() + 2);
    const { start, end } = getDayRangeTaipei(dayAfter);
    return { start, end, label: '後天' };
  }

  // 處理 "前天"
  if (text === '前天') {
    const dayBefore = new Date(today);
    dayBefore.setDate(dayBefore.getDate() - 2);
    const { start, end } = getDayRangeTaipei(dayBefore);
    return { start, end, label: '前天' };
  }

  // 處理 "大後天"（3天後）
  if (text === '大後天' || text === '大后天') {
    const dayAfter = new Date(today);
    dayAfter.setDate(dayAfter.getDate() + 3);
    const { start, end } = getDayRangeTaipei(dayAfter);
    return { start, end, label: '大後天' };
  }

  // 處理 "大前天"（3天前）
  if (text === '大前天') {
    const dayBefore = new Date(today);
    dayBefore.setDate(dayBefore.getDate() - 3);
    const { start, end } = getDayRangeTaipei(dayBefore);
    return { start, end, label: '大前天' };
  }

  // 處理 "本週" / "this week" / "這週" / "这周" / "這禮拜" / "这礼拜"
  if (text === '本週' || text === '本周' || text === 'this week' || text === '這週' || text === '这周' || text === '這禮拜' || text === '这礼拜') {
    const currentDayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const { start, end } = getDateRangeTaipei(monday, sunday);
    return { start, end, label: '本週' };
  }

  // 處理 "下週" / "next week" / "下禮拜"
  if (text === '下週' || text === '下周' || text === 'next week' || text === '下禮拜' || text === '下礼拜') {
    const currentDayOfWeek = today.getDay();
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + (7 - (currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1)));
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    const { start, end } = getDateRangeTaipei(nextMonday, nextSunday);
    return { start, end, label: '下週' };
  }

  // 處理 "上週" / "last week" / "上禮拜"
  if (text === '上週' || text === '上周' || text === 'last week' || text === '上禮拜' || text === '上礼拜') {
    const currentDayOfWeek = today.getDay();
    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - (currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1) - 7);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    const { start, end } = getDateRangeTaipei(lastMonday, lastSunday);
    return { start, end, label: '上週' };
  }

  // 處理 "下月" / "下個月" / "next month"
  if (text === '下月' || text === '下個月' || text === 'next month') {
    const nextMonth = new Date(today);
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    const monthStart = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
    const monthEnd = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0);
    const { start, end } = getDateRangeTaipei(monthStart, monthEnd);
    return { start, end, label: '下個月' };
  }

  // 處理 "上月" / "上個月" / "last month"
  if (text === '上月' || text === '上個月' || text === 'last month') {
    const lastMonth = new Date(today);
    lastMonth.setMonth(lastMonth.getMonth() - 1, 1);
    const monthStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
    const monthEnd = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0);
    const { start, end } = getDateRangeTaipei(monthStart, monthEnd);
    return { start, end, label: '上個月' };
  }

  // 處理 "N天後" / "in N days" / 中文數字
  const chineseNumMap = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const inDaysMatch = text.match(/(?:in\s*)?(\d+|[一二兩三四五六七八九十]+)\s*(?:days|天後)/i);
  if (inDaysMatch) {
    let days = parseInt(inDaysMatch[1]);
    if (isNaN(days)) {
      days = chineseNumMap[inDaysMatch[1]] || 1;
    }
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + days);
    const { start, end } = getDayRangeTaipei(targetDate);
    return { start, end, label: `${days}天後` };
  }

  // 處理 "N週後" / "in N weeks"
  const inWeeksMatch = text.match(/(?:in\s*)?(\d+|[一二兩三四五六七八九十]+)\s*(?:weeks?|週後|周後)/i);
  if (inWeeksMatch) {
    let weeks = parseInt(inWeeksMatch[1]);
    if (isNaN(weeks)) {
      weeks = chineseNumMap[inWeeksMatch[1]] || 1;
    }
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + weeks * 7);
    const { start, end } = getDayRangeTaipei(targetDate);
    return { start, end, label: `${weeks}週後` };
  }

  // 處理 "N個月後" / "in N months"
  const inMonthsMatch = text.match(/(?:in\s*)?(\d+|[一二兩三四五六七八九十]+)\s*(?:months?|個月後)/i);
  if (inMonthsMatch) {
    let months = parseInt(inMonthsMatch[1]);
    if (isNaN(months)) {
      months = chineseNumMap[inMonthsMatch[1]] || 1;
    }
    const targetDate = new Date(today);
    targetDate.setMonth(targetDate.getMonth() + months);
    const { start, end } = getDayRangeTaipei(targetDate);
    return { start, end, label: `${months}個月後` };
  }

  // 處理 "本月" / "this month"
  if (text === '本月' || text === 'this month') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const { start, end } = getDateRangeTaipei(monthStart, monthEnd);
    return { start, end, label: '本月' };
  }

  // 處理 "月初" / "月底"
  if (text === '月初') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthMid = new Date(today.getFullYear(), today.getMonth(), 10);
    const { start, end } = getDateRangeTaipei(monthStart, monthMid);
    return { start, end, label: '月初' };
  }
  if (text === '月底') {
    const monthMid = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    monthMid.setDate(monthMid.getDate() - 10);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const { start, end } = getDateRangeTaipei(monthMid, monthEnd);
    return { start, end, label: '月底' };
  }

  // 處理 "今年" / "去年" / "明年"
  if (text === '今年') {
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearEnd = new Date(today.getFullYear(), 11, 31);
    const { start, end } = getDateRangeTaipei(yearStart, yearEnd);
    return { start, end, label: '今年' };
  }
  if (text === '去年') {
    const yearStart = new Date(today.getFullYear() - 1, 0, 1);
    const yearEnd = new Date(today.getFullYear() - 1, 11, 31);
    const { start, end } = getDateRangeTaipei(yearStart, yearEnd);
    return { start, end, label: '去年' };
  }
  if (text === '明年') {
    const yearStart = new Date(today.getFullYear() + 1, 0, 1);
    const yearEnd = new Date(today.getFullYear() + 1, 11, 31);
    const { start, end } = getDateRangeTaipei(yearStart, yearEnd);
    return { start, end, label: '明年' };
  }

  // 處理 "年初" / "年底" / "今年初" / "今年底" 等
  if (text === '年初' || text === '上半年' || text === '今年初' || text === '今年頭' || text === '今年头') {
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearMid = new Date(today.getFullYear(), 5, 30);
    const { start, end } = getDateRangeTaipei(yearStart, yearMid);
    return { start, end, label: '年初' };
  }
  if (text === '年底' || text === '下半年' || text === '今年底') {
    const yearMid = new Date(today.getFullYear(), 6, 1);
    const yearEnd = new Date(today.getFullYear(), 11, 31);
    const { start, end } = getDateRangeTaipei(yearMid, yearEnd);
    return { start, end, label: '年底' };
  }
  if (text === '明年初' || text === '明年頭' || text === '明年头') {
    const yearStart = new Date(today.getFullYear() + 1, 0, 1);
    const yearMid = new Date(today.getFullYear() + 1, 5, 30);
    const { start, end } = getDateRangeTaipei(yearStart, yearMid);
    return { start, end, label: '明年初' };
  }
  if (text === '明年底') {
    const yearMid = new Date(today.getFullYear() + 1, 6, 1);
    const yearEnd = new Date(today.getFullYear() + 1, 11, 31);
    const { start, end } = getDateRangeTaipei(yearMid, yearEnd);
    return { start, end, label: '明年底' };
  }
  if (text === '去年初' || text === '去年頭' || text === '去年头') {
    const yearStart = new Date(today.getFullYear() - 1, 0, 1);
    const yearMid = new Date(today.getFullYear() - 1, 5, 30);
    const { start, end } = getDateRangeTaipei(yearStart, yearMid);
    return { start, end, label: '去年初' };
  }
  if (text === '去年底') {
    const yearMid = new Date(today.getFullYear() - 1, 6, 1);
    const yearEnd = new Date(today.getFullYear() - 1, 11, 31);
    const { start, end } = getDateRangeTaipei(yearMid, yearEnd);
    return { start, end, label: '去年底' };
  }

  // 處理 "X月" 格式（如 "4月"）
  const monthMatch = text.match(/^(\d{1,2})月$/);
  if (monthMatch) {
    const month = parseInt(monthMatch[1]);
    let year = today.getFullYear();
    // 如果月份已過，則查詢明年
    if (month < today.getMonth() + 1) {
      year += 1;
    }
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const { start, end } = getDateRangeTaipei(monthStart, monthEnd);
    return { start, end, label: `${month}月` };
  }

  // 處理英文月份名（如 "april", "April"）
  const englishMonthMap = {
    'january': 1, 'jan': 1,
    'february': 2, 'feb': 2,
    'march': 3, 'mar': 3,
    'april': 4, 'apr': 4,
    'may': 5,
    'june': 6, 'jun': 6,
    'july': 7, 'jul': 7,
    'august': 8, 'aug': 8,
    'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10,
    'november': 11, 'nov': 11,
    'december': 12, 'dec': 12
  };
  const englishMonthMatch = text.match(/^(this\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)$/i);
  if (englishMonthMatch) {
    const month = englishMonthMap[englishMonthMatch[2].toLowerCase()];
    let year = today.getFullYear();
    // 如果月份已過，則查詢明年
    if (month < today.getMonth() + 1) {
      year += 1;
    }
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const { start, end } = getDateRangeTaipei(monthStart, monthEnd);
    return { start, end, label: `${month}月` };
  }

  // 處理 "這週X" / "本週X" / "this X"
  const thisWeekdayMatch = text.match(/(?:這週|本週|this)\s*([0-6]|週?[一二三四五六日]|sun|mon|tue|wed|thu|fri|sat)/i);
  if (thisWeekdayMatch) {
    const dayStr = thisWeekdayMatch[1].toLowerCase();
    let targetDay;

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
      let daysUntilTarget = targetDay - currentDayOfWeek;
      // 如果目標日期已過（或就是今天），跳到下週
      if (daysUntilTarget <= 0) {
        daysUntilTarget += 7;
      }
      const targetDate = new Date(today);
      targetDate.setDate(today.getDate() + daysUntilTarget);
      const { start, end } = getDayRangeTaipei(targetDate);

      const dayLabelMap = {
        0: '週日', 1: '週一', 2: '週二', 3: '週三', 4: '週四', 5: '週五', 6: '週六'
      };

      return { start, end, label: `這${dayLabelMap[targetDay]}` };
    }
  }

  // 處理 "下週X" / "next X"
  const nextWeekdayMatch = text.match(/(?:下週|next)\s*([0-6]|週?[一二三四五六日]|sun|mon|tue|wed|thu|fri|sat)/i);
  if (nextWeekdayMatch) {
    const dayStr = nextWeekdayMatch[1].toLowerCase();
    let targetDay;

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
      const daysUntilEndOfWeek = 7 - currentDayOfWeek;
      const daysUntilNextWeek = (currentDayOfWeek === 0 ? 7 : daysUntilEndOfWeek) + targetDay;
      const nextWeekday = new Date(today);
      nextWeekday.setDate(today.getDate() + daysUntilNextWeek);
      const { start, end } = getDayRangeTaipei(nextWeekday);

      const dayLabelMap = {
        0: '週日', 1: '週一', 2: '週二', 3: '週三', 4: '週四', 5: '週五', 6: '週六'
      };

      return { start, end, label: `下${dayLabelMap[targetDay]}` };
    }
  }

  // 先檢查輸入是否包含日期特徵，沒有的話直接返回 null
  // 包含英文月份名、中文日期關鍵詞、數字日期格式等
  const hasDateFeature = /今天|明天|昨天|前天|後天|大前天|大後天|本週|下週|上週|本周|下周|上周|這週|这周|禮拜|本月|下月|上月|個月|週後|周後|天後|月初|月底|年初|年底|今年|去年|明年|上半年|下半年|年頭|年头|過|幾|\d{1,2}[\/\-月]|\d{1,2}[日號]|週|周|星期|week|month|day|year|after|before|ago|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(queryText);

  if (!hasDateFeature) {
    return null;
  }

  // 使用 chrono 解析其他日期格式
  const chronoResults = chrono.parse(queryText, refDate, { forwardDate: true });
  if (chronoResults.length > 0) {
    const parsedDate = chronoResults[0].date();
    const dateStart = new Date(parsedDate);
    dateStart.setHours(0, 0, 0, 0);
    const { start, end } = getDayRangeTaipei(dateStart);

    const month = dateStart.getMonth() + 1;
    const day = dateStart.getDate();
    return { start, end, label: `${month}月${day}日` };
  }

  // 本地解析失敗
  return null;
}

export {
  getTaskPrompt,
  getQueryPrompt,
  callAI,
  parseTimeLocally,
  parseQueryLocally
};