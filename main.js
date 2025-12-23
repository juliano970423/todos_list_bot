import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

// 定義台灣時區偏移 (UTC+8)
const TAIPEI_TIMEZONE_OFFSET = 8 * 60; // 8 hours in minutes
const NO_TIME_LIMIT = -1; // 特殊值表示無時間限制
const REMINDER_TYPE_ONCE = 0; // 一次性提醒
const REMINDER_TYPE_DAILY = 1; // 每天提醒

// 定時提醒時間（台灣時間）
const MORNING_REMINDER_HOUR = 9; // 早上9點
const EVENING_REMINDER_HOUR = 20; // 晚上8點

// 狀態追蹤
const userParsingState = new Map();

export default {
  async fetch(request, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);

    // 指令：開始
    bot.command("start", (ctx) => {
      return ctx.reply("🤖 Todo 提醒機器人 (台灣時區)\n\n直接輸入任務，例如：\n• 「買牛奶 明天下午2點」\n• 「09:00 開會」\n• 「買牛奶」（每天提醒）\n\n所有時間都以台灣時間 (UTC+8) 計算！");
    });

    // 指令：查看清單
    bot.command("list", async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const { results } = await env.DB.prepare(
          "SELECT * FROM todos WHERE user_id = ? AND status = 0 ORDER BY remind_at ASC, created_at ASC"
        ).bind(userId).all();
        
        if (results.length === 0) return ctx.reply("📭 目前沒有待辦事項。");
        
        let replyText = "📝 你的待辦清單 (台灣時間)：\n\n";
        const keyboard = new InlineKeyboard();
        
        results.forEach(todo => {
          if (todo.reminder_type === REMINDER_TYPE_DAILY) {
            replyText += `• ${todo.task} (🔄 每天 ${MORNING_REMINDER_HOUR}:00 和 ${EVENING_REMINDER_HOUR}:00 提醒)\n`;
          } else if (todo.remind_at === NO_TIME_LIMIT) {
            replyText += `• ${todo.task} (⏰ 無時間限制)\n`;
          } else {
            const timeStr = unixToTaipeiString(todo.remind_at);
            replyText += `• ${todo.task} (⏰ ${timeStr})\n`;
          }
          keyboard.text(`🗑️ 刪除`, `del_${todo.id}`).row();
        });

        await ctx.reply(replyText, { reply_markup: keyboard });
      } catch (error) {
        console.error('list command error:', error);
        return ctx.reply('❌ 系統錯誤，請稍後再試');
      }
    });

    // 處理按鈕點擊
    bot.on("callback_query:data", async (ctx) => {
      const userId = ctx.from.id.toString();
      const state = userParsingState.get(userId);
      
      try {
        if (ctx.callbackQuery.data.startsWith("del_")) {
          // 原有的刪除功能
          const todoId = ctx.callbackQuery.data.split("_")[1];
          await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(todoId).run();
          await ctx.answerCallbackQuery("任務已刪除！");
          await ctx.editMessageText("✅ 任務已從清單中移除。");
        } 
        else if (ctx.callbackQuery.data === "confirm_time" && state) {
          // 確認時間
          await ctx.answerCallbackQuery("✅ 時間已確認");
          await saveTask(ctx, env, state);
          userParsingState.delete(userId);
        } 
        else if (ctx.callbackQuery.data === "reparse_with_ai" && state) {
          // 用 AI 重新解析
          await ctx.answerCallbackQuery("🤖 使用 AI 重新解析...");
          await reparseWithAI(ctx, env, state);
        }
        else if (ctx.callbackQuery.data === "daily_reminder" && state) {
          // 設定為每天提醒
          await ctx.answerCallbackQuery(`🔄 設定為每天 ${MORNING_REMINDER_HOUR}:00 和 ${EVENING_REMINDER_HOUR}:00 提醒`);
          state.reminder_type = REMINDER_TYPE_DAILY;
          await saveTask(ctx, env, state);
          userParsingState.delete(userId);
        }
        else if (ctx.callbackQuery.data === "no_time_limit" && state) {
          // 設定為無時間限制（不提醒）
          await ctx.answerCallbackQuery("⏰ 設定為無時間限制（不提醒）");
          state.reminder_type = REMINDER_TYPE_ONCE;
          state.remind_at = NO_TIME_LIMIT;
          await saveTask(ctx, env, state);
          userParsingState.delete(userId);
        }
      } catch (error) {
        console.error('callback error:', error);
        await ctx.answerCallbackQuery("❌ 操作失敗");
      }
    });

    // 通用工具函數
    function unixToTaipeiString(unixTimestamp) {
      if (unixTimestamp === NO_TIME_LIMIT) return "無時間限制";
      const date = new Date(unixTimestamp * 1000);
      return date.toLocaleString('zh-TW', { 
        timeZone: 'Asia/Taipei', 
        month: 'numeric', day: 'numeric', 
        hour: '2-digit', minute: '2-digit', hour12: false 
      });
    }

    function getTaipeiNow() {
      const now = new Date();
      return new Date(now.getTime() + TAIPEI_TIMEZONE_OFFSET * 60000);
    }

    function convertToTaipeiTime(date) {
      return new Date(date.getTime() + TAIPEI_TIMEZONE_OFFSET * 60000);
    }

    function convertFromTaipeiTime(date) {
      return new Date(date.getTime() - TAIPEI_TIMEZONE_OFFSET * 60000);
    }

    function isSameDay(date1, date2) {
      return date1.getFullYear() === date2.getFullYear() &&
             date1.getMonth() === date2.getMonth() &&
             date1.getDate() === date2.getDate();
    }

    // 修正 chrono 時區問題
    function parseTimeWithChrono(text) {
      try {
        const refDate = getTaipeiNow();
        const results = chrono.parse(text, refDate, { forwardDate: true });
        
        if (results.length === 0) {
          return null; // 沒有找到時間
        }

        let targetDate = results[0].date();
        const taipeiTargetDate = convertToTaipeiTime(targetDate);
        
        return {
          date: taipeiTargetDate,
          text: results[0].text,
          confidence: 0.9,
          method: 'chrono'
        };
      } catch (error) {
        console.error('Chrono parse error:', error);
        return null;
      }
    }

    // AI 時間解析函數
    async function parseTimeWithAI(text, env) {
      try {
        const currentTime = getTaipeiNow();
        const prompt = buildTimeParsePrompt(text, currentTime);
        
        const response = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.POLLINATIONS_API_KEY}`
          },
          body: JSON.stringify({
            model: "nova-micro",
            messages: [
              {
                role: "user",
                content: prompt
              }
            ],
            temperature: 0.2,
            max_tokens: 200
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Pollinations API error:', errorText);
          return null;
        }

        const result = await response.json();
        return extractTimeFromAIResponse(result, currentTime);
      } catch (error) {
        console.error('AI parse error:', error);
        return null;
      }
    }

    // 修正時區問題的提示詞
    function buildTimeParsePrompt(text, currentTime) {
      const currentTWStr = currentTime.toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      
      const dayOfWeek = currentTime.toLocaleDateString('zh-TW', { weekday: 'long' });
      
      return `你是一個專業的時間解析器，專門處理台灣用戶的時間表達。請嚴格遵守以下規則：

【重要設定】
• 時區：台灣時區 UTC+8 (Asia/Taipei)
• 現在時間：${currentTWStr}（${dayOfWeek}）
• 語言：繁體中文
• 所有時間計算都基於台灣時間

【輸入訊息】
"${text}"

【解析規則】
1. 從訊息中判斷是否有明確的時間資訊
2. 如果有明確時間：
   - 時間格式必須是 ISO 8601 且包含台灣時區：YYYY-MM-DDTHH:mm:ss+08:00
   - 如果是相對時間（明天、下週等），基於現在時間 ${currentTWStr} 計算
   - 處理中文時間表達：上午/下午、點/分、今天/明天/後天/週末
3. 如果沒有明確時間（例如只有「買牛奶」、「記得吃藥」）：
   - time 欄位設定為 "NO_TIME_LIMIT"
   - confidence 設定為 0.99
   - reasoning 說明「無明確時間資訊，建議每天提醒」
4. 任務內容要完整保留，不要修改原意
5. 絕對不要使用 UTC 時間，所有時間必須是台灣時間

【輸出格式】（嚴格 JSON，不要任何其他文字）
{
  "task": "提取的任務內容（完整句子）",
  "time": "ISO8601時間字串（台灣時區+08:00）或字串 \"NO_TIME_LIMIT\"",
  "confidence": 0.0-1.0,
  "reasoning": "簡短解析理由（繁體中文）"
}

【正確範例】
範例1（有明確時間）：
現在時間：2024-12-23 14:30（星期一）
輸入："9點 開會"
輸出：{
  "task": "開會",
  "time": "2024-12-24T09:00:00+08:00",
  "confidence": 0.95,
  "reasoning": "9點是早上9點，今天9點已過，設定為明天早上9點"
}

範例2（有明確時間）：
輸入："家庭聚餐 週末"
輸出：{
  "task": "家庭聚餐",
  "time": "2024-12-28T18:00:00+08:00",
  "confidence": 0.85,
  "reasoning": "本週末是28-29日，設定為週六晚上6點"
}

範例3（無明確時間）：
輸入："買牛奶"
輸出：{
  "task": "買牛奶",
  "time": "NO_TIME_LIMIT",
  "confidence": 0.99,
  "reasoning": "無明確時間資訊，建議每天早上9點和晚上8點提醒"
}

範例4（無明確時間）：
輸入："記得吃藥"
輸出：{
  "task": "記得吃藥",
  "time": "NO_TIME_LIMIT",
  "confidence": 0.99,
  "reasoning": "無明確時間資訊，建議每天早上9點和晚上8點提醒"
}

【重要提醒】
• 絕對不要回傳 UTC 時間 (Z 結尾)
• 必須包含 +08:00 時區資訊（如果有時間）
• 當無明確時間時，time 欄位必須是字串 "NO_TIME_LIMIT"
• 時間必須是台灣時間

【開始解析】
"${text}"
`;
    }

    // 強健的回應解析
    function extractTimeFromAIResponse(response, currentTime) {
      try {
        if (!response.choices || !response.choices[0]?.message?.content) {
          console.error('Invalid AI response format:', response);
          return null;
        }
        
        const content = response.choices[0].message.content;
        let clean = content.trim()
          .replace(/^```json\n?/i, '')
          .replace(/^```javascript\n?/i, '')
          .replace(/\n?```$/i, '')
          .replace(/```/g, '');

        // 嘗試解析 JSON
        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch (e) {
          const jsonMatch = clean.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('No valid JSON found');
          }
        }

        if (!parsed.time) {
          return null;
        }

        // 處理無時間限制的情況
        if (parsed.time === "NO_TIME_LIMIT" || parsed.time === "null" || parsed.time === null) {
          return {
            task: parsed.task || '',
            noTimeLimit: true,
            confidence: parsed.confidence || 0.99,
            reasoning: parsed.reasoning || '無明確時間資訊，建議每天提醒'
          };
        }

        let timeStr = parsed.time;
        
        // 確保包含台灣時區
        if (!timeStr.includes('+08:00')) {
          if (timeStr.includes('Z')) {
            // 將 UTC 時間轉為台灣時間
            const utcDate = new Date(timeStr);
            const taipeiDate = new Date(utcDate.getTime() + TAIPEI_TIMEZONE_OFFSET * 60000);
            timeStr = taipeiDate.toISOString().replace('Z', '+08:00');
          } else {
            // 添加台灣時區
            if (!timeStr.includes('T')) {
              timeStr = timeStr.replace(' ', 'T') + ':00+08:00';
            } else {
              timeStr = timeStr + '+08:00';
            }
          }
        }

        const date = new Date(timeStr);
        
        // 再次確認是有效日期
        if (isNaN(date.getTime())) {
          return null;
        }

        return {
          date: date,
          task: parsed.task || '',
          confidence: parsed.confidence || 0.7,
          reasoning: parsed.reasoning || '',
          rawTime: parsed.time
        };
      } catch (error) {
        console.error('AI response parsing error:', error);
        return null;
      }
    }

    // 用 AI 重新解析
    async function reparseWithAI(ctx, env, state) {
      try {
        await ctx.reply("🤖 正在使用 AI 重新解析時間和任務 (台灣時區)...");
        
        const aiResult = await parseTimeWithAI(state.originalText, env);
        
        if (!aiResult) {
          await ctx.reply("❌ AI 解析失敗，請手動輸入時間或重新描述任務");
          return;
        }

        if (aiResult.noTimeLimit) {
          // 無時間限制，但建議每天提醒
          userParsingState.set(ctx.from.id.toString(), {
            ...state,
            task: aiResult.task || state.task,
            noTimeLimit: true,
            reminder_type: REMINDER_TYPE_DAILY, // 預設設為每天提醒
            confidence: 'ai',
            aiConfidence: aiResult.confidence,
            aiReasoning: aiResult.reasoning
          });

          const keyboard = new InlineKeyboard()
            .text("🔄 每天提醒", "daily_reminder")
            .text("⏰ 無時間限制（不提醒）", "no_time_limit")
            .row();

          await ctx.reply(
            `🤖 AI 解析結果：\n` +
            `📌 任務：${aiResult.task}\n` +
            `⏰ 建議：每天早上${MORNING_REMINDER_HOUR}:00和晚上${EVENING_REMINDER_HOUR}:00提醒\n` +
            `🎯 準確度：${Math.round((aiResult.confidence || 0.99) * 100)}%\n` +
            `💡 理由：${aiResult.reasoning}\n\n` +
            `要如何設定？`,
            { reply_markup: keyboard }
          );
          return;
        }

        // 有時間限制
        const utcDate = convertFromTaipeiTime(aiResult.date);
        const remindAt = Math.floor(utcDate.getTime() / 1000);

        // 準備確認訊息 (顯示台灣時間)
        const displayTime = aiResult.date.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });

        // 更新狀態
        userParsingState.set(ctx.from.id.toString(), {
          ...state,
          parsedTime: aiResult.date, // 儲存台灣時間用於顯示
          utcTime: utcDate,          // 儲存 UTC 時間用於儲存
          task: aiResult.task || state.task,
          extractedText: aiResult.rawTime || '',
          confidence: 'ai',
          aiConfidence: aiResult.confidence,
          aiReasoning: aiResult.reasoning,
          reminder_type: REMINDER_TYPE_ONCE // 一次性提醒
        });

        const keyboard = new InlineKeyboard()
          .text("✅ 採用 AI 結果", "confirm_time")
          .text("🔄 再試一次", "reparse_with_ai")
          .row();

        await ctx.reply(
          `🤖 AI 解析結果 (台灣時間)：\n` +
          `📌 任務：${aiResult.task}\n` +
          `🕒 時間：${displayTime}\n` +
          `🎯 準確度：${Math.round((aiResult.confidence || 0.7) * 100)}%\n` +
          `💡 理由：${aiResult.reasoning}\n\n` +
          `要採用這個結果嗎？`,
          { reply_markup: keyboard }
        );

      } catch (error) {
        console.error('AI reparse error:', error);
        await ctx.reply("❌ AI 服務暫時不可用，請稍後再試");
      }
    }

    // 直接用 AI 解析
    async function parseWithAIDirectly(ctx, env, text) {
      try {
        await ctx.reply("🔍 本地解析失敗，正在使用 AI 重新解析 (台灣時區)...");
        
        const aiResult = await parseTimeWithAI(text, env);
        
        if (!aiResult) {
          // 如果 AI 也失敗，提供每天提醒選項
          userParsingState.set(ctx.from.id.toString(), {
            awaitingConfirmation: true,
            originalText: text,
            task: text.trim(),
            noTimeLimit: true,
            reminder_type: REMINDER_TYPE_DAILY, // 預設每天提醒
            confidence: 'manual',
            method: 'manual'
          });

          const keyboard = new InlineKeyboard()
            .text("🔄 每天提醒", "daily_reminder")
            .text("⏰ 無時間限制（不提醒）", "no_time_limit")
            .row();

          await ctx.reply(
            `❌ 無法解析時間\n` +
            `📌 任務：${text.trim()}\n` +
            `⏰ 建議：每天早上${MORNING_REMINDER_HOUR}:00和晚上${EVENING_REMINDER_HOUR}:00提醒\n\n` +
            `要如何設定？`,
            { reply_markup: keyboard }
          );
          return;
        }

        if (aiResult.noTimeLimit) {
          // 無時間限制，但建議每天提醒
          userParsingState.set(ctx.from.id.toString(), {
            awaitingConfirmation: true,
            originalText: text,
            task: aiResult.task,
            noTimeLimit: true,
            reminder_type: REMINDER_TYPE_DAILY, // 預設每天提醒
            confidence: 'ai',
            aiConfidence: aiResult.confidence,
            aiReasoning: aiResult.reasoning
          });

          const keyboard = new InlineKeyboard()
            .text("🔄 每天提醒", "daily_reminder")
            .text("⏰ 無時間限制（不提醒）", "no_time_limit")
            .row();

          await ctx.reply(
            `🤖 AI 解析結果：\n` +
            `📌 任務：${aiResult.task}\n` +
            `⏰ 建議：每天早上${MORNING_REMINDER_HOUR}:00和晚上${EVENING_REMINDER_HOUR}:00提醒\n` +
            `🎯 準確度：${Math.round((aiResult.confidence || 0.99) * 100)}%\n` +
            `💡 理由：${aiResult.reasoning}\n\n` +
            `要如何設定？`,
            { reply_markup: keyboard }
          );
          return;
        }

        // 有時間限制
        const utcDate = convertFromTaipeiTime(aiResult.date);
        const nowSeconds = Math.floor(Date.now() / 1000);
        let remindAt = Math.floor(utcDate.getTime() / 1000);

        // 確保是未來時間 (UTC 比較)
        if (remindAt <= nowSeconds) {
          remindAt += 86400;
          const newTaipeiDate = new Date(remindAt * 1000);
          aiResult.date = convertToTaipeiTime(newTaipeiDate);
        }

        const displayTime = aiResult.date.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });

        const keyboard = new InlineKeyboard()
          .text("✅ 時間正確", "confirm_time")
          .text("🔄 重新解析", "reparse_with_ai")
          .row();

        // 儲存狀態等待確認
        userParsingState.set(ctx.from.id.toString(), {
          awaitingConfirmation: true,
          originalText: text,
          task: aiResult.task,
          parsedTime: aiResult.date, // 台灣時間
          utcTime: new Date(remindAt * 1000), // UTC 時間
          extractedText: aiResult.rawTime || '',
          confidence: 'ai',
          aiConfidence: aiResult.confidence,
          aiReasoning: aiResult.reasoning,
          reminder_type: REMINDER_TYPE_ONCE // 一次性提醒
        });

        await ctx.reply(
          `🤖 AI 解析結果 (台灣時間)：\n` +
          `📌 任務：${aiResult.task}\n` +
          `🕒 時間：${displayTime}\n` +
          `🎯 準確度：${Math.round((aiResult.confidence || 0.7) * 100)}%\n\n` +
          `這個時間正確嗎？`,
          { reply_markup: keyboard }
        );

      } catch (error) {
        console.error('Direct AI parse error:', error);
        // AI 失敗時，提供每天提醒選項
        userParsingState.set(ctx.from.id.toString(), {
          awaitingConfirmation: true,
          originalText: text,
          task: text.trim(),
          noTimeLimit: true,
          reminder_type: REMINDER_TYPE_DAILY, // 預設每天提醒
          confidence: 'manual',
          method: 'manual'
        });

        const keyboard = new InlineKeyboard()
          .text("🔄 每天提醒", "daily_reminder")
          .text("⏰ 無時間限制（不提醒）", "no_time_limit")
          .row();

        await ctx.reply(
          `❌ AI 服務暫時不可用\n` +
          `📌 任務：${text.trim()}\n` +
          `⏰ 建議：每天早上${MORNING_REMINDER_HOUR}:00和晚上${EVENING_REMINDER_HOUR}:00提醒\n\n` +
          `要如何設定？`,
          { reply_markup: keyboard }
        );
      }
    }

    // 儲存任務到資料庫
    async function saveTask(ctx, env, state) {
      const userId = ctx.from.id.toString();
      
      try {
        if (state.noTimeLimit) {
          if (state.reminder_type === REMINDER_TYPE_DAILY) {
            // 每天提醒的任務
            await env.DB.prepare(
              "INSERT INTO todos (user_id, task, remind_at, status, reminder_type, last_reminded) VALUES (?, ?, ?, 0, ?, NULL)"
            ).bind(userId, state.task, NO_TIME_LIMIT, REMINDER_TYPE_DAILY).run();

            await ctx.reply(
              `✅ 任務已設定成功！\n\n` +
              `📌 內容：${state.task}\n` +
              `🔄 提醒頻率：每天早上${MORNING_REMINDER_HOUR}:00和晚上${EVENING_REMINDER_HOUR}:00\n` +
              `🔍 來源：${state.confidence === 'ai' ? `🤖 AI 解析` : '✅ 本地解析'}`
            );
          } else {
            // 無時間限制且不提醒
            await env.DB.prepare(
              "INSERT INTO todos (user_id, task, remind_at, status, reminder_type, last_reminded) VALUES (?, ?, ?, 0, ?, NULL)"
            ).bind(userId, state.task, NO_TIME_LIMIT, REMINDER_TYPE_ONCE).run();

            await ctx.reply(
              `✅ 任務已設定成功！\n\n` +
              `📌 內容：${state.task}\n` +
              `⏰ 時間：無時間限制（不提醒）\n` +
              `🔍 來源：${state.confidence === 'ai' ? `🤖 AI 解析` : '✅ 本地解析'}`
            );
          }
        } else {
          // 有時間限制的任務（一次性提醒）
          let utcTime;
          if (state.utcTime) {
            utcTime = state.utcTime;
          } else {
            utcTime = convertFromTaipeiTime(state.parsedTime);
          }
          
          const remindAt = Math.floor(utcTime.getTime() / 1000);
          const nowSeconds = Math.floor(Date.now() / 1000);

          // 確保是未來時間
          if (remindAt <= nowSeconds) {
            utcTime = new Date((remindAt + 86400) * 1000);
          }

          await env.DB.prepare(
            "INSERT INTO todos (user_id, task, remind_at, status, reminder_type, last_reminded) VALUES (?, ?, ?, 0, ?, NULL)"
          ).bind(userId, state.task, Math.floor(utcTime.getTime() / 1000), REMINDER_TYPE_ONCE).run();

          // 顯示台灣時間
          const displayTime = state.parsedTime.toLocaleString('zh-TW', { 
            timeZone: 'Asia/Taipei',
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
          });

          const sourceText = state.confidence === 'ai' ? 
            `🤖 AI 解析 (${Math.round(state.aiConfidence * 100)}%)` : 
            '✅ 本地解析 (台灣時區)';

          await ctx.reply(
            `✅ 任務已設定成功！\n\n` +
            `📌 內容：${state.task}\n` +
            `⏰ 時間：${displayTime} (台灣時間)\n` +
            `🔍 來源：${sourceText}`
          );
        }
      } catch (error) {
        console.error('save task error:', error);
        await ctx.reply('❌ 儲存任務失敗，請稍後再試');
      }
    }

    // 核心邏輯：處理文字輸入
    bot.on("message:text", async (ctx) => {
      try {
        const text = ctx.message.text;
        const userId = ctx.from.id.toString();
        const nowSeconds = Math.floor(Date.now() / 1000);
        
        // 檢查是否是回應確認的訊息
        if (text.toLowerCase().includes('正確') || text.toLowerCase() === 'y') {
          const state = userParsingState.get(userId);
          if (state && state.awaitingConfirmation) {
            await saveTask(ctx, env, state);
            userParsingState.delete(userId);
            return;
          }
        }
        
        if (text.toLowerCase().includes('不正確') || text.toLowerCase() === 'n' || text.includes('重新解析')) {
          const state = userParsingState.get(userId);
          if (state && state.awaitingConfirmation) {
            userParsingState.delete(userId);
            await parseWithAIDirectly(ctx, env, state.originalText);
            return;
          }
        }

        if (text.toLowerCase().includes('無時間') || text.toLowerCase().includes('不限') || text.toLowerCase() === 'n') {
          const state = userParsingState.get(userId);
          if (state && state.awaitingConfirmation) {
            state.noTimeLimit = true;
            state.reminder_type = REMINDER_TYPE_ONCE; // 不提醒
            await saveTask(ctx, env, state);
            userParsingState.delete(userId);
            return;
          }
        }

        if (text.toLowerCase().includes('每天') || text.toLowerCase().includes('每日')) {
          const state = userParsingState.get(userId);
          if (state && state.awaitingConfirmation) {
            state.noTimeLimit = true;
            state.reminder_type = REMINDER_TYPE_DAILY; // 每天提醒
            await saveTask(ctx, env, state);
            userParsingState.delete(userId);
            return;
          }
        }

        // 階段1：先用本地解析 (修正時區)
        const parseResult = parseTimeWithChrono(text);
        
        if (!parseResult) {
          // 本地解析失敗，直接用 AI 解析
          return await parseWithAIDirectly(ctx, env, text);
        }

        let targetDate = parseResult.date;
        const extractedText = parseResult.text;
        const task = text.replace(extractedText, "").trim() || text;

        // 轉為 UTC 時間儲存
        const utcDate = convertFromTaipeiTime(targetDate);
        let remindAt = Math.floor(utcDate.getTime() / 1000);

        // 確保是未來時間 (UTC 比較)
        if (remindAt <= nowSeconds) {
          remindAt += 86400;
          const newUtcDate = new Date(remindAt * 1000);
          targetDate = convertToTaipeiTime(newUtcDate);
        }

        // 顯示台灣時間
        const displayTime = targetDate.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });

        // 儲存狀態等待確認
        userParsingState.set(userId, {
          awaitingConfirmation: true,
          originalText: text,
          task: task,
          parsedTime: targetDate, // 台灣時間
          utcTime: new Date(remindAt * 1000), // UTC 時間
          extractedText: extractedText,
          confidence: 'local',
          method: parseResult.method,
          reminder_type: REMINDER_TYPE_ONCE // 一次性提醒
        });

        const keyboard = new InlineKeyboard()
          .text("✅ 時間正確", "confirm_time")
          .text("🔄 用 AI 重新解析", "reparse_with_ai")
          .row();

        await ctx.reply(
          `⏰ 本地解析結果 (台灣時間)：\n` +
          `📌 任務：${task}\n` +
          `🕒 時間：${displayTime}\n\n` +
          `這個時間正確嗎？`,
          { reply_markup: keyboard }
        );

      } catch (error) {
        console.error('message processing error:', error);
        return ctx.reply('❌ 處理訊息時發生錯誤');
      }
    });

    // 初始化 bot 並處理請求
    if (request.method === "POST") {
      try {
        await bot.init();
        const update = await request.json();
        await bot.handleUpdate(update);
        return new Response(null, { status: 200 });
      } catch (error) {
        console.error('Handle update error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    } else {
      return new Response('OK', { status: 200 });
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const bot = new Bot(env.BOT_TOKEN);
      await bot.init();
      
      const now = Math.floor(Date.now() / 1000);
      const taipeiNow = getTaipeiNow();
      const currentHour = taipeiNow.getHours();
      const currentMinute = taipeiNow.getMinutes();
      
      console.log(`scheduled task running at Taiwan time: ${taipeiNow.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);

      // 1. 處理一次性提醒的任務
      const { results: onceReminders } = await env.DB.prepare(
        "SELECT * FROM todos WHERE status = 0 AND reminder_type = ? AND remind_at != ? AND remind_at <= ?"
      ).bind(REMINDER_TYPE_ONCE, NO_TIME_LIMIT, now).all();

      if (onceReminders?.length > 0) {
        for (const todo of onceReminders) {
          try {
            const taipeiTime = unixToTaipeiString(todo.remind_at);
            await bot.api.sendMessage(todo.user_id, `⏰ 時間到！(台灣時間 ${taipeiTime})\n任務：${todo.task}`);
            await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
          } catch (e) {
            console.error('once reminder error:', e);
          }
        }
      }

      // 2. 處理每天提醒的任務
      // 檢查是否接近提醒時間（給5分鐘緩衝）
      const isMorningTime = (currentHour === MORNING_REMINDER_HOUR - 1 && currentMinute >= 55) || 
                           (currentHour === MORNING_REMINDER_HOUR && currentMinute <= 5);
      
      const isEveningTime = (currentHour === EVENING_REMINDER_HOUR - 1 && currentMinute >= 55) || 
                           (currentHour === EVENING_REMINDER_HOUR && currentMinute <= 5);
      
      if (isMorningTime || isEveningTime) {
        console.log(`Daily reminder time check at ${taipeiNow.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
        
        // 獲取所有每天提醒的任務
        const { results: dailyReminders } = await env.DB.prepare(
          "SELECT * FROM todos WHERE reminder_type = ? AND status = 0"
        ).bind(REMINDER_TYPE_DAILY).all();

        if (dailyReminders?.length > 0) {
          // 計算今天的日期（台灣時間）
          const todayStart = new Date(taipeiNow);
          todayStart.setHours(0, 0, 0, 0);
          const todayStartUtc = convertFromTaipeiTime(todayStart);
          const todayStartUnix = Math.floor(todayStartUtc.getTime() / 1000);

          for (const todo of dailyReminders) {
            try {
              // 檢查是否已經在今天提醒過
              const lastReminded = todo.last_reminded ? new Date(todo.last_reminded * 1000) : null;
              const hasBeenRemindedToday = lastReminded && isSameDay(convertToTaipeiTime(lastReminded), taipeiNow);
              
              console.log(`Task ${todo.id}: last_reminded=${todo.last_reminded}, hasBeenRemindedToday=${hasBeenRemindedToday}, isMorningTime=${isMorningTime}, isEveningTime=${isEveningTime}`);

              if (!hasBeenRemindedToday) {
                // 決定是早上還是晚上的提醒
                const reminderType = isMorningTime ? '早上' : '晚上';
                const reminderTime = isMorningTime ? `${MORNING_REMINDER_HOUR}:00` : `${EVENING_REMINDER_HOUR}:00`;
                
                await bot.api.sendMessage(todo.user_id, `🔔 ${reminderType}提醒！\n任務：${todo.task}\n時間：${reminderTime} (台灣時間)`);
                
                // 更新最後提醒時間
                await env.DB.prepare(
                  "UPDATE todos SET last_reminded = ? WHERE id = ?"
                ).bind(now, todo.id).run();
                
                console.log(`Sent daily reminder for task ${todo.id}`);
              } else {
                console.log(`Task ${todo.id} already reminded today, skipping`);
              }
            } catch (e) {
              console.error(`Daily reminder error for task ${todo.id}:`, e);
            }
          }
        }
      }

    } catch (error) {
      console.error('scheduled error:', error);
    }
  }
};