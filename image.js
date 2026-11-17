// image.js - SVG 圖片產生 + SVG→PNG 點陣模組
// 注意：Workers 舊版 nodejs_compat（compat date < 2024-09-23）沒有全域 Buffer，
// 必須從 node:buffer 顯式 import，否則 generateScheduleImage 會丟 ReferenceError，
// 導致所有 SVG 圖片永遠發送失敗（一律落入純文字 fallback）。
import { Buffer } from "node:buffer";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { formatDateSmart, formatDateTimeSmart } from "./time.js";

// .wasm 用動態 import（Workers/wrangler 會打包成 WebAssembly.Module；
// Node 測試環境解析不了 wasm-bindgen glue，改用 setResvgWasmInput() 注入原始 bytes）
let resvgWasmInput = null;
try {
  resvgWasmInput = (await import("@resvg/resvg-wasm/index_bg.wasm")).default;
} catch {
  resvgWasmInput = null; // Node：等 setResvgWasmInput() 注入
}

/** 僅測試環境用：注入原始 wasm bytes（Workers 路徑不需要） */
export function setResvgWasmInput(input) {
  resvgWasmInput = input;
}

// --- SVG→PNG（sendPhoto 只收 PNG/JPEG，SVG 只能當檔案附件傳） ---

const FONT_FAMILY = "Noto Sans TC";
// 基本拉丁/數字/常用標點，永遠放進子集字型請求
const BASIC_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ：；、，。！？（）【】《》「」『』～·…—；:;,.!?()[]{}<>-_=+*/\\%#@$^&|~'\"` ";
// 舊版 UA → Google Fonts 回 TTF（實測：無 UA/Android2.2/Safari533 → font/ttf；
// MSIE6 → EOT（fontdb 不吃）、Chrome29 → woff（不吃）、Chrome 現代 → woff2（2.6.2 實測可渲染，
// 但 TTF 最保守）。用 Android 2.2 這個經典 TTF trick。
const LEGACY_UA = "Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1";

// SVG 標記中的 emoji/符號（resvg 沒有 emoji 字型，不剝掉會畫成空白/豆腐）
function stripEmoji(s) {
  return String(s || "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .trim();
}

let resvgReady = false;
async function ensureResvg() {
  if (resvgReady) return;
  if (!resvgWasmInput) throw new Error("resvg wasm 未初始化（Workers 打包或 setResvgWasmInput 皆未提供）");
  await initWasm(resvgWasmInput);
  resvgReady = true;
}

// 執行期字型子集快取：chars → 字型 bytes（isolate 內重複渲染不再打 Google Fonts）
const fontCache = new Map();

/**
 * 向 Google Fonts 抓「只包含指定字元」的 Noto Sans TC 子集（CSS2 API text= 參數）。
 * 每次最多送 500 個不重複字元（URL 長度限制）；失敗丟錯，由呼叫端退回純文字。
 */
async function fetchCjkFontBuffer(svgText) {
  const unique = [...new Set([...svgText, ...BASIC_CHARS])].filter((c) => /\S/.test(c)).join("").slice(0, 500);
  if (fontCache.has(unique)) return fontCache.get(unique);
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FONT_FAMILY)}:wght@400&text=${encodeURIComponent(unique)}`;
  const cssRes = await fetch(cssUrl, { headers: { "User-Agent": LEGACY_UA } });
  if (!cssRes.ok) throw new Error(`Google Fonts CSS ${cssRes.status}`);
  const css = await cssRes.text();
  const m = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/);
  if (!m) throw new Error("Google Fonts CSS 內無字型 URL");
  const fontRes = await fetch(m[1], { headers: { "User-Agent": LEGACY_UA } });
  if (!fontRes.ok) throw new Error(`字型下載 ${fontRes.status}`);
  const bytes = new Uint8Array(await fontRes.arrayBuffer());
  if (bytes.byteLength < 1000) throw new Error("字型檔異常（太小）");
  fontCache.set(unique, bytes);
  if (fontCache.size > 24) fontCache.delete(fontCache.keys().next().value);
  return bytes;
}

/**
 * 產生排程圖 PNG（sendPhoto 用）。
 * 流程：buildScheduleSvg（SVG 字串）→ Google Fonts 執行期子集字型 → resvg 點陣。
 * 失敗會丟錯，呼叫端一律退回純文字清單。
 * @returns {Promise<Uint8Array>} PNG bytes
 */
export async function generateSchedulePng(tasks, options = {}) {
  const { svg, width } = buildScheduleSvg(tasks, options);
  await ensureResvg();
  const svgText = stripEmoji(svg.replace(/<[^>]+>/g, " "));
  const font = await fetchCjkFontBuffer(svgText);
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.min(width * 2, 1600) }, // 2x 渲染，文字才清晰
    font: { fontBuffers: [font], defaultFontFamily: FONT_FAMILY },
  }).render().asPng();
  return png;
}

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
 * 格式化時間戳為台北時間日期（智慧：當年省略年份，非當年才帶年）
 */
function formatDate(ts) {
  return formatDateSmart(ts);
}

/**
 * 格式化時間戳為台北時間日期時間（智慧：當年省略年份）
 */
function formatDateTime(ts) {
  return formatDateTimeSmart(ts);
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
 * 產生排程圖 SVG 字串（PNG 生成與舊 SVG Buffer 共用）
 * @returns {{ svg: string, width: number, height: number }}
 */
function buildScheduleSvg(tasks, options = {}) {
  const { title = '待辦事項', dateStr = '', type = 'list' } = options;

  const isHistory = type === 'history';

  // 準備任務資料（時間一律帶年）
  const items = tasks.map((t) => {
    let timeText = '';
    if (t.cron_rule) {
      timeText = `🔄 ${translateRule(t.cron_rule)}`;
    } else if (t.all_day) {
      timeText = `全天 ${formatDate(t.remind_at)}`;
    } else if (t.remind_at && t.remind_at !== -1) {
      timeText = formatDateTime(t.remind_at);
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
            font-family="Noto Sans TC, sans-serif" font-size="16" fill="#999">
        ${isHistory ? '沒有完成紀錄' : '沒有待辦事項'}
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
        <text x="${padding + 8}" y="${y + 2}" font-family="Noto Sans TC, sans-serif" font-size="13"
              fill="${isHistory ? '#2e7d32' : '#1565c0'}" font-weight="bold">
          ${escapeXml(stripEmoji(item.timeText))}
        </text>`;

      // 任務名稱（可能換行）
      const taskX = padding + timeWidth + 10;
      const availableWidth = svgWidth - taskX - padding;

      for (let line = 0; line < lines; line++) {
        const sliceStart = line * maxCharsPerLine;
        const sliceEnd = Math.min((line + 1) * maxCharsPerLine, item.task.length);
        const lineText = item.task.slice(sliceStart, sliceEnd);

        itemsSvg += `
          <text x="${taskX}" y="${y + 2}" font-family="Noto Sans TC, sans-serif" font-size="15"
                fill="#333">
            ${escapeXml(stripEmoji(lineText))}
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
  <text x="${padding}" y="35" font-family="Noto Sans TC, sans-serif" font-size="22" fill="white" font-weight="bold">
    ${escapeXml(stripEmoji(title))}
  </text>
  ${dateStr ? `<text x="${padding}" y="58" font-family="Noto Sans TC, sans-serif" font-size="14" fill="rgba(255,255,255,0.85)">
    ${escapeXml(stripEmoji(dateStr))}
  </text>` : ''}

  <!-- 任務內容 -->
  ${itemsSvg}

  <!-- 頁尾 -->
  <text x="${svgWidth / 2}" y="${svgHeight - 14}" text-anchor="middle"
        font-family="Noto Sans TC, sans-serif" font-size="12" fill="#bbb">
    共 ${items.length} 項 · Meow~
  </text>
</svg>`;

  return { svg, width: svgWidth, height: svgHeight };
}

/**
 * 產生排程圖 SVG Buffer（舊介面，保留給測試/除錯用；正式發送走 generateSchedulePng）
 */
export function generateScheduleImage(tasks, options = {}) {
  const { svg } = buildScheduleSvg(tasks, options);
  return Buffer.from(svg, 'utf-8');
}
