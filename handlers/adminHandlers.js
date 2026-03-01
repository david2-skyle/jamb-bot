/**
 * handlers/adminHandlers.js
 * Admin, mod, config, and owner-facing commands.
 *
 * Exports:
 *   handleSetInterval
 *   handleSetDelay
 *   handleSetMax
 *   handleChatConfig
 *   handleEnable
 *   handleDisable
 *   handleGlobalEnable
 *   handleGlobalDisable
 *   handleAdmin
 *   handleMod
 *   handleAnnounce
 *   handleSetWelcome
 *   handleClearWelcome
 *   handleResetConfig
 *   handleQuizHistory
 *   handleBroadcast
 *   handleChats
 *   handleAllStaff
 *   handleClearStaff
 */

const CONFIG = require("../config");
const logger = require("../logger");
const storage = require("../storage");
const utils = require("../utils");
const permissions = require("../permissions");
const quizManager = require("../quizManager");
const { activeQuizzes, getOrCreateState } = require("../state");
const { safeSend, aiCircuitBreaker } = require("./helpers");
const client = require("../client");

// ── handleSetInterval ─────────────────────────────────────────────
async function handleSetInterval(msg, args) {
  if (!(await permissions.isModerator(msg))) {
    await msg.reply("⛔ Only Moderators or above can change quiz settings.");
    return;
  }
  const s = parseInt(args[0]);
  if (isNaN(s) || s < 5 || s > 300) {
    await msg.reply(
      `❌ Provide seconds between 5–300. Example: ${CONFIG.bot.prefix}setinterval 30`,
    );
    return;
  }
  const chatId = msg.from;
  if (!storage.quizConfig[chatId]) storage.quizConfig[chatId] = {};
  storage.quizConfig[chatId].questionInterval = s * 1000;
  await storage.saveQuizConfig();
  await msg.reply(`✅ Question time set to *${s}s*.`);
}

// ── handleSetDelay ────────────────────────────────────────────────
async function handleSetDelay(msg, args) {
  if (!(await permissions.isModerator(msg))) {
    await msg.reply("⛔ Only Moderators or above can change quiz settings.");
    return;
  }
  const s = parseInt(args[0]);
  if (isNaN(s) || s < 1 || s > 60) {
    await msg.reply(
      `❌ Provide seconds between 1–60. Example: ${CONFIG.bot.prefix}setdelay 5`,
    );
    return;
  }
  const chatId = msg.from;
  if (!storage.quizConfig[chatId]) storage.quizConfig[chatId] = {};
  storage.quizConfig[chatId].delayBeforeNextQuestion = s * 1000;
  await storage.saveQuizConfig();
  await msg.reply(`✅ Delay between questions set to *${s}s*.`);
}

// ── handleSetMax ──────────────────────────────────────────────────
async function handleSetMax(msg, args) {
  if (!(await permissions.isModerator(msg))) {
    await msg.reply("⛔ Only Moderators or above can change quiz settings.");
    return;
  }
  const n = parseInt(args[0]);
  if (isNaN(n) || n < 1 || n > 200) {
    await msg.reply(
      `❌ Provide a number between 1–200. Example: ${CONFIG.bot.prefix}setmax 20`,
    );
    return;
  }
  const chatId = msg.from;
  if (!storage.quizConfig[chatId]) storage.quizConfig[chatId] = {};
  storage.quizConfig[chatId].maxQuestionsPerQuiz = n;
  await storage.saveQuizConfig();
  await msg.reply(`✅ Max questions per quiz set to *${n}*.`);
}

// ── handleChatConfig ──────────────────────────────────────────────
async function handleChatConfig(msg) {
  const { emojis } = CONFIG.messages;
  const chatId = msg.from;
  const cfg = storage.getQuizConfig(chatId);
  const ai = aiCircuitBreaker.status();
  await msg.reply(
    `${emojis.gear} *Config for this chat*\n\n` +
      `🌐 Global: ${storage.isGloballyDisabled() ? "Disabled 🔴" : "Active 🟢"}\n` +
      `🔌 Chat: ${storage.isChatDisabled(chatId) ? "Disabled 🔴" : "Active 🟢"}\n` +
      `${emojis.timer} Q time: ${utils.formatSeconds(cfg.questionInterval)}\n` +
      `⏳ Delay: ${utils.formatSeconds(cfg.delayBeforeNextQuestion)}\n` +
      `📋 Max Qs: ${cfg.maxQuestionsPerQuiz}\n` +
      `🤖 AI: ${ai.canTry ? "🟢 Ready" : `🟡 Circuit open (${Math.ceil(ai.resetIn / 60)}min)`}`,
  );
}

// ── handleEnable ──────────────────────────────────────────────────
async function handleEnable(msg) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can enable the bot.");
    return;
  }
  if (!storage.isChatDisabled(msg.from)) {
    await msg.reply("⚠️ Bot is already enabled here.");
    return;
  }
  await storage.enableChat(msg.from);
  await msg.reply("✅ Bot is now *enabled* in this chat.");
}

// ── handleDisable ─────────────────────────────────────────────────
async function handleDisable(msg) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can disable the bot.");
    return;
  }
  const chatId = msg.from;
  const state = getOrCreateState(chatId);
  if (state.isActive) {
    quizManager.stop(chatId);
    await safeSend(chatId, "⏹ Active quiz stopped — bot is being disabled.");
  }
  await storage.disableChat(chatId);
  await msg.reply(
    `⏹ Bot is now *disabled* in this chat.\nUse ${CONFIG.bot.prefix}enable to restore.`,
  );
}

// ── handleGlobalEnable ────────────────────────────────────────────
async function handleGlobalEnable(msg) {
  if (!permissions.isOwner(msg)) {
    await msg.reply("⛔ Only the Owner can globally enable the bot.");
    return;
  }
  await storage.setGlobalDisabled(false);
  await msg.reply("✅ Bot globally *enabled* 🌐");
}

// ── handleGlobalDisable ───────────────────────────────────────────
async function handleGlobalDisable(msg) {
  if (!permissions.isOwner(msg)) {
    await msg.reply("⛔ Only the Owner can globally disable the bot.");
    return;
  }
  let stopped = 0;
  for (const [chatId, state] of activeQuizzes) {
    if (state.isActive) {
      quizManager.stop(chatId);
      stopped++;
      await safeSend(
        chatId,
        "⏹ Quiz stopped — bot globally disabled by Owner.",
      );
    }
  }
  await storage.setGlobalDisabled(true);
  await msg.reply(
    `⏹ Bot globally *disabled* 🌐${stopped > 0 ? `\nStopped ${stopped} quiz(zes).` : ""}`,
  );
}

// ── tagReply — sends a message that mentions/tags a user ──────────
// WhatsApp requires the @number in the text body AND the full contact
// ID passed in the mentions array. msg.reply() does not support mentions
// so we use client.sendMessage() with the chat ID from msg.from.
async function tagReply(msg, targetId, text) {
  const tag = `@${targetId.replace(/@\S+$/, "")}`;
  const body = text.replace("{tag}", tag);
  try {
    await client.sendMessage(msg.from, body, { mentions: [targetId] });
  } catch (e) {
    // Fallback without mention if something goes wrong
    await msg.reply(text.replace("{tag}", targetId.replace(/@\S+$/, "")));
  }
}

// ── handleAdmin ───────────────────────────────────────────────────
async function handleAdmin(msg, args, resolveTarget) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can manage Bot Admins.");
    return;
  }
  const [action, ...rest] = args;
  const chatId = msg.from;
  const { emojis } = CONFIG.messages;

  if (!action || action === "list") {
    const list = permissions.listBotAdmins(chatId);
    if (list.length === 0) {
      await msg.reply(
        `${emojis.info} No explicitly-added Bot Admins. WhatsApp group admins are automatically Bot Admins.`,
      );
      return;
    }
    const lines = await Promise.all(
      list.map(
        async (id, i) =>
          `${i + 1}. ${(await utils.getUserDisplayInfo(id)).name}`,
      ),
    );
    await msg.reply(`🛡️ *Bot Admins (${list.length}):*\n\n${lines.join("\n")}`);
    return;
  }

  const targetId = resolveTarget(msg, rest);
  if (!targetId) {
    await msg.reply(`❌ Mention someone or provide a phone number.`);
    return;
  }

  if (action === "add") {
    const added = await permissions.addBotAdmin(chatId, targetId);
    if (added) {
      await tagReply(msg, targetId, `✅ {tag} is now a 🛡️ *Bot Admin*.`);
    } else {
      await msg.reply(`⚠️ That user is already a Bot Admin.`);
    }
  } else if (action === "remove") {
    const removed = await permissions.removeBotAdmin(chatId, targetId);
    if (removed) {
      await tagReply(msg, targetId, `✅ {tag} has been removed as Bot Admin.`);
    } else {
      await msg.reply(`⚠️ That user is not a Bot Admin here.`);
    }
  }
}

// ── handleMod ─────────────────────────────────────────────────────
async function handleMod(msg, args, resolveTarget) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can manage Moderators.");
    return;
  }
  const [action, ...rest] = args;
  const chatId = msg.from;

  if (!action || action === "list") {
    const list = permissions.listModerators(chatId);
    if (!list.length) {
      await msg.reply("ℹ️ No Moderators in this chat.");
      return;
    }
    const lines = await Promise.all(
      list.map(
        async (id, i) =>
          `${i + 1}. ${(await utils.getUserDisplayInfo(id)).name}`,
      ),
    );
    await msg.reply(`⭐ *Moderators (${list.length}):*\n\n${lines.join("\n")}`);
    return;
  }

  const targetId = resolveTarget(msg, rest);
  if (!targetId) {
    await msg.reply("❌ Mention someone or provide a phone number.");
    return;
  }

  if (action === "add") {
    const result = await permissions.addModerator(chatId, targetId);
    if (result === "already_admin") {
      await tagReply(msg, targetId, `⚠️ {tag} is already a Bot Admin.`);
    } else if (result) {
      await tagReply(msg, targetId, `✅ {tag} is now a ⭐ *Moderator*.`);
    } else {
      await msg.reply(`⚠️ That user is already a Moderator.`);
    }
  } else if (action === "remove") {
    const removed = await permissions.removeModerator(chatId, targetId);
    if (removed) {
      await tagReply(msg, targetId, `✅ {tag} has been removed as Moderator.`);
    } else {
      await msg.reply(`⚠️ That user is not a Moderator here.`);
    }
  }
}

// ── handleAnnounce ────────────────────────────────────────────────
async function handleAnnounce(msg, text) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can make announcements.");
    return;
  }
  if (!text) {
    await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}announce [message]`);
    return;
  }
  await safeSend(msg.from, `📢 *Announcement*\n\n${text}`);
}

// ── handleSetWelcome ──────────────────────────────────────────────
async function handleSetWelcome(msg, text) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply(
      "⛔ Only Bot Admins or the Owner can set welcome messages.",
    );
    return;
  }
  if (!text) {
    await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}setwelcome [message]`);
    return;
  }
  await storage.setWelcomeMessage(msg.from, text);
  await msg.reply(`✅ Welcome message set!\n\n_Preview:_\n${text}`);
}

// ── handleClearWelcome ────────────────────────────────────────────
async function handleClearWelcome(msg) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply(
      "⛔ Only Bot Admins or the Owner can clear welcome messages.",
    );
    return;
  }
  await storage.clearWelcomeMessage(msg.from);
  await msg.reply("✅ Welcome message cleared.");
}

// ── handleResetConfig ─────────────────────────────────────────────
async function handleResetConfig(msg) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can reset config.");
    return;
  }
  await storage.resetQuizConfig(msg.from);
  await msg.reply("✅ Config reset to defaults.");
}

// ── handleQuizHistory ─────────────────────────────────────────────
async function handleQuizHistory(msg) {
  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can view quiz history.");
    return;
  }
  const history = storage.getQuizHistory(msg.from);
  if (!history.length) {
    await msg.reply("ℹ️ No quiz history yet.");
    return;
  }
  const lines = history.slice(0, 10).map((h, i) => {
    const d = new Date(h.date).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    return (
      `${i + 1}. *${h.subject?.toUpperCase()} ${h.year}* — ${d}\n` +
      `   ${h.questionsAnswered || h.questions}/${h.questions}Qs | ` +
      `${h.participants} players | ` +
      `${h.winner ? `🥇 ${h.winner}` : "No winner"} | ⏱️ ${h.duration}`
    );
  });
  await msg.reply(
    `📊 *Quiz History (last ${lines.length}):*\n\n${lines.join("\n\n")}`,
  );
}

// ── handleBroadcast ───────────────────────────────────────────────
async function handleBroadcast(msg, text) {
  if (!permissions.isOwner(msg)) {
    await msg.reply("⛔ Only the Owner can broadcast.");
    return;
  }
  if (!text) {
    await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}broadcast [message]`);
    return;
  }
  const chats = [...activeQuizzes.keys()];
  let sent = 0;
  for (const chatId of chats) {
    const r = await safeSend(chatId, `📢 *Owner Broadcast*\n\n${text}`);
    if (r) sent++;
  }
  await msg.reply(`✅ Broadcast sent to ${sent} chat(s).`);
}

// ── handleChats ───────────────────────────────────────────────────
async function handleChats(msg) {
  if (!permissions.isOwner(msg)) {
    await msg.reply("⛔ Only the Owner can view all chats.");
    return;
  }
  const active = [...activeQuizzes.entries()].filter(([, s]) => s.isActive);
  const ai = aiCircuitBreaker.status();
  let text =
    `📊 *Bot Overview*\n\n` +
    `🟢 Active quizzes: ${active.length}\n` +
    `🔴 Disabled: ${storage.permissions.disabledChats?.length || 0}\n` +
    `🌐 Global: ${storage.isGloballyDisabled() ? "DISABLED" : "Active"}\n` +
    `🤖 AI: ${ai.canTry ? "🟢" : "🟡 Circuit open"}\n\n`;
  if (active.length > 0) {
    text += "*Active:*\n";
    active.forEach(([chatId, s], i) => {
      text += `${i + 1}. ${chatId}\n   ${s.subject?.toUpperCase()} ${s.year} — Q${s.currentQuestionIndex + 1}/${s.questions.length}\n`;
    });
  }
  await msg.reply(text);
}

// ── handleAllStaff ────────────────────────────────────────────────
async function handleAllStaff(msg) {
  if (!permissions.isOwner(msg)) {
    await msg.reply("⛔ Only the Owner can view all staff.");
    return;
  }
  const { botAdmins, moderators } = storage.permissions;
  const all = new Set([
    ...Object.keys(botAdmins || {}),
    ...Object.keys(moderators || {}),
  ]);
  if (!all.size) {
    await msg.reply("ℹ️ No staff assigned in any chat.");
    return;
  }
  let text = "🛡️ *All Staff*\n\n";
  for (const chatId of all) {
    const admins = botAdmins[chatId] || [];
    const mods = moderators[chatId] || [];
    if (!admins.length && !mods.length) continue;
    text += `*Chat:* ${chatId}\n`;
    if (admins.length) {
      const names = await Promise.all(
        admins.map(async (id) => (await utils.getUserDisplayInfo(id)).name),
      );
      text += `  🛡️ ${names.join(", ")}\n`;
    }
    if (mods.length) {
      const names = await Promise.all(
        mods.map(async (id) => (await utils.getUserDisplayInfo(id)).name),
      );
      text += `  ⭐ ${names.join(", ")}\n`;
    }
    text += "\n";
  }
  await msg.reply(text.trim());
}

// ── handleClearStaff ──────────────────────────────────────────────
async function handleClearStaff(msg) {
  if (!permissions.isOwner(msg)) {
    await msg.reply("⛔ Only the Owner can clear staff.");
    return;
  }
  const chatId = msg.from;
  await storage.clearBotAdmins(chatId);
  await storage.clearModerators(chatId);
  await msg.reply("✅ All Bot Admins and Moderators cleared for this chat.");
}

module.exports = {
  handleSetInterval,
  handleSetDelay,
  handleSetMax,
  handleChatConfig,
  handleEnable,
  handleDisable,
  handleGlobalEnable,
  handleGlobalDisable,
  handleAdmin,
  handleMod,
  handleAnnounce,
  handleSetWelcome,
  handleClearWelcome,
  handleResetConfig,
  handleQuizHistory,
  handleBroadcast,
  handleChats,
  handleAllStaff,
  handleClearStaff,
};
