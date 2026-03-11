/**
 * handlers/aiHandlers.js
 * AI circuit breaker, safeAi wrapper, and AI-facing commands.
 *
 * CHANGES v3.4.0 (AI quiz mode):
 * - .genq now generates questions and IMMEDIATELY starts a live quiz
 *   using the existing quiz engine (same timer, scoring, leaderboard).
 *   Questions are in-memory only — nothing is written to disk.
 * - Old save-to-disk flow removed. Use .start to run saved question files.
 *
 * Exports:
 *   aiCircuitBreaker  – shared singleton used by quizHandlers too
 *   safeAi            – fire-and-forget-safe AI call wrapper
 *   handleAiChat      – .ai command
 *   handleGenerateQuestions – .genq command (now starts AI quiz directly)
 *   handleAiUser      – .aiuser command
 */

const CONFIG = require("../config");
const logger = require("../logger");
const utils = require("../utils");
const permissions = require("../permissions");
const aiService = require("../Aiservice");
const quizManager = require("../quizManager");
const storage = require("../storage");
const { activeQuizzes } = require("../state");
const { safeSend, aiCircuitBreaker, safeAi } = require("./helpers");

// Lazy-required to avoid circular deps at load time
function getQuizHandlers() {
  return require("./quizHandlers");
}

// ── .ai command — free-form educational chat ──────────────────────
async function handleAiChat(msg, text) {
  const { emojis } = CONFIG.messages;

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

  const response = await safeAi(aiService.freeChat.bind(aiService), text);

  if (!response) {
    await msg.reply(
      `${emojis.error} AI is unavailable right now. Try again in a moment.`,
    );
    return;
  }

  await msg.reply(`${emojis.ai} *AI Answer*\n\n${response}`);
}

// ── .genq command — generate AI questions and start quiz directly ──
//
// Usage:  .genq [subject] [topic...] [count]
// Example: .genq biology cell division 5
//
// Flow:
//   1. Validate permissions & AI availability
//   2. Tell the group generation is starting
//   3. Call Groq to generate questions
//   4. Show a 2-question preview
//   5. Start the quiz immediately using the existing engine
async function handleGenerateQuestions(msg, argParts) {
  const { emojis } = CONFIG.messages;
  const chatId = msg.from;

  // ── Permission check ────────────────────────────────────────────
  if (!(await permissions.isModerator(msg))) {
    await msg.reply(
      "⛔ Only Moderators, Bot Admins, or the Owner can run AI quizzes.",
    );
    return;
  }

  // ── Already running? ────────────────────────────────────────────
  const existingState = activeQuizzes.get(chatId);
  if (existingState?.isActive) {
    await msg.reply(
      `${emojis.warning} A quiz is already running!\n\n` +
        `Subject: ${existingState.subject?.toUpperCase()}` +
        (existingState.aiTopic
          ? ` — ${existingState.aiTopic}`
          : ` ${existingState.year}`) +
        `\nQ${existingState.currentQuestionIndex + 1}/${existingState.questions.length}\n\n` +
        `Use ${CONFIG.bot.prefix}stop to end it first.`,
    );
    return;
  }

  // ── Circuit breaker ─────────────────────────────────────────────
  if (!aiCircuitBreaker.canTry()) {
    const s = aiCircuitBreaker.status();
    await msg.reply(
      `${emojis.warning} AI is temporarily unavailable. ` +
        `Resets in ~${Math.ceil(s.resetIn / 60)}min.`,
    );
    return;
  }

  // ── Parse args: .genq subject topic words... [optional_count] ───
  if (argParts.length < 2) {
    await msg.reply(
      `${emojis.error} Usage: ${CONFIG.bot.prefix}genq [subject] [topic] [count]\n\n` +
        `Examples:\n` +
        `• _${CONFIG.bot.prefix}genq biology cell division 5_\n` +
        `• _${CONFIG.bot.prefix}genq chemistry organic reactions 8_\n` +
        `• _${CONFIG.bot.prefix}genq physics waves_\n\n` +
        `Count is optional (default 5, max 10).`,
    );
    return;
  }

  const subject = argParts[0].toLowerCase();
  const lastArg = argParts[argParts.length - 1];
  const trailingCount = parseInt(lastArg);
  const hasCount =
    !isNaN(trailingCount) && trailingCount > 0 && argParts.length > 2;
  const count = Math.min(hasCount ? trailingCount : 5, 10);
  const topicParts = hasCount ? argParts.slice(1, -1) : argParts.slice(1);
  const topic = topicParts.join(" ");

  if (!topic) {
    await msg.reply(
      `${emojis.error} Please provide a topic after the subject.`,
    );
    return;
  }

  const chatCfg = storage.getQuizConfig(chatId);

  // ── Announce generation ─────────────────────────────────────────
  await msg.reply(
    `${emojis.ai} *Generating AI Quiz*\n\n` +
      `📖 Subject: *${subject.toUpperCase()}*\n` +
      `🧠 Topic: *${topic}*\n` +
      `📋 Questions: *${count}*\n\n` +
      `_Hold tight — this takes about 10 seconds..._`,
  );

  // ── Generate questions via Groq ─────────────────────────────────
  const raw = await safeAi(
    aiService.generateQuestions.bind(aiService),
    subject,
    topic,
    count,
  );

  if (!raw || raw.length === 0) {
    await safeSend(
      chatId,
      `${emojis.error} Failed to generate questions. Try a more specific topic, or check that your GROQ_API_KEY is set.`,
    );
    return;
  }

  // ── Show preview of first 2 questions ──────────────────────────
  const preview = raw
    .slice(0, 2)
    .map((q, i) => {
      const opts = q.options
        .map((o, j) => `${utils.indexToLetter(j)}. ${o}`)
        .join("\n");
      return `*Q${i + 1}.* ${q.question}\n${opts}`;
    })
    .join("\n\n");

  await safeSend(
    chatId,
    `${emojis.ai} *Preview (first 2 of ${raw.length}):*\n\n${preview}`,
  );

  // ── Start the quiz in-memory ────────────────────────────────────
  const started = quizManager.startFromQuestions(raw, subject, topic, chatId);

  if (!started) {
    await safeSend(
      chatId,
      `${emojis.error} Could not start the AI quiz — no valid questions.`,
    );
    return;
  }

  const freshState = activeQuizzes.get(chatId);
  freshState.startedSubject = subject;
  freshState.startedYear = `AI`;
  freshState.startedAt = Date.now();

  // ── Send start banner ───────────────────────────────────────────
  await safeSend(
    chatId,
    `${emojis.rocket} *AI Quiz Starting!*\n\n` +
      `📖 Subject: *${subject.toUpperCase()}*\n` +
      `🧠 Topic: *${topic}*\n` +
      `📋 Questions: *${freshState.questions.length}*\n` +
      `${emojis.timer} Time per question: *${utils.formatSeconds(chatCfg.questionInterval)}*\n` +
      `⏳ Delay between Qs: *${utils.formatSeconds(chatCfg.delayBeforeNextQuestion)}*\n\n` +
      `Send *A, B, C, or D* to answer. You can change your answer until time is up! 🍀`,
  );

  const welcome = storage.getWelcomeMessage(chatId);
  if (welcome) await safeSend(chatId, welcome);

  await utils.sleep(chatCfg.delayBeforeFirstQuestion || 3000);

  // Re-check quiz is still active (someone might have .stop'd during the sleep)
  const s = activeQuizzes.get(chatId);
  if (!s || !s.isActive) return;

  // ── Send first question using the shared quiz engine ────────────
  const { startQuizInterval, sendQuestionMessage } = getQuizHandlers();
  const messageFormatter = require("../messageFormatter");

  const firstQ = quizManager.getCurrentQuestion(s);
  if (!firstQ) return;

  const questionText = messageFormatter.formatQuestion(firstQ, 0);
  let sentMsg = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    sentMsg = await sendQuestionMessage(chatId, questionText, firstQ.image);
    if (sentMsg) break;
    if (attempt < 3) await utils.sleep(3000);
  }

  if (!sentMsg) {
    await safeSend(
      chatId,
      `${emojis.error} Failed to send the first question. Quiz cancelled.`,
    );
    quizManager.stop(chatId);
    return;
  }

  const liveState = activeQuizzes.get(chatId);
  if (!liveState || !liveState.isActive) return;
  liveState.lastQuestionMsgId = sentMsg?.id?._serialized || null;
  liveState.questionSentAt = Date.now();
  await startQuizInterval(chatId);
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

module.exports = {
  aiCircuitBreaker,
  safeAi,
  handleAiChat,
  handleGenerateQuestions,
  handleAiUser,
};
