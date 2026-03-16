/**
 * handlers/quizHandlers.js — v3.4.0
 *
 * Optimizations:
 * - startQuizInterval uses setTimeout (single-shot) instead of setInterval
 *   with elapsed-time math. This eliminates timer drift and the O(1s) busy
 *   poll that was firing every second.
 * - Per-chat endingQuestion guard moved to a boolean on state (avoids a
 *   module-level Set lookup on every processQuestionEnd call).
 * - handleAnswer: contact lookup moved to a try/catch micro-task so
 *   answer recording is never delayed by a slow WA contact fetch.
 * - formatQuestion result is computed once per question, not re-computed
 *   on each retry.
 * - All setTimeout/setInterval handles are unref()'d so they don't prevent
 *   graceful shutdown.
 */

const CONFIG = require("../config");
const logger = require("../logger");
const storage = require("../storage");
const utils = require("../utils");
const permissions = require("../permissions");
const dataManager = require("../dataManager");
const quizManager = require("../quizManager");
const messageFormatter = require("../messageFormatter");
const { getOrCreateState, activeQuizzes } = require("../state");
const client = require("../client");
const aiService = require("../Aiservice");
const { isBrowserError, safeSend, aiCircuitBreaker, safeAi } = require("./helpers");

const PAUSE_RETRY_MS = 15_000;

// ── sendQuestionMessage ───────────────────────────────────────────
async function sendQuestionMessage(chatId, text, imgPath, replyToMsg = null) {
  try {
    const media = imgPath ? await utils.loadImage(imgPath) : null;
    if (media) {
      try {
        return await client.sendMessage(chatId, media, { caption: text });
      } catch (e) {
        if (isBrowserError(e)) return null;
        logger.warn("[Send] Image send failed, falling back to text:", e.message);
      }
    }
    if (replyToMsg) {
      try { return await replyToMsg.reply(text); } catch (e) {
        if (isBrowserError(e)) return null;
      }
    }
    return await client.sendMessage(chatId, text);
  } catch (e) {
    if (!isBrowserError(e)) logger.error("[Send] sendQuestionMessage error:", e.message);
    try { return await client.sendMessage(chatId, text); } catch { }
    return null;
  }
}

// ── _sendWithRetry ────────────────────────────────────────────────
const RETRY_DELAYS = [2_000, 4_000, 8_000, 15_000];

async function _sendWithRetry(chatId, text, imgPath, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sent = await sendQuestionMessage(chatId, text, imgPath);
    if (sent) return sent;

    const s = getOrCreateState(chatId);
    if (!s.isActive) return null; // stopped externally

    if (attempt < maxRetries) {
      const delay = RETRY_DELAYS[attempt - 1] || 4_000;
      logger.warn(`[Quiz] Send attempt ${attempt}/${maxRetries} failed for ${chatId}, retrying in ${delay}ms`);
      await utils.sleep(delay);
    }
  }
  logger.error(`[Quiz] All ${maxRetries} send attempts failed for ${chatId}`);
  return null;
}

// ── _pauseAndRetry ────────────────────────────────────────────────
async function _pauseAndRetry(chatId, questionText, imgPath, questionIndex) {
  const s = activeQuizzes.get(chatId);
  if (!s || !s.isActive) return;

  s.isPaused = true;
  s.pausedAt = Date.now();

  logger.warn(`[Quiz] Pausing in ${chatId} at Q${questionIndex + 1} — retrying in ${PAUSE_RETRY_MS / 1_000}s`);

  await safeSend(
    chatId,
    `⏸️ *Quiz paused* — having trouble sending the next question.\n` +
    `Retrying in ${PAUSE_RETRY_MS / 1_000} seconds... Your scores are safe! 💾`,
  );

  const timer = setTimeout(async () => {
    const current = activeQuizzes.get(chatId);
    if (!current || !current.isActive || !current.isPaused) return;

    current.isPaused = false;
    current.pausedAt = null;

    logger.info(`[Quiz] Resuming in ${chatId} at Q${questionIndex + 1}`);
    const sentMsg = await _sendWithRetry(chatId, questionText, imgPath, 4);

    if (!sentMsg) {
      logger.error(`[Quiz] Resume failed for ${chatId} — pausing again`);
      await _pauseAndRetry(chatId, questionText, imgPath, questionIndex);
      return;
    }

    await safeSend(chatId, `▶️ *Quiz resumed!* Q${questionIndex + 1} is above ☝️`);
    current.lastQuestionMsgId = sentMsg?.id?._serialized || null;
    current.questionSentAt = Date.now();
    await _scheduleNextQuestion(chatId);
  }, PAUSE_RETRY_MS);

  if (timer.unref) timer.unref();
}

// ── _scheduleNextQuestion (replaces setInterval poll) ────────────
// Uses a single setTimeout per question. No per-second polling,
// no drift accumulation, no stale handle references.
async function _scheduleNextQuestion(chatId) {
  const s = activeQuizzes.get(chatId);
  if (!s || !s.isActive) return;

  const chatCfg = storage.getQuizConfig(chatId);
  // Remaining time = interval minus however long we already spent sending/retrying
  const elapsed = Date.now() - (s.questionSentAt || Date.now());
  const remaining = Math.max(0, chatCfg.questionInterval - elapsed);

  // Clear any existing timer
  if (s._questionTimer) {
    clearTimeout(s._questionTimer);
    s._questionTimer = null;
  }

  const timer = setTimeout(async () => {
    const latest = activeQuizzes.get(chatId);
    if (!latest || !latest.isActive || latest.isPaused) return;
    if (latest._questionTimer !== timer) return; // superseded
    latest._questionTimer = null;
    await processQuestionEnd(chatId);
  }, remaining);

  if (timer.unref) timer.unref();
  s._questionTimer = timer;
}

// ── processQuestionEnd ────────────────────────────────────────────
async function processQuestionEnd(chatId) {
  const state = activeQuizzes.get(chatId);
  if (!state || !state.isActive || state._endingQuestion) return;
  state._endingQuestion = true;

  try {
    const { emojis } = CONFIG.messages;

    quizManager.commitAnswers(state);

    const correctAnswer = quizManager.getCurrentAnswerLetter(state);
    const correctList = Object.values(state.currentRespondents || {})
      .filter((d) => d.isCorrect)
      .map((d) => d.name);

    const resultsMsg =
      `${emojis.timer} *Time's Up!*\n\n` +
      `${emojis.success} *Correct Answer: ${correctAnswer}*\n\n` +
      (quizManager.getCurrentQuestionExplanation(state) || "") +
      "\n\n" +
      `${emojis.success} *Got it right (${correctList.length}):*\n` +
      (correctList.length > 0 ? correctList.join(", ") : "Nobody this round!");

    await safeSend(chatId, resultsMsg);

    // AI explanation — fire-and-forget
    const currentQ = quizManager.getCurrentQuestion(state);
    if (currentQ && aiCircuitBreaker.canTry()) {
      safeAi(
        aiService.explainAnswer.bind(aiService),
        currentQ.question,
        `${correctAnswer}. ${currentQ.options?.[currentQ.answer_index] || ""}`,
        state.subject,
        state.year,
      ).then((explanation) => {
        if (explanation) safeSend(chatId, `${emojis.ai} *AI Insight:* ${explanation}`);
      });
    }

    // Advance
    const chatCfg = storage.getQuizConfig(chatId);
    const nextQ = quizManager.nextQuestion(state);
    state.currentRespondents = {};
    state.currentAnswers = {};

    if (nextQ) {
      await utils.sleep(chatCfg.delayBeforeNextQuestion);

      const s = activeQuizzes.get(chatId);
      if (!s || !s.isActive) return;

      const questionText = messageFormatter.formatQuestion(nextQ, s.currentQuestionIndex);
      const sentMsg = await _sendWithRetry(chatId, questionText, nextQ.image);

      if (!sentMsg) {
        await _pauseAndRetry(chatId, questionText, nextQ.image, s.currentQuestionIndex);
        return;
      }

      s.lastQuestionMsgId = sentMsg?.id?._serialized || null;
      s.questionSentAt = Date.now();
      await _scheduleNextQuestion(chatId);
    } else {
      await utils.sleep(CONFIG.quiz?.delayBeforeResults || 2_000);
      await sendFinalResults(chatId);
      quizManager.stop(chatId);
    }
  } catch (err) {
    if (isBrowserError(err)) {
      logger.warn(`[Quiz] Browser error in processQuestionEnd for ${chatId} — quiz preserved`);
      const s = activeQuizzes.get(chatId);
      if (s && s.isActive) {
        s.isPaused = true;
        s.pausedAt = Date.now();
        const t = setTimeout(async () => {
          const latest = activeQuizzes.get(chatId);
          if (!latest || !latest.isActive || !latest.isPaused) return;
          latest.isPaused = false;
          latest.pausedAt = null;
          await _scheduleNextQuestion(chatId);
        }, PAUSE_RETRY_MS);
        if (t.unref) t.unref();
      }
    } else {
      logger.error(`[Quiz] Unexpected error in processQuestionEnd for ${chatId}:`, err.message);
    }
  } finally {
    const s = activeQuizzes.get(chatId);
    if (s) s._endingQuestion = false;
  }
}

// ── sendFinalResults ──────────────────────────────────────────────
async function sendFinalResults(chatId) {
  const state = activeQuizzes.get(chatId);
  if (!state) return;
  const stats = quizManager.getStats(state);
  const { emojis } = CONFIG.messages;

  let finalMsg = `🏁 *Quiz Complete!*\n\n`;
  let winnerName = null;
  let winnerScore = 0;

  const entries = Object.entries(state.scoreBoard || {});
  if (entries.length > 0) {
    entries.sort((a, b) => b[1].score - a[1].score);
    const scoreboardText = await messageFormatter.formatScoreboard(state, true);
    finalMsg += `*${emojis.trophy} Final Scoreboard:*\n\n${scoreboardText}\n\n`;

    const [winnerId, winnerData] = entries[0];
    const info = await utils.getUserDisplayInfo(winnerId, winnerData.name);
    const pct = Math.round((winnerData.score / state.questions.length) * 100);
    winnerName = info.name;
    winnerScore = winnerData.score;
    finalMsg += `${emojis.celebrate} *Winner: ${info.name}*\nScore: ${winnerData.score}/${state.questions.length} (${pct}%)\n\n`;
  } else {
    finalMsg += `No one answered any questions.\n\n`;
  }

  finalMsg += `⏱️ Duration: ${stats.duration}\n\nThanks for playing! 💚`;
  await safeSend(chatId, finalMsg);

  await storage.addQuizHistory(chatId, {
    subject: state.startedSubject || state.subject,
    year: state.startedYear || state.year,
    date: new Date().toISOString(),
    questions: state.questions.length,
    questionsAnswered: state.currentQuestionIndex,
    participants: stats.participants,
    winner: winnerName,
    winnerScore,
    duration: stats.duration,
  });
}

// ── handleAnswer ──────────────────────────────────────────────────
async function handleAnswer(msg, answerLetter) {
  const chatId = msg.from;
  const state = activeQuizzes.get(chatId);
  if (!state || !state.isActive) return;

  try {
    const userId = permissions.getUserId(msg);

    // Record the answer immediately with a best-effort name
    // Resolve the contact asynchronously — don't block answer recording
    let userName = userId.replace(/@\S+$/, "");
    const cached = utils.contactCache.get(userId);
    if (cached) {
      userName = cached.name;
      quizManager.recordAnswer(state, userId, userName, answerLetter);
    } else {
      // Record now with fallback name, then update cache in background
      quizManager.recordAnswer(state, userId, userName, answerLetter);
      msg.getContact().then((contact) => {
        const name = contact?.pushname || contact?.name || contact?.number || userName;
        utils.contactCache.set(userId, { name, text: utils.mentionText(userId), contact });
        // Update the answer record with real name if still in currentAnswers
        if (state.currentAnswers?.[userId]) {
          state.currentAnswers[userId].name = name;
        }
      }).catch(() => { /* silent fallback */ });
    }
  } catch (e) {
    if (!isBrowserError(e)) logger.error("[Answer] Error:", e.message);
  }
}

// ── handleStartQuiz ───────────────────────────────────────────────
async function handleStartQuiz(msg, args) {
  const { emojis } = CONFIG.messages;
  if (!(await permissions.isModerator(msg))) {
    await msg.reply("⛔ Only Moderators, Bot Admins, or the Owner can start quizzes.");
    return;
  }
  const chatId = msg.from;
  const state = getOrCreateState(chatId);

  if (state.isActive) {
    await msg.reply(
      `${emojis.warning} Quiz already running!\n\nSubject: ${state.subject?.toUpperCase()}\n` +
      `Q${state.currentQuestionIndex + 1}/${state.questions.length}\n\n` +
      `Use ${CONFIG.bot.prefix}stop to end it.`,
    );
    return;
  }
  if (args.length < 2) {
    await msg.reply(
      `${emojis.error} Usage: ${CONFIG.bot.prefix}start [subject] [year]\n` +
      `Example: ${CONFIG.bot.prefix}start biology 2014\nOr use \`all\` for all years.`,
    );
    return;
  }

  const [subject, year] = args;
  const chatCfg = storage.getQuizConfig(chatId);
  const started = await quizManager.start(subject, year, chatId);

  if (!started) {
    await msg.reply(`${emojis.error} No questions found for *${subject} ${year}*.`);
    return;
  }

  const freshState = activeQuizzes.get(chatId);
  freshState.startedSubject = subject;
  freshState.startedYear = year;
  freshState.startedAt = Date.now();

  await msg.reply(
    `${emojis.trophy} *Quiz Started!*\n\n` +
    `📖 Subject: *${subject.toUpperCase()}*\n` +
    `📅 Year: *${year}*\n` +
    `📋 Questions: *${freshState.questions.length}*\n` +
    `${emojis.timer} Time per question: *${utils.formatSeconds(chatCfg.questionInterval)}*\n` +
    `⏳ Delay between Qs: *${utils.formatSeconds(chatCfg.delayBeforeNextQuestion)}*\n\n` +
    `Send *A, B, C, or D* to answer each question.\n` +
    `You can change your answer until time is up! Good luck 🍀`,
  );

  const welcome = storage.getWelcomeMessage(chatId);
  if (welcome) await safeSend(chatId, welcome);

  await utils.sleep(chatCfg.delayBeforeFirstQuestion || 3_000);

  const s = activeQuizzes.get(chatId);
  if (!s || !s.isActive) return;

  const firstQ = quizManager.getCurrentQuestion(s);
  if (!firstQ) return;

  const firstText = messageFormatter.formatQuestion(firstQ, 0);
  const sentMsg = await _sendWithRetry(chatId, firstText, firstQ.image);

  if (!sentMsg) {
    await _pauseAndRetry(chatId, firstText, firstQ.image, 0);
    return;
  }

  const liveState = activeQuizzes.get(chatId);
  if (!liveState || !liveState.isActive) return;
  liveState.lastQuestionMsgId = sentMsg?.id?._serialized || null;
  liveState.questionSentAt = Date.now();
  await _scheduleNextQuestion(chatId);
}

// ── handleStopQuiz ────────────────────────────────────────────────
async function handleStopQuiz(msg) {
  const { emojis } = CONFIG.messages;
  if (!(await permissions.isModerator(msg))) {
    await msg.reply("⛔ Only Moderators, Bot Admins, or the Owner can stop quizzes.");
    return;
  }
  const chatId = msg.from;
  const state = activeQuizzes.get(chatId);
  if (!state || !state.isActive) {
    await msg.reply(`${emojis.warning} No active quiz in this chat.`);
    return;
  }
  const stats = quizManager.getStats(state);
  const hasScores = Object.keys(state.scoreBoard || {}).length > 0;
  const scoreText = hasScores
    ? `*Scores:*\n${await messageFormatter.formatScoreboard(state)}`
    : "No scores recorded.";

  quizManager.stop(chatId);
  await msg.reply(
    `${emojis.stop} *Quiz Stopped*\n\n` +
    `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
    `Duration: ${stats.duration}\n\n${scoreText}`,
  );
}

// ── handleScore ───────────────────────────────────────────────────
async function handleScore(msg) {
  const { emojis } = CONFIG.messages;
  const chatId = msg.from;
  const state = activeQuizzes.get(chatId);
  if (!state || !state.isActive) {
    await msg.reply(`${emojis.warning} No active quiz.\n\nStart with ${CONFIG.bot.prefix}start [subject] [year]`);
    return;
  }
  if (Object.keys(state.scoreBoard || {}).length === 0) {
    await msg.reply(`${emojis.chart} *Scoreboard*\n\nNo answers yet!`);
    return;
  }
  const sb = await messageFormatter.formatScoreboard(state, true);
  const pauseNote = state.isPaused ? "\n\n⏸️ _Quiz is currently paused — will resume shortly_" : "";
  await msg.reply(
    `${emojis.chart} *Scoreboard*\n\n${sb}\n\nQ: ${state.currentQuestionIndex + 1}/${state.questions.length}${pauseNote}`,
  );
}

// ── handleStats ───────────────────────────────────────────────────
async function handleStats(msg) {
  const { emojis } = CONFIG.messages;
  const state = activeQuizzes.get(msg.from);
  if (!state || !state.isActive) {
    await msg.reply(`${emojis.warning} No active quiz.`);
    return;
  }
  const stats = quizManager.getStats(state);
  const statusNote = state.isPaused ? "\n⏸️ Status: *Paused* (auto-resuming)" : "\n▶️ Status: *Running*";
  await msg.reply(
    `${emojis.info} *Quiz Stats*\n\n` +
    `Subject: ${state.subject?.toUpperCase()} ${state.year}\n` +
    `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
    `Remaining: ${stats.remainingQuestions}\n` +
    `Participants: ${stats.participants}\n` +
    `Duration: ${stats.duration}${statusNote}`,
  );
}

// ── handleQuestion ────────────────────────────────────────────────
async function handleQuestion(msg, args) {
  if (args.length < 2) {
    await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}question [subject] [year]`);
    return;
  }
  const [subject, year] = args;
  const result = await dataManager.getRandomQuestion(subject, year);
  if (!result) {
    await msg.reply(`❌ No questions found for *${subject} ${year}*.`);
    return;
  }
  const text =
    `*🎲 Practice Question*\n${subject.toUpperCase()} ${year}\n\n` +
    messageFormatter.formatQuestion({ ...result.question, year }, result.index) +
    `\n\n_Reply A, B, C, or D_`;
  await sendQuestionMessage(msg.from, text, result.question.image, msg);
}

// Legacy export kept for api-server.js and commandHandler.js compatibility
function startQuizInterval(chatId) {
  return _scheduleNextQuestion(chatId);
}

module.exports = {
  isBrowserError,
  safeSend,
  handleAnswer,
  handleStartQuiz,
  handleStopQuiz,
  handleScore,
  handleStats,
  handleQuestion,
  processQuestionEnd,
  startQuizInterval,
  sendFinalResults,
  sendQuestionMessage,
};