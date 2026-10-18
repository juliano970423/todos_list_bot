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
async function getTodos(env, userId, status = 0) {
  const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = ?").bind(userId, status).all();
  return results;
}

// 獲取指定時間範圍內的待辦
async function getTodosByTimeRange(env, userId, startTs, endTs, status = 0) {
  const { results } = await env.DB.prepare("SELECT * FROM todos WHERE user_id = ? AND status = ? AND remind_at BETWEEN ? AND ?").bind(userId, status, startTs, endTs).all();
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
  deleteTodosByIds,
  deleteTodosByStatus,
  updateCronTodoNextTime,
  addHistory,
  getEmailState,
  saveEmailState
};