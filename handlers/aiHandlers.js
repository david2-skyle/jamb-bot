/**
 * handlers/aiHandlers.js
 * AI circuit breaker, safeAi wrapper, and AI-facing commands.
 *
 * Exports:
 *   aiCircuitBreaker  – shared singleton used by quizHandlers too
 *   safeAi            – fire-and-forget-safe AI call wrapper
 *   handleAiChat      – .ai command
 *   handleGenerateQuestions – .genq command
 */

const path = require("path");
const CONFIG = require("../config");
const logger = require("../logger");
const utils = require("../utils");
const permissions = require("../permissions");
const aiService = require("../Aiservice");
const { safeSend, aiCircuitBreaker, safeAi } = require("./helpers");

// aiCircuitBreaker and safeAi are defined in helpers.js (no circular deps).
// Re-export them so callers that did `require('./aiHandlers')` still work.

// ── .ai command — free-form educational chat ──────────────────────
async function handleAiChat(msg, text) {
  const { emojis } = CONFIG.messages;
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
  const thinking = await msg.reply(`${emojis.ai} _Thinking..._`);
  const response = await safeAi(aiService.freeChat.bind(aiService), text);
  if (!response) {
    try {
      await thinking.edit(
        `${emojis.error} AI is unavailable. Try again later.`,
      );
    } catch {}
    return;
  }
  try {
    await thinking.edit(`${emojis.ai} *AI Answer*\n\n${response}`);
  } catch {}
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

  const status = await msg.reply(
    `${emojis.ai} Generating ${count} questions on *${topic}*...\n_10–15 seconds..._`,
  );

  const questions = await safeAi(
    aiService.generateQuestions.bind(aiService),
    subject,
    topic,
    count,
  );

  if (!questions || questions.length === 0) {
    try {
      await status.edit(
        `${emojis.error} Failed to generate questions. Try a more specific topic.`,
      );
    } catch {}
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

  try {
    await status.edit(
      `${emojis.ai} *Generated ${questions.length} questions for ` +
        `${subject.toUpperCase()} — "${topic}"*\n\n${preview}` +
        `${questions.length > 3 ? `\n\n_...and ${questions.length - 3} more_` : ""}\n\n` +
        `Reply *yes* within 30s to save.`,
    );
  } catch {}

  // Lazy-require client here to avoid circular deps
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
};
