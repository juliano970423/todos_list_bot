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
}

// 新增待辦事項
async function addTodo(env, userId, task, remindAt, cronRule, allDay) {
  await env.DB.prepare("INSERT INTO todos (user_id, task, remind_at, cron_rule, all_day, status) VALUES (?, ?, ?, ?, ?, 0)")
    .bind(userId, task, parseInt(remindAt), cronRule === 'n' ? null : cronRule, parseInt(allDay)).run();
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
  getTodos,
  getTodosByTimeRange,
  updateTodoStatus,
  deleteTodosByIds,
  updateCronTodoNextTime,
  addHistory
};