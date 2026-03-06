/**
 * handlers/quizHandlers.js
 * Core quiz engine and quiz-facing commands.
 *
 * CHANGES v3.3.1:
 * - processQuestionEnd now calls quizManager.commitAnswers() before scoring.
 *   This means a user's score is based on their FINAL answer, not every
 *   submission. Changing A → B → C before time is up no longer penalises them.
 * - currentAnswers is reset when advancing to the next question.
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

// ── _sendWithRetry ────────────────────────────────────────────────
async function _sendWithRetry(chatId, text, imgPath, maxRetries = 4) {
  const BASE_MS = 1500;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sent = await sendQuestionMessage(chatId, text, imgPath);
    if (sent) return sent;
    if (attempt < maxRetries) {
      const s = getOrCreateState(chatId);
      if (!s.isActive) return null;
      const delay = BASE_MS * attempt;
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
          `[Interval] Browser disconnected in ${chatId} — stopping quiz.`,
        );
        const s = activeQuizzes.get(chatId);
        if (s) {
          if (s.interval) {
            clearInterval(s.interval);
            s.interval = null;
          }
          quizManager.stop(chatId);
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
    // Score every user based on their FINAL submitted answer.
    // Must happen before reading currentRespondents below.
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

    // 2. Send results
    const resultsSent = await safeSend(chatId, resultsMsg);
    if (!resultsSent) {
      logger.warn(`[Quiz] Failed to send results in ${chatId}`);
    }

    // 3. AI explanation — fire-and-forget
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
        logger.error(
          `[Quiz] Cannot send Q${s.currentQuestionIndex + 1} in ${chatId} after retries — stopping.`,
        );
        const scoreboard = await messageFormatter.formatScoreboard(s);
        await safeSend(
          chatId,
          `${emojis.error} *Quiz interrupted* — couldn't deliver the next question.\n\n` +
            `${emojis.chart} *Scoreboard so far:*\n\n${scoreboard}\n\n` +
            `Use ${CONFIG.bot.prefix}start to restart. 🙏`,
        );
        quizManager.stop(chatId);
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
    const contact = await msg.getContact();
    const userName =
      contact.pushname || contact.name || contact.number || userId;
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
    await safeSend(
      chatId,
      `${emojis.error} *Could not start quiz* — failed to send the first question. Please try again.`,
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
  await msg.reply(
    `${emojis.chart} *Scoreboard*\n\n${sb}\n\nQ: ${state.currentQuestionIndex + 1}/${state.questions.length}`,
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
  await msg.reply(
    `${emojis.info} *Quiz Stats*\n\n` +
      `Subject: ${state.subject?.toUpperCase()} ${state.year}\n` +
      `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
      `Remaining: ${stats.remainingQuestions}\n` +
      `Participants: ${stats.participants}\n` +
      `Duration: ${stats.duration}`,
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
