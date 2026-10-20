import { Bot, InlineKeyboard } from "grammy";
import { initDatabase } from "./db.js";
import { handleMessage, handleCallbackQuery } from "./router.js";
import { processScheduledReminders } from "./task.js";
import { handleEmailNow, handleEmailStatus, runEmailDigest } from "./email_digest.js";
import { getNowTaipei } from "./time.js";

export default {
  async fetch(request, env, ctx) {
    await initDatabase(env);
    const bot = new Bot(env.BOT_TOKEN);
    await bot.init(); // 初始化機器人

    // --- 新增: /help 指令處理 ---
    bot.command("help", async (ctx) => {
      const helpMessage = `🐱 <b>喵～待辦事項機器人使用說明</b>

<b>基本指令喵：</b>
• <code>/list</code> - 查看待辦事項清單
• <code>/list [時間範圍]</code> - 查詢特定時間範圍的任務
  • 例如：<code>/list today</code>, <code>/list tomorrow</code>, <code>/list this week</code>
• <code>/history</code> - 查看已完成的任務歷史
• <code>/history [時間範圍]</code> - 查詢特定時間範圍的歷史記錄

 <b>任務建立喵：</b>
• 直接輸入任務描述，例如："提醒我明天下午3點開會"
  • 支援自然語言時間表達：今天、明天、後天、週一、下週、本月、明年等
  • 支援週期性任務：每天、每週一、每月5號、每年1月1號等
• <b>一次新增多筆喵：</b>用「、」「；」換行或「還有」分隔，例如：
  • <code>明天買牛奶、麵包、雞蛋</code>
  • <code>今天下午3點開會，明天早上9點看醫生</code>
  • 系統會逐筆做邏輯檢查（空任務/重複/過去時間/規則格式/全天不一致/與既有任務重複），有問題的會標示 ⛔ 並略過，只儲存有效筆數

<b>例行性任務查詢喵：</b>
• <code>/list 例行</code> 或 <code>/list 重複</code> - 查看所有週期性任務
• <code>/list 每天</code>, <code>/list 每週</code>, <code>/list 每月</code>, <code>/list 每年</code> - 查詢特定類型的週期性任務

<b>互動功能喵：</b>
• 點擊任務旁邊的 ✅ 確認儲存喵 按鈕來保存任務
• 點擊 🤖 AI重新判斷喵 可以讓AI重新解析您的任務描述
• 點擊 🗑️ 管理喵 可以刪除任務

<b>時間格式支援喵：</b>
• 24小時制：21:00, 20:30
• 12小時制：9pm, 8:30am
• 中文時間：9點、晚上8點58分
• 日期格式：1月1號、Jan 1st

 <b>信箱摘要喵（Email Digest）：</b>
 • <code>/email_now</code> - 立即抓新信並產生 AI 分類摘要：發現「待辦型」(繳作業/繳費/回表單等) 會<b>自動加入待辦</b>；報名型活動只做摘要喵
 • <code>/email_status</code> - 查看信箱連線設定、摘要模型與上次摘要時間
 • 每天早上 9 點 (台北時間) 自動推送一次摘要喵
 • 設定方式 1（最簡單）：在 Cloudflare 設定 secrets
   - <code>POP3_HOST</code> = msa.ntu.edu.tw
   - <code>POP3_PORT</code> = 995
   - <code>POP3_TLS</code> = tls（其他選項：starttls / none）
   - <code>POP3_USER</code> = 你的學號（不用加 @ntu.edu.tw）
   - <code>POP3_PASS</code> = 你的計中密碼
   - <code>DIGEST_CHAT_ID</code> = 接收摘要的 chat id（通常是你的 Telegram user id）
 • 設定方式 2（進階、支持多信箱）：設定一個 <code>EMAIL_ACCOUNTS</code> secret 放 JSON 陣列，一格一個信箱：
   <code>[{"name":"ntu","protocol":"pop3","host":"msa.ntu.edu.tw","port":995,"mode":"tls","user":"b15xxxxxx","pass":"密碼","chat_id":"123","lookback_hours":48,"max_mails":25,"email_model":"openai/gpt-6-luna","redact_patterns":["王小華","TA 小明"]}]</code>
 • 支援的 protocol 目前有 <code>pop3</code>；<code>imap</code> 之後可直接加在 EMAIL_ACCOUNTS 而不必改程式喵
 • AI 模型分工：<b>郵件摘要</b>用 <code>openai/gpt-6-luna</code>（可用 <code>EMAIL_AI_MODEL</code> secret 或 EMAIL_ACCOUNTS 的 <code>email_model</code> 覆寫）；一般<strong>一句話任務辨識</strong>維持輕量 <code>openai-fast</code> 省成本
 • 若要加強去識別化（人名、組織等），可設定 <code>REDACT_PATTERNS</code> secret，一行一個關鍵字或 <code>re:正規式</code>；送 AI 前與 AI 輸出後都會自動遮蔽

💡 喵～小提示：如果AI解析結果不正確，可以點擊「AI重新判斷喵」按鈕讓AI重新分析！`;

      await ctx.reply(helpMessage, { parse_mode: "HTML" });
    });

    // --- 新增: /email_now /email_status 指令處理 ---
    bot.command("email_now", async (ctx) => {
      await handleEmailNow(ctx, env);
    });

    bot.command("email_status", async (ctx) => {
      await handleEmailStatus(ctx, env);
    });

    // --- 1. 訊息接收與分流 ---
    bot.on("message:text", async (ctx) => {
      await handleMessage(ctx, env);
    });

    // --- 7. Callback 互動處理 ---
    bot.on("callback_query:data", async (ctx) => {
      await handleCallbackQuery(ctx, env);
    });

    // 使用 Grammy 的 webhook 适配器
    const update = await request.json();
    await bot.handleUpdate(update);
    return new Response("OK");
  },

  // --- 9. 定時任務 (Cron Trigger) ---
  async scheduled(event, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);
    await processScheduledReminders(bot, env);

    // --- 每日 Email 摘要 (台北時間早上 9 點，每 2 分鐘 cron tick 的第一次觸發會跑到) ---
    try {
      const nowTaipei = getNowTaipei();
      const h = nowTaipei.getUTCHours();
      const m = nowTaipei.getUTCMinutes();
      if (h === 9 && m < 2) {
        await runEmailDigest(bot.api, env, { force: false, log: (s) => console.log("[email_digest cron]", s) });
      }
    } catch (e) {
      console.error("[email_digest cron] 失敗:", e);
    }
  }
};