// image.js - SVG 圖片產生模組

/**
 * 轉義 HTML 特殊字元（用於 SVG 文字）
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 格式化時間戳為台北時間 HH:MM
 */
function formatTime(ts) {
  if (!ts || ts === -1) return '';
  return new Date(ts * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 格式化時間戳為台北時間 M/D
 */
function formatDate(ts) {
  if (!ts || ts === -1) return '';
  return new Date(ts * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
  });
}

/**
 * 翻譯週期規則為中文
 */
function translateRule(rule) {
  if (!rule || rule === 'none' || rule === 'null') return '';
  if (rule === 'daily') return '每天';
  if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1];
    if (days === '1,2,3,4,5') return '週一至週五';
    if (days === '6,7') return '週末';
    if (/^\d+$/.test(days)) {
      const m = { '1': '週一', '2': '週二', '3': '週三', '4': '週四', '5': '週五', '6': '週六', '7': '週日' };
      return `每${m[days] || '週'}`;
    }
    return '每週';
  }
  if (rule.startsWith('monthly:')) return '每月';
  if (rule.startsWith('yearly:')) return '每年';
  return rule;
}

/**
 * 產生排程圖片 SVG Buffer
 * @param {Array} tasks - 任務陣列
 * @param {Object} options
 * @param {string} options.title - 標題文字
 * @param {string} options.dateStr - 日期文字 (e.g. "8/29 週五")
 * @param {'morning'|'evening'|'list'|'history'} options.type - 類型
 * @returns {Buffer} SVG Buffer
 */
export function generateScheduleImage(tasks, options = {}) {
  const { title = '待辦事項', dateStr = '', type = 'list' } = options;

  const isHistory = type === 'history';
  const emoji = isHistory ? '📚' : (type === 'morning' ? '☀️' : type === 'evening' ? '🌙' : '📋');

  // 準備任務資料
  const items = tasks.map((t) => {
    let timeText = '';
    if (t.cron_rule) {
      timeText = `🔄 ${translateRule(t.cron_rule)}`;
    } else if (t.all_day) {
      timeText = `全天 ${formatDate(t.remind_at)}`;
    } else if (t.remind_at && t.remind_at !== -1) {
      timeText = formatTime(t.remind_at);
    } else {
      timeText = '無期限';
    }

    const statusIcon = isHistory ? '✅' : '•';
    return { timeText, task: t.task, statusIcon };
  });

  // 計算 SVG 尺寸
  const padding = 32;
  const lineHeight = 36;
  const headerHeight = 80;
  const footerHeight = 40;
  const maxCharsPerLine = 30; // 大約每行 30 個中文字
  const contentHeight = items.length > 0
    ? items.reduce((sum, item) => {
        const taskLen = item.task.length;
        const lines = Math.max(1, Math.ceil(taskLen / maxCharsPerLine));
        return sum + lineHeight * lines;
      }, 0)
    : lineHeight * 2;

  const svgWidth = 400;
  const svgHeight = headerHeight + contentHeight + footerHeight + padding * 2;

  // 產生任務項目 HTML
  let itemsSvg = '';
  let y = headerHeight + padding;

  if (items.length === 0) {
    itemsSvg = `
      <text x="${svgWidth / 2}" y="${y + 20}" text-anchor="middle"
            font-family="sans-serif" font-size="16" fill="#999">
        ${isHistory ? '🐱 沒有完成紀錄' : '🐱 沒有待辦事項'}
      </text>`;
    y += lineHeight * 2;
  } else {
    items.forEach((item, i) => {
      const taskLen = item.task.length;
      const lines = Math.max(1, Math.ceil(taskLen / maxCharsPerLine));

      // 時間標籤背景
      const timeWidth = item.timeText.length * 13 + 16;
      itemsSvg += `
        <rect x="${padding}" y="${y - 12}" width="${timeWidth}" height="22" rx="4"
              fill="${isHistory ? '#e8f5e9' : '#e3f2fd'}" />
        <text x="${padding + 8}" y="${y + 2}" font-family="sans-serif" font-size="13"
              fill="${isHistory ? '#2e7d32' : '#1565c0'}" font-weight="bold">
          ${escapeXml(item.timeText)}
        </text>`;

      // 任務名稱（可能換行）
      const taskX = padding + timeWidth + 10;
      const availableWidth = svgWidth - taskX - padding;

      for (let line = 0; line < lines; line++) {
        const sliceStart = line * maxCharsPerLine;
        const sliceEnd = Math.min((line + 1) * maxCharsPerLine, item.task.length);
        const lineText = item.task.slice(sliceStart, sliceEnd);

        itemsSvg += `
          <text x="${taskX}" y="${y + 2}" font-family="sans-serif" font-size="15"
                fill="#333">
            ${line === 0 ? escapeXml(lineText) : escapeXml(lineText)}
          </text>`;

        if (line < lines - 1) {
          y += lineHeight;
        }
      }

      // 分隔線
      y += lineHeight;
      if (i < items.length - 1) {
        itemsSvg += `
          <line x1="${padding}" y1="${y - 8}" x2="${svgWidth - padding}" y2="${y - 8}"
                stroke="#eee" stroke-width="1" />`;
      }
    });
  }

  // 類型色彩
  const headerBg = isHistory
    ? 'linear-gradient(135deg, #66bb6a, #43a047)'
    : type === 'morning'
      ? 'linear-gradient(135deg, #ffa726, #f57c00)'
      : type === 'evening'
        ? 'linear-gradient(135deg, #5c6bc0, #3949ab)'
        : 'linear-gradient(135deg, #42a5f5, #1e88e5)';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${type === 'morning' ? '#ffa726' : type === 'evening' ? '#5c6bc0' : isHistory ? '#66bb6a' : '#42a5f5'}" />
      <stop offset="100%" style="stop-color:${type === 'morning' ? '#f57c00' : type === 'evening' ? '#3949ab' : isHistory ? '#43a047' : '#1e88e5'}" />
    </linearGradient>
  </defs>

  <!-- 背景 -->
  <rect width="${svgWidth}" height="${svgHeight}" rx="16" fill="#fafafa" />

  <!-- 標題列 -->
  <rect width="${svgWidth}" height="${headerHeight}" rx="16" fill="url(#headerGrad)" />
  <rect y="30" width="${svgWidth}" height="30" fill="url(#headerGrad)" />

  <!-- 標題文字 -->
  <text x="${padding}" y="35" font-family="sans-serif" font-size="22" fill="white" font-weight="bold">
    ${escapeXml(emoji)} ${escapeXml(title)}
  </text>
  ${dateStr ? `<text x="${padding}" y="58" font-family="sans-serif" font-size="14" fill="rgba(255,255,255,0.85)">
    ${escapeXml(dateStr)}
  </text>` : ''}

  <!-- 任務內容 -->
  ${itemsSvg}

  <!-- 頁尾 -->
  <text x="${svgWidth / 2}" y="${svgHeight - 14}" text-anchor="middle"
        font-family="sans-serif" font-size="12" fill="#bbb">
    共 ${items.length} 項  ·  Meow~ 🐱
  </text>
</svg>`;

  return Buffer.from(svg, 'utf-8');
}
