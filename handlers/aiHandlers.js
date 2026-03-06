/**
 * handlers/aiHandlers.js
 * AI circuit breaker, safeAi wrapper, and AI-facing commands.
 *
 * CHANGES v3.3.0:
 * - .ai command now sends response directly (no "Thinking..." edit trick)
 *   because message.edit() is unreliable on WhatsApp Web and often silently fails.
 * - Added timeout so users always get a response even if Groq is slow.
 *
 * Exports:
 *   aiCircuitBreaker  – shared singleton used by quizHandlers too
 *   safeAi            – fire-and-forget-safe AI call wrapper
 *   handleAiChat      – .ai command
 *   handleGenerateQuestions – .genq command
 *   handleAiUser      – .aiuser command
 */

const path = require("path");
const CONFIG = require("../config");
const logger = require("../logger");
const utils = require("../utils");
const permissions = require("../permissions");
const aiService = require("../Aiservice");
const { safeSend, aiCircuitBreaker, safeAi } = require("./helpers");

// ── .ai command — free-form educational chat ──────────────────────
async function handleAiChat(msg, text) {
  const { emojis } = CONFIG.messages;

  // Check AI access — Bot Admins always allowed, others need explicit grant
  if (!(await permissions.canUseAi(msg))) {
    await msg.reply(
      `${emojis.warning} You don't have access to the AI feature.\n\n` +
        `Ask a Bot Admin to grant you access with:\n` +
        `_${CONFIG.bot.prefix}aiuser add @you_`,
    );
    return;
  }

  if (!text || text.length < 2) {
    await msg.reply(
      `${emojis.ai} *AI Assistant*\n\nUsage: ${CONFIG.bot.prefix}ai [question]\n` +
        `Example: _${CONFIG.bot.prefix}ai explain osmosis_`,
    );
    return;
  }

  if (!aiCircuitBreaker.canTry()) {
    const s = aiCircuitBreaker.status();
    await msg.reply(
      `${emojis.warning} AI is temporarily unavailable (credits exhausted). ` +
        `Resets in ~${Math.ceil(s.resetIn / 60)}min.`,
    );
    return;
  }

  if (text.length > 500) {
    await msg.reply(`${emojis.warning} Message too long (max 500 chars).`);
    return;
  }

  // Send response directly — no "Thinking..." message that needs editing.
  // msg.reply() with edit() is unreliable; sometimes the edit never shows.
  const response = await safeAi(aiService.freeChat.bind(aiService), text);

  if (!response) {
    await msg.reply(
      `${emojis.error} AI is unavailable right now. Try again in a moment.`,
    );
    return;
  }

  await msg.reply(`${emojis.ai} *AI Answer*\n\n${response}`);
}

// ── .genq command — generate AI quiz questions (Bot Admin+) ───────
async function handleGenerateQuestions(msg, args) {
  const { emojis } = CONFIG.messages;

  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can generate questions.");
    return;
  }

  if (!aiCircuitBreaker.canTry()) {
    await msg.reply(`${emojis.warning} AI unavailable right now.`);
    return;
  }

  if (args.length < 2) {
    await msg.reply(
      `${emojis.error} Usage: ${CONFIG.bot.prefix}genq [subject] [topic] [count]\n` +
        `Example: _${CONFIG.bot.prefix}genq biology cell division 5_`,
    );
    return;
  }

  const subject = args[0];
  const countArg = parseInt(args[args.length - 1]);
  const hasCount = !isNaN(countArg) && countArg > 0;
  const count = Math.min(hasCount ? countArg : 5, 10);
  const topic = hasCount
    ? args.slice(1, -1).join(" ")
    : args.slice(1).join(" ");

  // Send status message directly (no edit)
  await msg.reply(
    `${emojis.ai} Generating ${count} questions on *${topic}*...\n_This takes 10–15 seconds. You'll get the result shortly._`,
  );

  const questions = await safeAi(
    aiService.generateQuestions.bind(aiService),
    subject,
    topic,
    count,
  );

  if (!questions || questions.length === 0) {
    await safeSend(
      msg.from,
      `${emojis.error} Failed to generate questions. Try a more specific topic.`,
    );
    return;
  }

  const preview = questions
    .slice(0, 3)
    .map((q, i) => {
      const opts = q.options
        .map((o, j) => `${utils.indexToLetter(j)}. ${o}`)
        .join("\n");
      return (
        `*Q${i + 1}.* ${q.question}\n${opts}\n` +
        `✅ Answer: ${utils.indexToLetter(q.answer_index)}`
      );
    })
    .join("\n\n");

  await safeSend(
    msg.from,
    `${emojis.ai} *Generated ${questions.length} questions for ` +
      `${subject.toUpperCase()} — "${topic}"*\n\n${preview}` +
      `${questions.length > 3 ? `\n\n_...and ${questions.length - 3} more_` : ""}\n\n` +
      `Reply *yes* within 30s to save.`,
  );

  const client = require("../client");
  const confirmed = await _waitForReply(
    client,
    msg.from,
    permissions.getUserId(msg),
    30000,
  );

  if (!confirmed) {
    await safeSend(msg.from, `${emojis.info} Questions discarded.`);
    return;
  }

  const fs = require("fs").promises;
  const ts = Date.now();
  const filename = `ai_${subject}_${ts}.json`;
  const dir = path.join(CONFIG.data.dataDirectory, subject);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify(
      {
        paper_type: "AI_GENERATED",
        topic,
        generated_at: new Date().toISOString(),
        questions,
      },
      null,
      2,
    ),
  );

  await safeSend(
    msg.from,
    `${emojis.success} Saved ${questions.length} questions! File: \`${filename}\`\n` +
      `Use: _${CONFIG.bot.prefix}start ${subject} ai_${subject}_${ts}_`,
  );
}

// ── .aiuser command — manage AI access (Bot Admin+) ───────────────
async function handleAiUser(msg, args, resolveTarget) {
  const { emojis } = CONFIG.messages;

  if (!(await permissions.isBotAdmin(msg))) {
    await msg.reply("⛔ Only Bot Admins or the Owner can manage AI access.");
    return;
  }

  const [action, ...rest] = args;
  const chatId = msg.from;

  if (!action || action === "list") {
    const list = permissions.listAiUsers(chatId);
    if (!list.length) {
      await msg.reply(
        `${emojis.ai} No AI users set.\n\n` +
          `Bot Admins always have AI access automatically.\n` +
          `Use _${CONFIG.bot.prefix}aiuser add @user_ to grant access.`,
      );
      return;
    }
    const lines = await Promise.all(
      list.map(
        async (id, i) =>
          `${i + 1}. ${(await utils.getUserDisplayInfo(id)).name}`,
      ),
    );
    await msg.reply(
      `${emojis.ai} *AI Users (${list.length}):*\n\n${lines.join("\n")}`,
    );
    return;
  }

  const targetId = resolveTarget(msg, rest);
  if (!targetId) {
    await msg.reply("❌ Mention someone or provide a phone number.");
    return;
  }

  const targetInfo = await utils.getUserDisplayInfo(targetId);

  if (action === "add") {
    const added = await permissions.addAiUser(chatId, targetId);
    await msg.reply(
      added
        ? `${emojis.success} *${targetInfo.name}* can now use the AI feature. 🤖`
        : `${emojis.warning} *${targetInfo.name}* already has AI access.`,
    );
  } else if (action === "remove") {
    const removed = await permissions.removeAiUser(chatId, targetId);
    await msg.reply(
      removed
        ? `${emojis.success} AI access removed for *${targetInfo.name}*.`
        : `${emojis.warning} *${targetInfo.name}* is not in the AI users list.`,
    );
  } else if (action === "clear") {
    await require("../storage").clearAiUsers(chatId);
    await msg.reply(
      `${emojis.success} All AI user grants cleared for this chat.`,
    );
  } else {
    await msg.reply(
      `❌ Unknown action. Use: _add_, _remove_, _list_, or _clear_.\n` +
        `Example: _${CONFIG.bot.prefix}aiuser add @user_`,
    );
  }
}

// ── Internal: wait for a "yes" reply within timeout ───────────────
function _waitForReply(client, chatId, userId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeListener("message_create", handler);
      resolve(null);
    }, timeoutMs);

    const handler = async (m) => {
      if (
        m.from === chatId &&
        (m.author === userId || m.from === userId) &&
        m.body?.trim().toLowerCase() === "yes"
      ) {
        clearTimeout(timer);
        client.removeListener("message_create", handler);
        resolve(m);
      }
    };
    client.on("message_create", handler);
  });
}

module.exports = {
  aiCircuitBreaker,
  safeAi,
  handleAiChat,
  handleGenerateQuestions,
  handleAiUser,
};
