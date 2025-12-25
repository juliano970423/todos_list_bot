// bot.js - 機器人處理模組
import { Bot, InlineKeyboard } from "grammy";

// 初始化機器人
async function setupBot(env) {
  const bot = new Bot(env.BOT_TOKEN);
  return bot;
}

export {
  setupBot
};