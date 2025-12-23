import { Bot, InlineKeyboard } from "grammy";
import * as chrono from "chrono-node";

// 狀態追蹤
const userParsingState = new Map();

export default {
  async fetch(request, env, ctx) {
    const bot = new Bot(env.BOT_TOKEN);

    // 指令：開始
    bot.command("start", (ctx) => {
      return ctx.reply("🤖 Todo 提醒機器人\n\n直接輸入任務加時間，例如：\n• 「買牛奶 明天下午 2 點」\n• 「開會 09:00」\n\n如果時間解析不正確，可以點擊按鈕用 AI 重新解析！");
    });

    // 指令：查看清單
    bot.command("list", async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const { results } = await env.DB.prepare(
          "SELECT * FROM todos WHERE user_id = ? AND status = 0 ORDER BY remind_at ASC"
        ).bind(userId).all();
        
        if (results.length === 0) return ctx.reply("📭 目前沒有待辦事項。");
        
        const keyboard = new InlineKeyboard();
        results.forEach(todo => {
          const timeStr = new Date(todo.remind_at * 1000).toLocaleString('zh-TW', { 
            timeZone: 'Asia/Taipei', 
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false 
          });
          keyboard.text(`🗑️ [${timeStr}] ${todo.task}`, `del_${todo.id}`).row();
        });

        await ctx.reply("📝 你的待辦清單：", { reply_markup: keyboard });
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
      } catch (error) {
        console.error('callback error:', error);
        await ctx.answerCallbackQuery("❌ 操作失敗");
      }
    });

    // AI 時間解析函數（使用正確的 Pollinations API）
    async function parseTimeWithAI(text, env) {
      try {
        const currentTime = new Date();
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
            max_tokens: 150
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Pollinations API error:', errorText);
          return null;
        }

        const result = await response.json();
        return extractTimeFromAIResponse(result);
      } catch (error) {
        console.error('AI parse error:', error);
        return null;
      }
    }

    // 單行精簡提示詞
    function buildTimeParsePrompt(text, currentTime) {
      return `NOW:${currentTime.toISOString()}|TXT:"${text}"|RULES:1.time_only 2.ISO8601 3.rel_now 4.zh|JSON:{t,c,o,r}|EX:"明天2點"→{"t":"2024-12-24T14:00+08:00","c":0.98,"o":"明天2點","r":"明天14:00"}|PARSE:`;
    }

    // 強健的回應解析（適配新API格式）
    function extractTimeFromAIResponse(response) {
      try {
        if (!response.choices || !response.choices[0]?.message?.content) {
          console.error('Invalid AI response format:', response);
          return null;
        }
        
        const content = response.choices[0].message.content;
        let clean = content.trim().replace(/```json|```/g, '');
        
        // 嘗試直接解析 JSON
        try {
          const parsed = JSON.parse(clean);
          if (parsed.t && parsed.t !== 'null') {
            const timeStr = parsed.t.includes('+') ? parsed.t : parsed.t + '+08:00';
            const date = new Date(timeStr);
            if (!isNaN(date.getTime())) {
              return {
                date: date,
                text: parsed.o || '',
                confidence: parsed.c || 0.7,
                reasoning: parsed.r || ''
              };
            }
          }
        } catch (e) {
          // 繼續嘗試其他方法
        }
        
        // 嘗試提取 JSON 物件
        const jsonMatch = clean.match(/\{[^{}]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.t && parsed.t !== 'null') {
              const timeStr = parsed.t.includes('+') ? parsed.t : parsed.t + '+08:00';
              const date = new Date(timeStr);
              if (!isNaN(date.getTime())) {
                return {
                  date: date,
                  text: parsed.o || '',
                  confidence: parsed.c || 0.7,
                  reasoning: parsed.r || ''
                };
              }
            }
          } catch (e) {
            // 繼續
          }
        }
        
        // 最後防線：正則提取
        const timeMatch = clean.match(/"t":\s*"([^"]+)"/) || clean.match(/"time":\s*"([^"]+)"/);
        const confMatch = clean.match(/"c":\s*([\d.]+)/) || clean.match(/"confidence":\s*([\d.]+)/);
        
        if (timeMatch && timeMatch[1] !== 'null') {
          const timeStr = timeMatch[1].includes('+') ? timeMatch[1] : timeMatch[1] + '+08:00';
          const date = new Date(timeStr);
          if (!isNaN(date.getTime())) {
            return {
              date: date,
              text: clean.match(/"o":\s*"([^"]*)"/)?.[1] || clean.match(/"original_text":\s*"([^"]*)"/)?.[1] || '',
              confidence: confMatch ? parseFloat(confMatch[1]) : 0.6,
              reasoning: clean.match(/"r":\s*"([^"]*)"/)?.[1] || clean.match(/"reason":\s*"([^"]*)"/)?.[1] || 'fallback'
            };
          }
        }
        
        console.error('No valid time found in AI response:', clean);
        return null;
        
      } catch (error) {
        console.error('AI response parsing error:', error);
        return null;
      }
    }

    // 用 AI 重新解析
    async function reparseWithAI(ctx, env, state) {
      try {
        await ctx.reply("🤖 正在使用 AI 重新解析時間...");
        
        const aiResult = await parseTimeWithAI(state.originalText, env);
        
        if (!aiResult || !aiResult.date) {
          await ctx.reply("❌ AI 解析失敗，請手動調整時間或重新輸入");
          return;
        }

        // 準備確認訊息
        const displayTime = aiResult.date.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });

        // 更新狀態
        userParsingState.set(ctx.from.id.toString(), {
          ...state,
          parsedTime: aiResult.date,
          extractedText: aiResult.text,
          confidence: 'ai',
          aiConfidence: aiResult.confidence,
          aiReasoning: aiResult.reasoning
        });

        const keyboard = new InlineKeyboard()
          .text("✅ 採用 AI 結果", "confirm_time")
          .text("🔄 再試一次", "reparse_with_ai")
          .row();

        await ctx.reply(
          `🤖 AI 解析結果：\n` +
          `📌 任務：${state.task}\n` +
          `🕒 時間：${displayTime}\n` +
          `🎯 準確度：${Math.round((aiResult.confidence || 0.7) * 100)}%\n\n` +
          `要採用這個時間嗎？`,
          { reply_markup: keyboard }
        );

      } catch (error) {
        console.error('AI reparse error:', error);
        await ctx.reply("❌ AI 服務暫時不可用，請稍後再試");
      }
    }

    // 儲存任務到資料庫
    async function saveTask(ctx, env, state) {
      const userId = ctx.from.id.toString();
      const nowSeconds = Math.floor(Date.now() / 1000);
      let remindAt = Math.floor(state.parsedTime.getTime() / 1000);

      // 確保是未來時間
      if (remindAt <= nowSeconds) {
        remindAt += 86400;
        state.parsedTime = new Date(remindAt * 1000);
      }

      try {
        await env.DB.prepare(
          "INSERT INTO todos (user_id, task, remind_at, status) VALUES (?, ?, ?, 0)"
        ).bind(userId, state.task, remindAt).run();

        const displayTime = state.parsedTime.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });

        const sourceText = state.confidence === 'ai' ? 
          `🤖 AI 解析 (${Math.round(state.aiConfidence * 100)}%)` : 
          '✅ 本地解析';

        await ctx.reply(
          `✅ 任務已設定成功！\n\n` +
          `📌 內容：${state.task}\n` +
          `⏰ 時間：${displayTime}\n` +
          `🔍 來源：${sourceText}`
        );
      } catch (error) {
        console.error('save task error:', error);
        await ctx.reply('❌ 儲存任務失敗，請稍後再試');
      }
    }

    // 核心邏輯：處理文字輸入
    bot.on("message:text", async (ctx) => {
      try {
        const text = ctx.message.text;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const userId = ctx.from.id.toString();
        
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
            await reparseWithAI(ctx, env, state);
            return;
          }
        }

        // 階段1：先用本地解析
        const parseResults = chrono.parse(text);
        
        if (parseResults.length === 0) {
          return ctx.reply("❓ 找不到時間資訊。請重新輸入，例如：\n• 「買牛奶 明天下午2點」\n• 「開會 09:00」");
        }

        let targetDate = parseResults[0].date();
        let remindAt = Math.floor(targetDate.getTime() / 1000);

        // 確保是未來時間
        if (remindAt <= nowSeconds) {
          remindAt += 86400; 
          targetDate = new Date(remindAt * 1000);
        }

        const extractedText = parseResults[0].text;
        const task = text.replace(extractedText, "").trim() || text;

        // 顯示解析結果並詢問確認
        const displayTime = targetDate.toLocaleString('zh-TW', { 
          timeZone: 'Asia/Taipei',
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });

        // 儲存狀態等待確認
        userParsingState.set(userId, {
          awaitingConfirmation: true,
          originalText: text,
          task: task,
          parsedTime: targetDate,
          extractedText: extractedText,
          confidence: 'local'
        });

        const keyboard = new InlineKeyboard()
          .text("✅ 時間正確", "confirm_time")
          .text("🔄 用 AI 重新解析", "reparse_with_ai")
          .row();

        await ctx.reply(
          `⏰ 我解析到的時間：\n` +
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
      const { results } = await env.DB.prepare(
        "SELECT * FROM todos WHERE status = 0 AND remind_at <= ?"
      ).bind(now).all();

      if (results?.length > 0) {
        for (const todo of results) {
          try {
            await bot.api.sendMessage(todo.user_id, `⏰ 時間到！\n任務：${todo.task}`);
            await env.DB.prepare("UPDATE todos SET status = 1 WHERE id = ?").bind(todo.id).run();
          } catch (e) {
            console.error('reminder error:', e);
          }
        }
      }
    } catch (error) {
      console.error('scheduled error:', error);
    }
  }
};