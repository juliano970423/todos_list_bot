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

  if (rule === 'daily') d.setDate(d.getDate() + 1);
  else if (rule.startsWith('weekly:')) d.setDate(d.getDate() + 7);
  else if (rule.startsWith('monthly:')) d.setMonth(d.getMonth() + 1);
  else if (rule.startsWith('yearly:')) d.setFullYear(d.getFullYear() + 1);

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
function formatTimestampToTaipeiTime(timestamp, includeTime = true) {
  if (timestamp === -1) return "無時間限制";
  
  const date = new Date(timestamp * 1000);
  if (includeTime) {
    return date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false});
  } else {
    return date.toLocaleString('zh-TW', {timeZone:'Asia/Taipei', month:'numeric', day:'numeric'});
  }
}

export {
  TAIPEI_OFFSET,
  getTaipeiTimeString,
  calculateNext,
  getDayStartTimestamp,
  getDayEndTimestamp,
  formatTimestampToTaipeiTime
};