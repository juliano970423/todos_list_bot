// priority.js - 任務排序 tier 制
// 使用者需求：考試/作業相關的排最前面（人會 lost in the middle），
// 問卷/行政公告這類雜務往後排。
// tier：0 考試 > 1 作業/報告/繳交/截止 > 2 一般 > 3 問卷/公告/宣導

const EXAM_RE = /期中|期末|考試|考卷|小考|隨堂|測驗|模考|quiz|exam|midterm|final/i;
const WORK_RE = /作業|功課|homework|assignment|\bhw\b|報告|essay|論文|繳交|繳納|繳費|交件|訂正|截止|due\b|deadline/i;
const NOISE_RE = /問卷|survey|填答|公告|宣導|活動快訊|意見調查/i;

/**
 * 依任務名稱判斷排序 tier（數字越小越前面）
 * @param {string} task
 * @returns {number} 0..3
 */
export function getTaskTier(task) {
  const s = String(task || "");
  if (!s) return 2;
  if (EXAM_RE.test(s)) return 0;
  if (WORK_RE.test(s)) return 1;
  if (NOISE_RE.test(s)) return 3;
  return 2;
}

/**
 * 排序比較器：先比 tier，同 tier 比時間（effTs），無期限(-1)放同 tier 最後
 * @param {Object} a - 任務物件（需有 task 欄位）
 * @param {Object} b
 * @param {(t: Object) => number} effTsOf - 取有效時間戳（週期任務傳下次發生日；無期限傳 -1）
 */
export function compareTasksByPriority(a, b, effTsOf) {
  const ta = getTaskTier(a && a.task);
  const tb = getTaskTier(b && b.task);
  if (ta !== tb) return ta - tb;
  const ea = effTsOf(a);
  const eb = effTsOf(b);
  const aNone = ea === -1 || ea == null;
  const bNone = eb === -1 || eb == null;
  if (aNone && bNone) return 0;
  if (aNone) return 1;
  if (bNone) return -1;
  return ea - eb;
}
