// db.js - 資料庫操作模組
import { Bot, InlineKeyboard } from "grammy";

// 資料庫初始化
async function initDatabase(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task TEXT NOT NULL,
        remind_at INTEGER NOT NULL,
        cron_rule TEXT,
        all_day INTEGER DEFAULT 0,
        status INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error("資料庫初始化失敗:", e.message);
  }

  // Email digest 狀態表（每個信箱一筆）
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS email_state (
        mailbox_key TEXT PRIMARY KEY,
        processed_uidls TEXT DEFAULT '[]',
        last_digest_date TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error("email_state 初始化失敗:", e.message);
  }

  // 每日彙整狀態表（kind: morning/evening；當日防漏發、防重複發送）
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS report_state (
        kind TEXT PRIMARY KEY,
        last_date TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error("report_state 初始化失敗:", e.message);
  }

  // 管理模式勾選狀態（callback_data 64-byte 上限放不下 id 清單，改存 DB）
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pending_delete (
        user_id TEXT PRIMARY KEY,
        ids TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error("pending_delete 初始化失敗:", e.message);
  }
}

// --- email_state 操作 ---

async function getEmailState(env, mailboxKey) {
  try {
    const row = await env.DB.prepare("SELECT * FROM email_state WHERE mailbox_key = ?").bind(mailboxKey).first();
    if (!row) return { processed: [], lastDigestDate: "" };
    let processed = [];
    try { processed = JSON.parse(row.processed_uidls || "[]"); } catch { processed = []; }
    return { processed, lastDigestDate: row.last_digest_date || "" };
  } catch {
    return { processed: [], lastDigestDate: "" };
  }
}

async function saveEmailState(env, mailboxKey, processed, lastDigestDate) {
  // processed 上限 500，超出時保留最新的（陣列尾端）
  let arr = Array.isArray(processed) ? processed : [];
  if (arr.length > 500) arr = arr.slice(-500);
  await env.DB.prepare(`
    INSERT INTO email_state (mailbox_key, processed_uidls, last_digest_date, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mailbox_key) DO UPDATE SET
      processed_uidls = excluded.processed_uidls,
      last_digest_date = excluded.last_digest_date,
      updated_at = CURRENT_TIMESTAMP
  `).bind(mailboxKey, JSON.stringify(arr), String(lastDigestDate || "")).run();
}

// --- report_state 操作（每日彙整狀態：kind 當天最後成功發送日） ---

async function getReportState(env, kind) {
  try {
    const row = await env.DB.prepare("SELECT last_date FROM report_state WHERE kind = ?").bind(kind).first();
    return row ? (row.last_date || "") : "";
  } catch {
    return "";
  }
}

async function saveReportState(env, kind, lastDate) {
  try {
    await env.DB.prepare(`
      INSERT INTO report_state (kind, last_date, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(kind) DO UPDATE SET
        last_date = excluded.last_date,
        updated_at = CURRENT_TIMESTAMP
    `).bind(kind, String(lastDate || "")).run();
  } catch (e) {
    console.error("report_state 儲存失敗:", e.message);
  }
}

// 新增待辦事項
async function addTodo(env, userId, task, remindAt, cronRule, allDay) {
  await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, all_day, status) VALUES (?, ?, ?, ?, ?, 0)")
    .bind(userId, task, parseInt(remindAt), cronRule === 'n' ? null : cronRule, parseInt(allDay)).run();
}

// 批次新增待辦事項 (一次新增多筆)
// items: [{task, remindAt, cronRule, allDay}]
async function addTodosBatch(env, userId, items) {
  if (!items || !items.length) return 0;
  const stmts = items.map(it =>
    env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, all_day, status) VALUES (?, ?, ?, ?, ?, 0)")
      .bind(
        userId,
        String(it.task).slice(0, 200),
        parseInt(it.remindAt),
        (!it.cronRule || it.cronRule === 'n' || it.cronRule === 'null') ? null : it.cronRule,
        parseInt(it.allDay) ? 1 : 0
      )
  );
  // D1 batch 原子寫入；非 D1 環境 fallback 逐筆
  if (env.DB.batch) {
    await env.DB.batch(stmts);
  } else {
    for (const s of stmts) await s.run();
  }
  return items.length;
}

// 獲取待辦清單
async function getTodos(env, userId, status = 0, limit = 200) {
  // status 0 = 未完成（含 2「已提醒待確認」）：清單/管理/報告一律視為活躍任務；
  // status 1 = 已完成（歷史）。提醒觸發查詢另行寫死 status=0（已提醒過的不重敲）。
  const sql = status === 0
    ? "SELECT * FROM todos WHERE user_id = ? AND status IN (0, 2) LIMIT ?"
    : "SELECT * FROM todos WHERE user_id = ? AND status = ? LIMIT ?";
  const { results } = await env.DB.prepare(sql).bind(...(status === 0 ? [userId, limit] : [userId, status, limit])).all();
  return results;
}

// 獲取指定時間範圍內的待辦
async function getTodosByTimeRange(env, userId, startTs, endTs, status = 0) {
  const sql = status === 0
    ? "SELECT * FROM todos WHERE user_id = ? AND status IN (0, 2) AND remind_at BETWEEN ? AND ?"
    : "SELECT * FROM todos WHERE user_id = ? AND status = ? AND remind_at BETWEEN ? AND ?";
  const { results } = await env.DB.prepare(sql).bind(...(status === 0 ? [userId, startTs, endTs] : [userId, status, startTs, endTs])).all();
  return results;
}

// 更新待辦狀態
async function updateTodoStatus(env, todoId, status) {
  await env.DB.prepare("UPDATE todos SET status = ? WHERE id = ?").bind(status, todoId).run();
}

// 刪除待辦
async function deleteTodosByIds(env, ids, userId) {
  const placeholders = ids.map(()=>'?').join(',');
  await env.DB.prepare(`DELETE FROM todos WHERE id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
}

// 刪除指定狀態的待辦
async function deleteTodosByStatus(env, userId, status) {
  await env.DB.prepare("DELETE FROM todos WHERE user_id = ? AND status = ?").bind(userId, status).run();
}

// 更新循環任務的下次提醒時間
async function updateCronTodoNextTime(env, todoId, nextTs) {
  await env.DB.prepare("UPDATE todos SET remind_at = ? WHERE id = ?").bind(nextTs, todoId).run();
}

// --- pending_delete（管理模式勾選清單，DB 端保存避免 callback_data 超長） ---
async function getPendingDeleteIds(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT ids FROM pending_delete WHERE user_id = ?").bind(userId).first();
    if (!row) return [];
    const arr = JSON.parse(row.ids || "[]");
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

async function savePendingDeleteIds(env, userId, ids, context = "") {
  const arr = Array.isArray(ids) ? ids.map(String) : [];
  await env.DB.prepare(`
    INSERT INTO pending_delete (user_id, ids, context, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      ids = excluded.ids,
      context = excluded.context,
      updated_at = CURRENT_TIMESTAMP
  `).bind(String(userId), JSON.stringify(arr), String(context || "")).run();
}

async function clearPendingDelete(env, userId) {
  try {
    await env.DB.prepare("DELETE FROM pending_delete WHERE user_id = ?").bind(String(userId)).run();
  } catch { /* 初始化前的清理失敗不影響流程 */ }
}

// 標完成（批次、限本人）：status 2（已提醒待確認）或 0 -> 1（進 /history）
async function markTodosDone(env, ids, userId) {
  let n = 0;
  for (const id of ids) {
    await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ? AND user_id = ? AND status IN (0, 2)").bind(id, String(userId)).run();
    n += 1;
  }
  return n;
}

// 「還沒」= 侀眠：推到明天同一時刻再提醒（status 回 0；全日任務落明天 00:00，夜間靜音規則照樣適用）
async function snoozeTodo(env, todoId, userId) {
  await env.DB.prepare("UPDATE todos SET status = 0, remind_at = remind_at + 86400 WHERE id = ? AND user_id = ? AND status = 2").bind(todoId, String(userId)).run();
}

// 添加歷史記錄
async function addHistory(env, userId, task, remindAt) {
  await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 1)").bind(userId, task, remindAt).run();
}

export {
  initDatabase,
  addTodo,
  addTodosBatch,
  getTodos,
  getTodosByTimeRange,
  updateTodoStatus,
  markTodosDone,
  snoozeTodo,
  deleteTodosByIds,
  deleteTodosByStatus,
  updateCronTodoNextTime,
  addHistory,
  getEmailState,
  saveEmailState,
  getReportState,
  saveReportState,
  getPendingDeleteIds,
  savePendingDeleteIds,
  clearPendingDelete
};