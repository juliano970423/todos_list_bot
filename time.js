// time.js - 時間處理模組
// 台北時間偏移量 (分鐘)
const TAIPEI_OFFSET = 8 * 60;

// ============================================
// 核心時區轉換函數（所有時間戳計算統一走這裡）
// ============================================

/**
 * 獲取當前台北時間的 Date 對象（已校正時區）
 */
function getNowTaipei() {
  return new Date(Date.now() + TAIPEI_OFFSET * 60000);
}

/**
 * 將本地時間 Date 轉換為 UTC 時間戳（存入資料庫用）
 * @param {Date} localDate - 本地時間（台北時間）
 * @returns {number} UTC 時間戳（秒）
 */
function localDateToUtcTs(localDate) {
  return Math.floor((localDate.getTime() - TAIPEI_OFFSET * 60000) / 1000);
}

/**
 * 獲取某一天的時間範圍（台北時間）
 * @param {Date} date - 日期對象（會被設為 00:00:00）
 * @returns {{ start: number, end: number }} UTC 時間戳（秒）
 */
function getDayRangeTaipei(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return {
    start: localDateToUtcTs(start),
    end: localDateToUtcTs(end)
  };
}

/**
 * 獲取今天的時間範圍（台北時間）
 * @returns {{ start: number, end: number }} UTC 時間戳（秒）
 */
function getTodayRangeTaipei() {
  return getDayRangeTaipei(getNowTaipei());
}

/**
 * 獲取「今天及未來 N 天」的時間範圍（台北時間）
 * @param {number} days - 未來天數（不含今天）
 * @returns {{ start: number, end: number }} UTC 時間戳（秒）
 */
function getTodayAndFutureRangeTaipei(days) {
  const now = getNowTaipei();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  return {
    start: localDateToUtcTs(start),
    end: localDateToUtcTs(end)
  };
}

/**
 * 獲取「過去 N 天到今天」的時間範圍（台北時間）
 * @param {number} days - 過去天數
 * @returns {{ start: number, end: number }} UTC 時間戳（秒）
 */
function getPastDaysRangeTaipei(days) {
  const now = getNowTaipei();
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  return {
    start: localDateToUtcTs(start),
    end: localDateToUtcTs(end)
  };
}

/**
 * 獲取兩個日期之間的時間範圍（台北時間）
 * @param {Date} startDate - 開始日期
 * @param {Date} endDate - 結束日期
 * @returns {{ start: number, end: number }} UTC 時間戳（秒）
 */
function getDateRangeTaipei(startDate, endDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  return {
    start: localDateToUtcTs(start),
    end: localDateToUtcTs(end)
  };
}

// ============================================
// 舊函數（向後兼容，內部改用新函數）
// ============================================

// --- 輔助：取得人類可讀的台北時間 ---
// 注意：傳入的 dateObj 是 getNowTaipei() 的 +8h shifted clock；
// 直接套 Asia/Taipei 會再 +8h（差 8 小時），所以先扣回偏移才是真正的台北牆鐘時間。
function getTaipeiTimeString(dateObj) {
  const trueInstant = new Date(dateObj.getTime() - TAIPEI_OFFSET * 60000);
  return trueInstant.toLocaleString('zh-TW', {
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

// 基於上次設定的時間計算下次時間 (避免時間漂移)
// 一律用台北時鐘（+8h shifted）計算星期/日期，避免 UTC 錯位；
// 若算出來的時間還沒超過「現在」（如 overdue），持續往前跳到未來，
// 避免 cron 每輪都重複觸發同一筆過期任務。
function calculateNext(lastTs, rule, nowTs = null) {
  const nowSec = (nowTs ?? Math.floor(Date.now() / 1000));
  const TAIPEI_CLOCK_MS = TAIPEI_OFFSET * 60000;
  // 把運算時鐘固定在台北牆上時間（Date 內部值 = 台北時間；getUTC* 皆代表台北曆法）
  const d = new Date(lastTs * 1000 + TAIPEI_CLOCK_MS);
  const toSec = (dt) => Math.floor((dt.getTime() - TAIPEI_CLOCK_MS) / 1000);

  let ts = -Infinity;

  for (let hop = 0; hop < 400; hop++) {
    if (rule === 'daily') {
      d.setUTCDate(d.getUTCDate() + 1);
    } else if (rule.startsWith('weekly:')) {
      const days = rule.split(':')[1].split(',').map(Number);
      const currentISO = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      let found = false;
      for (let offset = 1; offset <= 7; offset++) {
        const pot = ((currentISO - 1 + offset) % 7) + 1;
        if (days.includes(pot)) {
          d.setUTCDate(d.getUTCDate() + offset);
          found = true;
          break;
        }
      }
      if (!found) {
        // 規則無有效星期，退而求其次往後一天，避免無限觸發
        d.setUTCDate(d.getUTCDate() + 1);
      }
    } else if (rule.startsWith('monthly:')) {
      const dayOfMonth = parseInt(rule.split(':')[1]) || d.getUTCDate();
      // 先落回 1 號再換月，避免 31→下月溢出（Jan31+1月 會被 JS normalize 成 Mar3）
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      // 該月最後一天（處理 31→小月 clamp）
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(dayOfMonth, lastDay));
    } else if (rule.startsWith('yearly:')) {
      // 先記下月/日再換年，避免 Feb29 換年 被 normalize 成 Mar1
      const mo = d.getUTCMonth();
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      d.setUTCMonth(mo);
      // 該月沒有這一天（2/29 非閏年、xx-31 小月）統一 clamp 到月末
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
    } else {
      // 未支援的規則：往後一天，避免同一時間重複觸發
      d.setUTCDate(d.getUTCDate() + 1);
    }

    ts = toSec(d);
    if (ts > nowSec) return ts;
  }

  return ts > 0 ? ts : nowSec + 86400;
}

// 獲取當天開始時間戳（已校正時區）
function getDayStartTimestamp() {
  return getTodayRangeTaipei().start;
}

// 獲取當天結束時間戳（已校正時區）
function getDayEndTimestamp() {
  return getTodayRangeTaipei().end;
}

// 將時間戳轉換為台北時間字串（當年省略年份，非當年才帶年）
function formatTimestampToTaipeiTime(timestamp) {
  if (timestamp === -1) return "無時間限制";
  const date = new Date(timestamp * 1000);
  if (isCurrentTaipeiYear(timestamp)) {
    return date.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', hour12: false,
      month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  return date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false});
}

// --- 年份顯示（智慧：當年省略年份，非當年才帶年，避免跨年混淆又保持簡潔） ---
function getTaipeiYearOfTimestamp(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei', year: 'numeric' });
}

function getCurrentTaipeiYear() {
  return new Date(Date.now()).toLocaleString('en-US', { timeZone: 'Asia/Taipei', year: 'numeric' });
}

function isCurrentTaipeiYear(timestamp) {
  if (timestamp === -1 || !timestamp) return true;
  try {
    return getTaipeiYearOfTimestamp(timestamp) === getCurrentTaipeiYear();
  } catch (e) {
    return true;
  }
}

// 全天任務日期：當年 M/D，非當年 YYYY/M/D
function formatDateSmart(timestamp) {
  if (timestamp === -1 || !timestamp) return "無期限";
  const withYear = !isCurrentTaipeiYear(timestamp);
  return new Date(timestamp * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    ...(withYear ? { year: 'numeric' } : {}),
    month: 'numeric', day: 'numeric'
  });
}

// 非全天任務日期時間：當年 M/D HH:MM，非當年 YYYY/M/D HH:MM
function formatDateTimeSmart(timestamp) {
  if (timestamp === -1 || !timestamp) return "無期限";
  const withYear = !isCurrentTaipeiYear(timestamp);
  return new Date(timestamp * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    ...(withYear ? { year: 'numeric' } : {}),
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// 短日期（圖片/按鈕用）：當年 M/D，非當年 YYYY/M/D
function formatShortDateSmart(timestamp) {
  if (!timestamp || timestamp === -1) return '';
  const withYear = !isCurrentTaipeiYear(timestamp);
  return new Date(timestamp * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    ...(withYear ? { year: 'numeric' } : {}),
    month: 'numeric', day: 'numeric'
  });
}

/**
 * 獲取早上報告時間範圍（台北時間）
 * 今天 9:00 - 今天 23:59:59
 */
function getMorningReportRangeTaipei() {
  const now = getNowTaipei();
  const start = new Date(now);
  start.setHours(9, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return {
    start: localDateToUtcTs(start),
    end: localDateToUtcTs(end)
  };
}

/**
 * 獲取晚上報告時間範圍（台北時間）
 * 今天 21:00 - 明天 23:59:59
 */
function getEveningReportRangeTaipei() {
  const now = getNowTaipei();
  const start = new Date(now);
  start.setHours(21, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + 1);
  end.setHours(23, 59, 59, 999);
  return {
    start: localDateToUtcTs(start),
    end: localDateToUtcTs(end)
  };
}

export {
  TAIPEI_OFFSET,
  getNowTaipei,
  localDateToUtcTs,
  getDayRangeTaipei,
  getTodayRangeTaipei,
  getTodayAndFutureRangeTaipei,
  getPastDaysRangeTaipei,
  getDateRangeTaipei,
  getTaipeiTimeString,
  calculateNext,
  getDayStartTimestamp,
  getDayEndTimestamp,
  formatTimestampToTaipeiTime,
  formatDateSmart,
  formatDateTimeSmart,
  formatShortDateSmart,
  isCurrentTaipeiYear,
  getTaipeiYearOfTimestamp,
  getCurrentTaipeiYear,
  getMorningReportRangeTaipei,
  getEveningReportRangeTaipei
};