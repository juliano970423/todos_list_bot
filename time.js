// time.js - 時間處理模組
// 台北時間偏移量 (分鐘)
const TAIPEI_OFFSET = 8 * 60;

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
  // 基於上次設定的時間計算下次時間 (避免時間漂移)
  let d = new Date(lastTs * 1000);

  if (rule === 'daily') {
    d.setDate(d.getDate() + 1);
  } else if (rule.startsWith('weekly:')) {
    // 對於週期性週任務，需要計算下一個符合規則的日期
    const days = rule.split(':')[1].split(',').map(Number);
    const currentDayOfWeekISO = d.getDay() === 0 ? 7 : d.getDay(); // Convert to ISO (1 for Mon, ..., 7 for Sun)

    // 找到當前日期後下一個符合規則的日期
    let nextDayOffset = 1;
    let found = false;

    while (nextDayOffset <= 7 && !found) {
      let potentialDay = (currentDayOfWeekISO + nextDayOffset) % 7;
      if (potentialDay === 0) potentialDay = 7; // Sunday should be 7, not 0
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
    // 確保在閏年的2月29日之後的年份中，日期被正確調整
    if (d.getMonth() === 1 && d.getDate() === 29 && !(d.getFullYear() % 4 === 0 && (d.getFullYear() % 100 !== 0 || d.getFullYear() % 400 === 0))) {
      // 如果是閏年2月29日，但下一年不是閏年，則設為2月28日
      d.setDate(28);
    }
  }

  return Math.floor(d.getTime() / 1000);
}

// 獲取當天開始時間戳
function getDayStartTimestamp() {
  return Math.floor(new Date().setHours(0,0,0,0)/1000);
}

// 獲取當天結束時間戳
function getDayEndTimestamp() {
  return Math.floor(new Date().setHours(23,59,59,999)/1000);
}

// 將時間戳轉換為台北時間字串
function formatTimestampToTaipeiTime(timestamp) {
  if (timestamp === -1) return "無時間限制";

  const date = new Date(timestamp * 1000);
  // 返回包含時分秒的完整時間
  return date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false});
}

export {
  TAIPEI_OFFSET,
  getTaipeiTimeString,
  calculateNext,
  getDayStartTimestamp,
  getDayEndTimestamp,
  formatTimestampToTaipeiTime
};