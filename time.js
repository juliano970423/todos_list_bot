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

// 基於上次設定的時間計算下次時間 (避免時間漂移)
function calculateNext(lastTs, rule) {
  let d = new Date(lastTs * 1000);

  if (rule === 'daily') {
    d.setDate(d.getDate() + 1);
  } else if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(Number);
    const currentDayOfWeekISO = d.getDay() === 0 ? 7 : d.getDay();

    let nextDayOffset = 1;
    let found = false;

    while (nextDayOffset <= 7 && !found) {
      let potentialDay = (currentDayOfWeekISO + nextDayOffset) % 7;
      if (potentialDay === 0) potentialDay = 7;
      if (days.includes(potentialDay)) {
        found = true;
        d.setDate(d.getDate() + nextDayOffset);
      } else {
        nextDayOffset++;
      }
    }
  } else if (rule.startsWith('monthly:')) {
    d.setMonth(d.getMonth() + 1);
  } else if (rule.startsWith('yearly:')) {
    d.setFullYear(d.getFullYear() + 1);
    if (d.getMonth() === 1 && d.getDate() === 29 && !(d.getFullYear() % 4 === 0 && (d.getFullYear() % 100 !== 0 || d.getFullYear() % 400 === 0))) {
      d.setDate(28);
    }
  }

  return Math.floor(d.getTime() / 1000);
}

// 獲取當天開始時間戳（已校正時區）
function getDayStartTimestamp() {
  return getTodayRangeTaipei().start;
}

// 獲取當天結束時間戳（已校正時區）
function getDayEndTimestamp() {
  return getTodayRangeTaipei().end;
}

// 將時間戳轉換為台北時間字串
function formatTimestampToTaipeiTime(timestamp) {
  if (timestamp === -1) return "無時間限制";
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false});
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
  formatTimestampToTaipeiTime
};