/**
 * handlers/quizHandlers.js
 * Core quiz engine and quiz-facing commands.
 *
 * CHANGES v3.3.2 (resilience update):
 * - On send failure, quiz PAUSES instead of stopping (scores preserved).
 *   A paused quiz auto-resumes after PAUSE_RETRY_MS and tries to continue.
 * - processQuestionEnd is guarded against browser errors: if a browser
 *   error occurs mid-question-end, state is preserved so quiz can resume.
 * - getContact errors are fully swallowed — name falls back to cached/userId.
 * - _sendWithRetry uses longer delays on later attempts to survive transient
 *   WhatsApp Web slowdowns.
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
const {
  isBrowserError,
  safeSend,
  aiCircuitBreaker,
  safeAi,
} = require("./helpers");

// ── Per-chat end-question guard ───────────────────────────────────
const endingQuestion = new Set();

// How long to wait before retrying a paused quiz (ms)
const PAUSE_RETRY_MS = 15000;

// ── _sendWithRetry ────────────────────────────────────────────────
// Tries up to maxRetries times with growing delays.
// Returns the sent message, or null if all attempts failed.
// Does NOT stop the quiz — caller decides what to do on null.
async function _sendWithRetry(chatId, text, imgPath, maxRetries = 4) {
  const DELAYS = [2000, 4000, 8000, 15000]; // progressive backoff
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sent = await sendQuestionMessage(chatId, text, imgPath);
    if (sent) return sent;

    const s = getOrCreateState(chatId);
    if (!s.isActive) return null; // quiz was stopped externally — bail cleanly

    if (attempt < maxRetries) {
      const delay = DELAYS[attempt - 1] || 4000;
      logger.warn(
        `[Quiz] Send attempt ${attempt}/${maxRetries} failed for ${chatId}, retrying in ${delay}ms`,
      );
      await utils.sleep(delay);
    }
  }
  logger.error(`[Quiz] All ${maxRetries} send attempts failed for ${chatId}`);
  return null;
}

// ── sendQuestionMessage ───────────────────────────────────────────
async function sendQuestionMessage(chatId, text, imgPath, replyToMsg = null) {
  try {
    const media = await utils.loadImage(imgPath);
    if (media) {
      try {
        return await client.sendMessage(chatId, media, { caption: text });
      } catch (e) {
        if (isBrowserError(e)) return null;
        logger.warn(
          "[Send] Image send failed, falling back to text:",
          e.message,
        );
      }
    }
    if (replyToMsg) {
      try {
        return await replyToMsg.reply(text);
      } catch (e) {
        if (isBrowserError(e)) return null;
      }
    }
    return await client.sendMessage(chatId, text);
  } catch (e) {
    if (isBrowserError(e)) return null;
    logger.error("[Send] sendQuestionMessage error:", e.message);
    try {
      return await client.sendMessage(chatId, text);
    } catch {}
    return null;
  }
}

// ── _pauseAndRetry ────────────────────────────────────────────────
// Called when sending a question fails entirely.
// Marks the quiz as paused (NOT stopped), notifies the chat,
// and schedules a retry after PAUSE_RETRY_MS.
// Scores and progress are fully preserved.
async function _pauseAndRetry(chatId, questionText, imgPath, questionIndex) {
  const s = activeQuizzes.get(chatId);
  if (!s || !s.isActive) return;

  // Mark as paused so interval doesn't fire again
  s.pausedAt = Date.now();
  s.isPaused = true;

  logger.warn(
    `[Quiz] Pausing quiz in ${chatId} at Q${questionIndex + 1} — will retry in ${PAUSE_RETRY_MS / 1000}s`,
  );

  // Tell the group — don't stop, just pause
  await safeSend(
    chatId,
    `⏸️ *Quiz paused* — having trouble sending the next question.\n` +
      `Retrying in ${PAUSE_RETRY_MS / 1000} seconds... Your scores are safe! 💾`,
  );

  setTimeout(async () => {
    const current = activeQuizzes.get(chatId);
    if (!current || !current.isActive || !current.isPaused) return;

    current.isPaused = false;
    current.pausedAt = null;

    logger.info(`[Quiz] Resuming quiz in ${chatId} at Q${questionIndex + 1}`);

    const sentMsg = await _sendWithRetry(chatId, questionText, imgPath, 4);

    if (!sentMsg) {
      // Still failing — pause again for longer
      logger.error(`[Quiz] Resume failed for ${chatId} — pausing again`);
      await _pauseAndRetry(chatId, questionText, imgPath, questionIndex);
      return;
    }

    await safeSend(
      chatId,
      `▶️ *Quiz resumed!* Q${questionIndex + 1} is above ☝️`,
    );

    current.lastQuestionMsgId = sentMsg?.id?._serialized || null;
    current.questionSentAt = Date.now();
    await startQuizInterval(chatId);
  }, PAUSE_RETRY_MS);
}

// ── startQuizInterval ─────────────────────────────────────────────
async function startQuizInterval(chatId) {
  const currentState = getOrCreateState(chatId);
  if (currentState.interval) {
    clearInterval(currentState.interval);
    currentState.interval = null;
  }

  const chatCfg = storage.getQuizConfig(chatId);

  const intervalHandle = setInterval(async () => {
    try {
      const s = activeQuizzes.get(chatId);
      if (!s) {
        clearInterval(intervalHandle);
        return;
      }
      if (!s.isActive) {
        clearInterval(intervalHandle);
        s.interval = null;
        return;
      }
      // Don't fire while paused
      if (s.isPaused) return;

      if (s.interval !== intervalHandle) {
        clearInterval(intervalHandle);
        return;
      }
      const elapsed = Date.now() - (s.questionSentAt || Date.now());
      if (elapsed >= chatCfg.questionInterval) {
        clearInterval(intervalHandle);
        s.interval = null;
        await processQuestionEnd(chatId);
      }
    } catch (error) {
      if (isBrowserError(error)) {
        logger.warn(
          `[Interval] Browser disconnected in ${chatId} — pausing quiz (scores preserved).`,
        );
        const s = activeQuizzes.get(chatId);
        if (s && s.isActive) {
          if (s.interval) {
            clearInterval(s.interval);
            s.interval = null;
          }
          // Mark paused, not stopped — quiz can resume when browser reconnects
          s.isPaused = true;
          s.pausedAt = Date.now();
          // Schedule a resume attempt
          setTimeout(async () => {
            const latest = activeQuizzes.get(chatId);
            if (!latest || !latest.isActive || !latest.isPaused) return;
            latest.isPaused = false;
            latest.pausedAt = null;
            logger.info(`[Quiz] Auto-resuming interval in ${chatId}`);
            await startQuizInterval(chatId);
          }, PAUSE_RETRY_MS);
        }
      } else {
        logger.error(`[Interval] Error in ${chatId}:`, error.message);
      }
    }
  }, 1000);

  const liveState = activeQuizzes.get(chatId);
  if (liveState) {
    liveState.interval = intervalHandle;
  } else {
    clearInterval(intervalHandle);
  }
}

// ── processQuestionEnd ────────────────────────────────────────────
async function processQuestionEnd(chatId) {
  if (endingQuestion.has(chatId)) {
    logger.warn(
      `[Quiz] processQuestionEnd already running for ${chatId} — skipping`,
    );
    return;
  }
  endingQuestion.add(chatId);

  try {
    const { emojis } = CONFIG.messages;
    const state = activeQuizzes.get(chatId);
    if (!state || !state.isActive) return;

    // ── COMMIT ANSWERS ──────────────────────────────────────────────
    quizManager.commitAnswers(state);

    // 1. Build results text
    const correctAnswer = quizManager.getCurrentAnswerLetter(state);
    const correctList = Object.entries(state.currentRespondents || {})
      .filter(([, d]) => d.isCorrect)
      .map(([, d]) => d.name);

    let resultsMsg =
      `${emojis.timer} *Time's Up!*\n\n` +
      `${emojis.success} *Correct Answer: ${correctAnswer}*\n\n` +
      (quizManager.getCurrentQuestionExplanation(state) || "") +
      "\n\n" +
      `${emojis.success} *Got it right (${correctList.length}):*\n` +
      (correctList.length > 0 ? correctList.join(", ") : "Nobody this round!");

    // 2. Send results — failure here is non-fatal, quiz continues
    const resultsSent = await safeSend(chatId, resultsMsg);
    if (!resultsSent) {
      logger.warn(
        `[Quiz] Failed to send results in ${chatId} — continuing anyway`,
      );
    }

    // 3. AI explanation — fire-and-forget, never blocks quiz flow
    const currentQ = quizManager.getCurrentQuestion(state);
    if (currentQ) {
      safeAi(
        aiService.explainAnswer.bind(aiService),
        currentQ.question,
        `${correctAnswer}. ${currentQ.options?.[currentQ.answer_index] || ""}`,
        state.subject,
        state.year,
      ).then((explanation) => {
        if (explanation)
          safeSend(chatId, `${emojis.ai} *AI Insight:* ${explanation}`);
      });
    }

    // 4. Advance to next question
    const chatCfg = storage.getQuizConfig(chatId);
    const nextQ = quizManager.nextQuestion(state);

    // Reset respondents AND current answers for the new round
    state.currentRespondents = {};
    state.currentAnswers = {};

    if (nextQ) {
      await utils.sleep(chatCfg.delayBeforeNextQuestion);

      const s = activeQuizzes.get(chatId);
      if (!s || !s.isActive) return;

      const questionText = messageFormatter.formatQuestion(
        nextQ,
        s.currentQuestionIndex,
      );

      const sentMsg = await _sendWithRetry(chatId, questionText, nextQ.image);

      if (!sentMsg) {
        // ── PAUSE instead of STOP ──────────────────────────────────
        // Scores survive. Quiz will auto-resume after PAUSE_RETRY_MS.
        await _pauseAndRetry(
          chatId,
          questionText,
          nextQ.image,
          s.currentQuestionIndex,
        );
        return;
      }

      s.lastQuestionMsgId = sentMsg?.id?._serialized || null;
      s.questionSentAt = Date.now();
      await startQuizInterval(chatId);
    } else {
      // Quiz complete
      await utils.sleep(CONFIG.quiz?.delayBeforeResults || 2000);
      await sendFinalResults(chatId);
      quizManager.stop(chatId);
    }
  } catch (err) {
    // Catch-all: log but do NOT stop the quiz
    if (isBrowserError(err)) {
      logger.warn(
        `[Quiz] Browser error in processQuestionEnd for ${chatId} — quiz preserved`,
      );
      const s = activeQuizzes.get(chatId);
      if (s && s.isActive) {
        s.isPaused = true;
        s.pausedAt = Date.now();
        setTimeout(async () => {
          const latest = activeQuizzes.get(chatId);
          if (!latest || !latest.isActive || !latest.isPaused) return;
          latest.isPaused = false;
          latest.pausedAt = null;
          await startQuizInterval(chatId);
        }, PAUSE_RETRY_MS);
      }
    } else {
      logger.error(
        `[Quiz] Unexpected error in processQuestionEnd for ${chatId}:`,
        err.message,
      );
    }
  } finally {
    endingQuestion.delete(chatId);
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

  if (Object.keys(state.scoreBoard || {}).length > 0) {
    const sorted = Object.entries(state.scoreBoard).sort(
      (a, b) => b[1].score - a[1].score,
    );
    const scoreboardText = await messageFormatter.formatScoreboard(state, true);
    finalMsg += `*${emojis.trophy} Final Scoreboard:*\n\n${scoreboardText}\n\n`;

    if (sorted.length > 0) {
      const [winnerId, winnerData] = sorted[0];
      const info = await utils.getUserDisplayInfo(winnerId, winnerData.name);
      const pct = Math.round((winnerData.score / state.questions.length) * 100);
      winnerName = info.name;
      winnerScore = winnerData.score;
      finalMsg += `${emojis.celebrate} *Winner: ${info.name}*\n`;
      finalMsg += `Score: ${winnerData.score}/${state.questions.length} (${pct}%)\n\n`;
    }
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
    // Use cached name if getContact fails — never block answer recording
    let userName = userId.replace(/@\S+$/, "");
    try {
      const contact = await msg.getContact();
      userName = contact.pushname || contact.name || contact.number || userName;
    } catch {
      // Silent fallback — answer is still recorded with userId-derived name
    }
    quizManager.recordAnswer(state, userId, userName, answerLetter);
  } catch (e) {
    if (!isBrowserError(e)) logger.error("[Answer] Error:", e.message);
  }
}

// ── handleStartQuiz ───────────────────────────────────────────────
async function handleStartQuiz(msg, args) {
  const { emojis } = CONFIG.messages;
  if (!(await permissions.isModerator(msg))) {
    await msg.reply(
      "⛔ Only Moderators, Bot Admins, or the Owner can start quizzes.",
    );
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
    await msg.reply(
      `${emojis.error} No questions found for *${subject} ${year}*.`,
    );
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

  await utils.sleep(chatCfg.delayBeforeFirstQuestion || 3000);

  const s = activeQuizzes.get(chatId);
  if (!s || !s.isActive) return;

  const firstQ = quizManager.getCurrentQuestion(s);
  if (!firstQ) return;

  const sentMsg = await _sendWithRetry(
    chatId,
    messageFormatter.formatQuestion(firstQ, 0),
    firstQ.image,
  );

  if (!sentMsg) {
    // Pause on first question too — don't kill the quiz before it starts
    await _pauseAndRetry(
      chatId,
      messageFormatter.formatQuestion(firstQ, 0),
      firstQ.image,
      0,
    );
    return;
  }

  const liveState = activeQuizzes.get(chatId);
  if (!liveState || !liveState.isActive) return;
  liveState.lastQuestionMsgId = sentMsg?.id?._serialized || null;
  liveState.questionSentAt = Date.now();
  await startQuizInterval(chatId);
}

// ── handleStopQuiz ────────────────────────────────────────────────
async function handleStopQuiz(msg) {
  const { emojis } = CONFIG.messages;
  if (!(await permissions.isModerator(msg))) {
    await msg.reply(
      "⛔ Only Moderators, Bot Admins, or the Owner can stop quizzes.",
    );
    return;
  }
  const chatId = msg.from;
  const state = activeQuizzes.get(chatId);
  if (!state || !state.isActive) {
    await msg.reply(`${emojis.warning} No active quiz in this chat.`);
    return;
  }
  const stats = quizManager.getStats(state);
  let stopMsg =
    `${emojis.stop} *Quiz Stopped*\n\n` +
    `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
    `Duration: ${stats.duration}\n\n`;
  stopMsg +=
    Object.keys(state.scoreBoard || {}).length > 0
      ? `*Scores:*\n${await messageFormatter.formatScoreboard(state)}`
      : "No scores recorded.";
  quizManager.stop(chatId);
  await msg.reply(stopMsg);
}

// ── handleScore ───────────────────────────────────────────────────
async function handleScore(msg) {
  const { emojis } = CONFIG.messages;
  const chatId = msg.from;
  const state = activeQuizzes.get(chatId);
  if (!state || !state.isActive) {
    await msg.reply(
      `${emojis.warning} No active quiz.\n\nStart with ${CONFIG.bot.prefix}start [subject] [year]`,
    );
    return;
  }
  if (Object.keys(state.scoreBoard || {}).length === 0) {
    await msg.reply(`${emojis.chart} *Scoreboard*\n\nNo answers yet!`);
    return;
  }
  const sb = await messageFormatter.formatScoreboard(state, true);
  const pauseNote = state.isPaused
    ? "\n\n⏸️ _Quiz is currently paused — will resume shortly_"
    : "";
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
  const pauseNote = state.isPaused
    ? "\n⏸️ Status: *Paused* (auto-resuming)"
    : "\n▶️ Status: *Running*";
  await msg.reply(
    `${emojis.info} *Quiz Stats*\n\n` +
      `Subject: ${state.subject?.toUpperCase()} ${state.year}\n` +
      `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
      `Remaining: ${stats.remainingQuestions}\n` +
      `Participants: ${stats.participants}\n` +
      `Duration: ${stats.duration}${pauseNote}`,
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
    messageFormatter.formatQuestion(
      { ...result.question, year },
      result.index,
    ) +
    `\n\n_Reply A, B, C, or D_`;
  await sendQuestionMessage(msg.from, text, result.question.image, msg);
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
