/**
 * commandHandler.js — JAMB Quiz Bot v3.1.0 (FIXED)
 * =======================================================
 *
 * ROOT CAUSE OF Q42 FREEZE:
 * --------------------------
 * Every question, aiService.explainAnswer() was called INSIDE processQuestionEnd().
 * With no xAI credits, every call threw an unhandled rejection. In some Node versions
 * (or under high load) this unhandled rejection killed the timer callback before
 * `nextQuestion()` was ever called — meaning the quiz silently stopped and the group
 * got nothing: no next question, no scoreboard. This is confirmed by the 30+ consecutive
 * "AI API error" lines in the log all coming from the biology quiz session.
 *
 * FIXES APPLIED:
 * --------------
 * 1. AI circuit breaker: after 3 consecutive failures, stop calling the AI for 10 min.
 * 2. ALL AI calls are wrapped in try/catch and fire-and-forget (non-blocking).
 * 3. _sendWithRetry(): exponential backoff retry wrapper for question sends.
 * 4. processQuestionEnd() is fully guarded — AI error can NEVER stop the quiz.
 * 5. sendFinalResults() always fires — even if mid-quiz errors occurred.
 * 6. Browser crash detection to stop the interval cleanly.
 */

const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const permissions = require("./permissions");
const dataManager = require("./dataManager");
const quizManager = require("./quizManager");
const messageFormatter = require("./messageFormatter");
const { getOrCreateState, activeQuizzes } = require("./state");
const client = require("./client");
const aiService = require("./Aiservice");

// ── AI Circuit Breaker ────────────────────────────────────────────
// After THRESHOLD consecutive AI failures, open the circuit for RESET_MS.
// This prevents the xAI "no credits" error from spamming logs 30+ times
// AND from ever blocking the quiz flow.
const aiCircuitBreaker = {
  failures: 0,
  lastFailure: null,
  isOpen: false,
  THRESHOLD: 3,
  RESET_MS: 10 * 60 * 1000, // 10 minutes

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.THRESHOLD && !this.isOpen) {
      this.isOpen = true;
      logger.warn(
        `[AI] Circuit OPEN — suppressing AI calls for ${this.RESET_MS / 60000} min. ` +
          `(Likely no credits — visit https://console.x.ai to add them.)`,
      );
    }
  },

  canTry() {
    if (!CONFIG.ai?.apiKey) return false;
    if (!this.isOpen) return true;
    if (Date.now() - this.lastFailure > this.RESET_MS) {
      this.isOpen = false;
      this.failures = 0;
      logger.info("[AI] Circuit RESET — resuming AI calls");
      return true;
    }
    return false;
  },

  // Expose for dashboard / .chatconfig command
  status() {
    return {
      isOpen: this.isOpen,
      failures: this.failures,
      canTry: this.canTry(),
      resetIn: this.isOpen
        ? Math.max(
            0,
            Math.round(
              (this.RESET_MS - (Date.now() - this.lastFailure)) / 1000,
            ),
          )
        : 0,
    };
  },
};

// ── Safe AI call — NEVER throws, NEVER blocks ─────────────────────
async function safeAi(fn, ...args) {
  if (!aiCircuitBreaker.canTry()) return null;
  try {
    return await fn(...args);
  } catch (e) {
    aiCircuitBreaker.recordFailure();
    logger.warn("[AI] Call failed:", e.message?.slice(0, 120));
    return null;
  }
}

// ── Browser crash detection ───────────────────────────────────────
function isBrowserError(error) {
  const msg = error?.message || "";
  return (
    msg.includes("Target closed") ||
    msg.includes("detached Frame") ||
    msg.includes("Session closed") ||
    msg.includes("Protocol error") ||
    msg.includes("Execution context was destroyed") ||
    msg.includes("Cannot find context") ||
    msg.includes("Connection closed")
  );
}

// ── Safe send — never throws ──────────────────────────────────────
async function safeSend(chatId, text) {
  try {
    return await client.sendMessage(chatId, text);
  } catch (e) {
    if (!isBrowserError(e)) logger.error("[Send] Error:", e.message);
    return null;
  }
}

function isPrivateChat(chatId) {
  return chatId.endsWith("@c.us") || chatId.endsWith("@lid");
}

// ──────────────────────────────────────────────────────────────────
const commandHandler = {
  // ─────────────────────────────────────────────────────────────────
  // _sendWithRetry
  // ─────────────────────────────────────────────────────────────────
  // Retries sending a question message up to maxRetries times with
  // increasing delay. This handles transient WhatsApp rate-limits
  // that could silently fail the send.
  async _sendWithRetry(chatId, text, imgPath, maxRetries = 4) {
    const BASE_MS = 1500;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const sent = await this.sendQuestionMessage(chatId, text, imgPath);
      if (sent) return sent;
      if (attempt < maxRetries) {
        const s = getOrCreateState(chatId);
        if (!s.isActive) return null; // quiz was stopped mid-retry
        const delay = BASE_MS * attempt;
        logger.warn(
          `[Quiz] Send attempt ${attempt}/${maxRetries} failed for ${chatId}, retrying in ${delay}ms`,
        );
        await utils.sleep(delay);
      }
    }
    logger.error(`[Quiz] All ${maxRetries} send attempts failed for ${chatId}`);
    return null;
  },

  // ─────────────────────────────────────────────────────────────────
  // MAIN MESSAGE HANDLER
  // ─────────────────────────────────────────────────────────────────
  async handle(msg) {
    try {
      const { prefix } = CONFIG.bot;
      const body = msg.body || "";
      const trimmed = body.trim();
      const chatId = msg.from;
      const isOwner = permissions.isOwner(msg);

      if (storage.isGloballyDisabled() && !isOwner) return;

      const chatDisabled = storage.isChatDisabled(chatId);

      // Answer handling (A/B/C/D) — works even if no prefix
      if (!chatDisabled) {
        const upper = trimmed.toUpperCase();
        if (/^[A-D]$/.test(upper)) {
          await this.handleAnswer(msg, upper);
          return;
        }
      }

      const prefixRegex = new RegExp(`^\\${prefix}\\s*\\S`);
      if (!prefixRegex.test(trimmed)) return;

      const withoutPrefix = trimmed
        .replace(new RegExp(`^\\${prefix}\\s*`), "")
        .trim();
      const [cmd, ...argParts] = withoutPrefix.toLowerCase().split(/\s+/);
      const rawArgs = trimmed
        .replace(new RegExp(`^\\${prefix}\\s*\\S+\\s*`), "")
        .trim();

      // Commands allowed even when chat is disabled
      const alwaysAllowed = new Set([
        "help",
        "myrole",
        "ping",
        "enable",
        "genable",
        "gdisable",
        "whoami",
        "admin",
        "mod",
        "chatconfig",
      ]);

      if (
        chatDisabled &&
        !permissions.isOwner(msg) &&
        !(await permissions.isBotAdmin(msg)) &&
        !alwaysAllowed.has(cmd)
      ) {
        await msg.reply(
          `⚠️ Bot is disabled here. Use ${prefix}enable to re-enable.`,
        );
        return;
      }

      switch (cmd) {
        case "ping":
          return await this.handlePing(msg);
        case "help":
          return await this.handleHelp(msg);
        case "myrole":
          return await this.handleMyRole(msg);
        case "subjects":
          return await this.handleSubjects(msg);
        case "years":
          return await this.handleYears(msg, argParts);
        case "question":
          return await this.handleQuestion(msg, argParts);
        case "score":
          return await this.handleScore(msg);
        case "stats":
          return await this.handleStats(msg);
        case "start":
          return await this.handleStartQuiz(msg, argParts);
        case "stop":
          return await this.handleStopQuiz(msg);
        case "setinterval":
          return await this.handleSetInterval(msg, argParts);
        case "setdelay":
          return await this.handleSetDelay(msg, argParts);
        case "setmax":
          return await this.handleSetMax(msg, argParts);
        case "chatconfig":
          return await this.handleChatConfig(msg);
        case "enable":
          return await this.handleEnable(msg);
        case "disable":
          return await this.handleDisable(msg);
        case "admin":
          return await this.handleAdmin(msg, argParts);
        case "mod":
          return await this.handleMod(msg, argParts);
        case "announce":
          return await this.handleAnnounce(msg, rawArgs);
        case "setwelcome":
          return await this.handleSetWelcome(msg, rawArgs);
        case "clearwelcome":
          return await this.handleClearWelcome(msg);
        case "resetconfig":
          return await this.handleResetConfig(msg);
        case "quizhistory":
          return await this.handleQuizHistory(msg);
        case "genable":
          return await this.handleGlobalEnable(msg);
        case "gdisable":
          return await this.handleGlobalDisable(msg);
        case "broadcast":
          return await this.handleBroadcast(msg, rawArgs);
        case "chats":
          return await this.handleChats(msg);
        case "allstaff":
          return await this.handleAllStaff(msg);
        case "clearstaff":
          return await this.handleClearStaff(msg);
        case "whoami":
          await msg.reply(permissions.getUserId(msg));
          break;
        case "ai":
          return await this.handleAiChat(msg, rawArgs);
        case "genq":
          return await this.handleGenerateQuestions(msg, argParts);
        case "daily":
          return await this.handleDailyToggle(msg);
        default:
          break;
      }
    } catch (error) {
      if (isBrowserError(error)) {
        logger.warn(
          `[Handle] Browser error for ${msg?.from}: ${error.message?.slice(0, 80)}`,
        );
        return;
      }
      logger.error("[Handle] Unhandled error:", error);
      try {
        await msg.reply("❌ An unexpected error occurred.");
      } catch {}
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // processQuestionEnd — THE FIXED METHOD
  // ─────────────────────────────────────────────────────────────────
  async processQuestionEnd(chatId) {
    const { emojis } = CONFIG.messages;
    const state = getOrCreateState(chatId);
    if (!state.isActive) return;

    // ── 1. Build results text ─────────────────────────────────────
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

    // ── 2. Send results (non-fatal if it fails) ───────────────────
    const resultsSent = await safeSend(chatId, resultsMsg);
    if (!resultsSent) {
      logger.warn(`[Quiz] Failed to send results in ${chatId}`);
    }

    // ── 3. AI explanation — fire-and-forget, NEVER blocks the quiz ─
    //    This was the root cause: the AI call was awaited inline and
    //    threw when credits were exhausted, killing the function.
    const currentQ = quizManager.getCurrentQuestion(state);
    if (currentQ) {
      // Completely detached — no await, catches its own errors
      safeAi(
        aiService.explainAnswer.bind(aiService),
        currentQ.question,
        `${correctAnswer}. ${currentQ.options?.[currentQ.answer_index] || ""}`,
        state.subject,
        state.year,
      ).then((explanation) => {
        if (explanation)
          safeSend(chatId, `${emojis.ai} *AI Insight:* ${explanation}`);
      }); // .catch is inside safeAi already
    }

    // ── 4. Advance to next question ───────────────────────────────
    const chatCfg = storage.getQuizConfig(chatId);
    const nextQ = quizManager.nextQuestion(state);
    state.currentRespondents = {};

    if (nextQ) {
      await utils.sleep(chatCfg.delayBeforeNextQuestion);

      // Re-check: quiz may have been stopped during sleep
      const s = getOrCreateState(chatId);
      if (!s.isActive) return;

      const questionText = messageFormatter.formatQuestion(
        nextQ,
        s.currentQuestionIndex,
      );

      // ── RETRY — the main fix for the silent freeze ────────────
      const sentMsg = await this._sendWithRetry(
        chatId,
        questionText,
        nextQ.image,
      );

      if (!sentMsg) {
        // All retries exhausted — show scoreboard before giving up
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
      await this.startQuizInterval(chatId);
    } else {
      // ── 5. Quiz complete — always send final scoreboard ────────
      await utils.sleep(CONFIG.quiz?.delayBeforeResults || 2000);
      await this.sendFinalResults(chatId);
      quizManager.stop(chatId);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // startQuizInterval — with browser crash guard
  // ─────────────────────────────────────────────────────────────────
  async startQuizInterval(chatId) {
    const state = getOrCreateState(chatId);
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
    const chatCfg = storage.getQuizConfig(chatId);

    state.interval = setInterval(async () => {
      try {
        const s = getOrCreateState(chatId);
        if (!s.isActive) {
          clearInterval(s.interval);
          s.interval = null;
          return;
        }
        const elapsed = Date.now() - (s.questionSentAt || Date.now());
        if (elapsed >= chatCfg.questionInterval) {
          clearInterval(s.interval);
          s.interval = null;
          await commandHandler.processQuestionEnd(chatId);
        }
      } catch (error) {
        if (isBrowserError(error)) {
          logger.warn(
            `[Interval] Browser disconnected in ${chatId} — stopping quiz.`,
          );
          const s = getOrCreateState(chatId);
          if (s.interval) {
            clearInterval(s.interval);
            s.interval = null;
          }
          quizManager.stop(chatId);
        } else {
          logger.error(`[Interval] Error in ${chatId}:`, error.message);
        }
      }
    }, 1000);
  },

  // ─────────────────────────────────────────────────────────────────
  // sendFinalResults
  // ─────────────────────────────────────────────────────────────────
  async sendFinalResults(chatId) {
    const state = getOrCreateState(chatId);
    const stats = quizManager.getStats(state);
    const { emojis } = CONFIG.messages;

    let finalMsg = `🏁 *Quiz Complete!*\n\n`;
    let winnerName = null;
    let winnerScore = 0;

    if (Object.keys(state.scoreBoard || {}).length > 0) {
      const sorted = Object.entries(state.scoreBoard).sort(
        (a, b) => b[1].score - a[1].score,
      );
      const scoreboardText = await messageFormatter.formatScoreboard(
        state,
        true,
      );
      finalMsg += `*${emojis.trophy} Final Scoreboard:*\n\n${scoreboardText}\n\n`;

      if (sorted.length > 0) {
        const [winnerId, winnerData] = sorted[0];
        const info = await utils.getUserDisplayInfo(winnerId, winnerData.name);
        const pct = Math.round(
          (winnerData.score / state.questions.length) * 100,
        );
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

    // Persist to history
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
  },

  // ─────────────────────────────────────────────────────────────────
  // ANSWER HANDLER
  // ─────────────────────────────────────────────────────────────────
  async handleAnswer(msg, answerLetter) {
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) return;
    try {
      const userId = permissions.getUserId(msg);
      const contact = await msg.getContact();
      const userName =
        contact.pushname || contact.name || contact.number || userId;
      quizManager.updateScore(state, userId, userName, answerLetter);
    } catch (e) {
      if (!isBrowserError(e)) logger.error("[Answer] Error:", e.message);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // START QUIZ
  // ─────────────────────────────────────────────────────────────────
  async handleStartQuiz(msg, args) {
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

    const freshState = getOrCreateState(chatId);
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

    const s = getOrCreateState(chatId);
    if (!s.isActive) return;

    const firstQ = quizManager.getCurrentQuestion(s);
    if (!firstQ) return;

    const sentMsg = await this._sendWithRetry(
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

    s.lastQuestionMsgId = sentMsg?.id?._serialized || null;
    s.questionSentAt = Date.now();
    await this.startQuizInterval(chatId);
  },

  // ─────────────────────────────────────────────────────────────────
  // STOP QUIZ
  // ─────────────────────────────────────────────────────────────────
  async handleStopQuiz(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators, Bot Admins, or the Owner can stop quizzes.",
      );
      return;
    }
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) {
      await msg.reply(`${emojis.warning} No active quiz in this chat.`);
      return;
    }
    const stats = quizManager.getStats(state);
    let stopMsg = `${emojis.stop} *Quiz Stopped*\n\nProgress: ${stats.completedQuestions}/${stats.totalQuestions}\nDuration: ${stats.duration}\n\n`;
    stopMsg +=
      Object.keys(state.scoreBoard || {}).length > 0
        ? `*Scores:*\n${await messageFormatter.formatScoreboard(state)}`
        : "No scores recorded.";
    quizManager.stop(chatId);
    await msg.reply(stopMsg);
  },

  // ─────────────────────────────────────────────────────────────────
  // SEND QUESTION MESSAGE
  // ─────────────────────────────────────────────────────────────────
  async sendQuestionMessage(chatId, text, imgPath, replyToMsg = null) {
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
  },

  // ─────────────────────────────────────────────────────────────────
  // SCORE / STATS
  // ─────────────────────────────────────────────────────────────────
  async handleScore(msg) {
    const { emojis } = CONFIG.messages;
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) {
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
  },

  async handleStats(msg) {
    const { emojis } = CONFIG.messages;
    const state = getOrCreateState(msg.from);
    if (!state.isActive) {
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
  },

  // ─────────────────────────────────────────────────────────────────
  // AI CHAT
  // ─────────────────────────────────────────────────────────────────
  async handleAiChat(msg, text) {
    const { emojis } = CONFIG.messages;
    if (!text || text.length < 2) {
      await msg.reply(
        `${emojis.ai} *AI Assistant*\n\nUsage: ${CONFIG.bot.prefix}ai [question]\nExample: _${CONFIG.bot.prefix}ai explain osmosis_`,
      );
      return;
    }
    if (!aiCircuitBreaker.canTry()) {
      const s = aiCircuitBreaker.status();
      await msg.reply(
        `${emojis.warning} AI is temporarily unavailable (credits exhausted). Resets in ~${Math.ceil(s.resetIn / 60)}min.`,
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
  },

  // ─────────────────────────────────────────────────────────────────
  // GENERATE QUESTIONS
  // ─────────────────────────────────────────────────────────────────
  async handleGenerateQuestions(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can generate questions.",
      );
      return;
    }
    if (!aiCircuitBreaker.canTry()) {
      await msg.reply(`${emojis.warning} AI unavailable right now.`);
      return;
    }
    if (args.length < 2) {
      await msg.reply(
        `${emojis.error} Usage: ${CONFIG.bot.prefix}genq [subject] [topic] [count]\nExample: _${CONFIG.bot.prefix}genq biology cell division 5_`,
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
      `${emojis.ai} Generating ${count} questions on *${topic}*...\n_10-15 seconds..._`,
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
        return `*Q${i + 1}.* ${q.question}\n${opts}\n✅ Answer: ${utils.indexToLetter(q.answer_index)}`;
      })
      .join("\n\n");

    try {
      await status.edit(
        `${emojis.ai} *Generated ${questions.length} questions for ${subject.toUpperCase()} — "${topic}"*\n\n${preview}` +
          `${questions.length > 3 ? `\n\n_...and ${questions.length - 3} more_` : ""}\n\n` +
          `Reply *yes* within 30s to save.`,
      );
    } catch {}

    const confirmed = await this._waitForReply(
      msg.from,
      permissions.getUserId(msg),
      30000,
    );
    if (!confirmed) {
      await safeSend(msg.from, `${emojis.info} Questions discarded.`);
      return;
    }

    const fs = require("fs").promises;
    const path = require("path");
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
      `${emojis.success} Saved ${questions.length} questions! File: \`${filename}\`\nUse: _${CONFIG.bot.prefix}start ${subject} ai_${subject}_${ts}_`,
    );
  },

  // ─────────────────────────────────────────────────────────────────
  // DAILY QUESTION
  // ─────────────────────────────────────────────────────────────────
  async handleDailyToggle(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators or above can toggle daily questions.",
      );
      return;
    }
    const chatId = msg.from;
    const chats = await this._loadDailyChats();
    if (chats.includes(chatId)) {
      await this._saveDailyChats(chats.filter((id) => id !== chatId));
      await msg.reply(
        `${emojis.daily || "📅"} Daily questions *disabled* for this chat.`,
      );
    } else {
      chats.push(chatId);
      await this._saveDailyChats(chats);
      await msg.reply(
        `${emojis.daily || "📅"} Daily questions *enabled!* You'll get a practice question every day at ${CONFIG.daily?.hour || 8}:00 WAT.`,
      );
    }
  },

  async sendDailyQuestion(chatId) {
    try {
      const subjects = await dataManager.getAvailableSubjects();
      if (!subjects.length) return;
      const subject = subjects[Math.floor(Math.random() * subjects.length)];
      const years = await dataManager.getAvailableYears(subject);
      if (!years.length) return;
      const year = years[Math.floor(Math.random() * years.length)];
      const result = await dataManager.getRandomQuestion(subject, year);
      if (!result) return;
      const { question } = result;
      const text =
        `📅 *Daily Practice Question*\n📖 ${subject.toUpperCase()} ${year}\n\n` +
        messageFormatter.formatQuestion({ ...question, year }, 0) +
        `\n\n_Reply A, B, C, or D — answer in 5 minutes!_`;
      const sent = await safeSend(chatId, text);
      if (!sent) return;
      // Hint (non-blocking)
      safeAi(
        aiService.generateDailyHint?.bind(aiService),
        question.question,
        subject,
      ).then((hint) => {
        if (hint)
          setTimeout(() => safeSend(chatId, `💡 *Hint:* ${hint}`), 3000);
      });
      // Reveal answer after 5 minutes
      setTimeout(
        async () => {
          const answer = utils.indexToLetter(question.answer_index);
          let revealText = `${CONFIG.messages.emojis.success} *Daily Answer: ${answer}*\n\n${question.explanation || "No explanation available."}`;
          const aiExp = await safeAi(
            aiService.explainAnswer?.bind(aiService),
            question.question,
            `${answer}. ${question.options?.[question.answer_index]}`,
            subject,
            year,
          );
          if (aiExp)
            revealText += `\n\n${CONFIG.messages.emojis.ai} *AI:* ${aiExp}`;
          await safeSend(chatId, revealText);
        },
        5 * 60 * 1000,
      );
    } catch (e) {
      logger.error(`[Daily] Error for ${chatId}:`, e.message);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // CONFIG COMMANDS
  // ─────────────────────────────────────────────────────────────────
  async handleSetInterval(msg, args) {
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
  },

  async handleSetDelay(msg, args) {
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
  },

  async handleSetMax(msg, args) {
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
  },

  async handleChatConfig(msg) {
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
  },

  // ─────────────────────────────────────────────────────────────────
  // ENABLE / DISABLE
  // ─────────────────────────────────────────────────────────────────
  async handleEnable(msg) {
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
  },

  async handleDisable(msg) {
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
  },

  async handleGlobalEnable(msg) {
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can globally enable the bot.");
      return;
    }
    await storage.setGlobalDisabled(false);
    await msg.reply("✅ Bot globally *enabled* 🌐");
  },

  async handleGlobalDisable(msg) {
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
  },

  // ─────────────────────────────────────────────────────────────────
  // ADMIN / MOD MANAGEMENT
  // ─────────────────────────────────────────────────────────────────
  async handleAdmin(msg, args) {
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
      await msg.reply(
        `🛡️ *Bot Admins (${list.length}):*\n\n${lines.join("\n")}`,
      );
      return;
    }

    const targetId = this._resolveTarget(msg, rest);
    if (!targetId) {
      await msg.reply(`❌ Mention someone or provide a phone number.`);
      return;
    }
    const targetInfo = await utils.getUserDisplayInfo(targetId);

    if (action === "add") {
      const added = await permissions.addBotAdmin(chatId, targetId);
      await msg.reply(
        added
          ? `✅ *${targetInfo.name}* is now a Bot Admin.`
          : `⚠️ Already a Bot Admin.`,
      );
    } else if (action === "remove") {
      const removed = await permissions.removeBotAdmin(chatId, targetId);
      await msg.reply(
        removed
          ? `✅ *${targetInfo.name}* removed as Bot Admin.`
          : `⚠️ Not a Bot Admin here.`,
      );
    }
  },

  async handleMod(msg, args) {
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
      await msg.reply(
        `⭐ *Moderators (${list.length}):*\n\n${lines.join("\n")}`,
      );
      return;
    }

    const targetId = this._resolveTarget(msg, rest);
    if (!targetId) {
      await msg.reply("❌ Mention someone or provide a phone number.");
      return;
    }
    const targetInfo = await utils.getUserDisplayInfo(targetId);

    if (action === "add") {
      const result = await permissions.addModerator(chatId, targetId);
      await msg.reply(
        result === "already_admin"
          ? `⚠️ *${targetInfo.name}* is already a Bot Admin.`
          : result
            ? `✅ *${targetInfo.name}* is now a Moderator.`
            : `⚠️ Already a Moderator.`,
      );
    } else if (action === "remove") {
      const removed = await permissions.removeModerator(chatId, targetId);
      await msg.reply(
        removed
          ? `✅ *${targetInfo.name}* removed as Moderator.`
          : `⚠️ Not a Moderator here.`,
      );
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // OTHER COMMANDS
  // ─────────────────────────────────────────────────────────────────
  async handlePing(msg) {
    const t = Date.now();
    const reply = await msg.reply("ℹ️ Pong!");
    await reply.edit(`✅ Pong! _(${Date.now() - t}ms)_`);
  },

  async handleHelp(msg) {
    await msg.reply(await messageFormatter.formatHelp(msg.from, msg));
  },

  async handleMyRole(msg) {
    const role = await permissions.getRoleName(msg);
    await msg.reply(`ℹ️ Your role: *${role}*`);
  },

  async handleSubjects(msg) {
    const subjects = await dataManager.getAvailableSubjects();
    await msg.reply(
      `📚 *Available Subjects:*\n\n${subjects.map((s) => `• ${s.toUpperCase()}`).join("\n")}`,
    );
  },

  async handleYears(msg, args) {
    if (!args[0]) {
      await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}years [subject]`);
      return;
    }
    const years = await dataManager.getAvailableYears(args[0].toLowerCase());
    await msg.reply(
      `📅 *Years for ${args[0].toUpperCase()}:*\n\n${years.map((y) => `• ${y}`).join("\n")}\n\n_Use \`all\` for all years_`,
    );
  },

  async handleQuestion(msg, args) {
    if (args.length < 2) {
      await msg.reply(
        `❌ Usage: ${CONFIG.bot.prefix}question [subject] [year]`,
      );
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
    await this.sendQuestionMessage(msg.from, text, result.question.image, msg);
  },

  async handleAnnounce(msg, text) {
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can make announcements.",
      );
      return;
    }
    if (!text) {
      await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}announce [message]`);
      return;
    }
    await safeSend(msg.from, `📢 *Announcement*\n\n${text}`);
  },

  async handleSetWelcome(msg, text) {
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
  },

  async handleClearWelcome(msg) {
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can clear welcome messages.",
      );
      return;
    }
    await storage.clearWelcomeMessage(msg.from);
    await msg.reply("✅ Welcome message cleared.");
  },

  async handleResetConfig(msg) {
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply("⛔ Only Bot Admins or the Owner can reset config.");
      return;
    }
    await storage.resetQuizConfig(msg.from);
    await msg.reply("✅ Config reset to defaults.");
  },

  async handleQuizHistory(msg) {
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
      return `${i + 1}. *${h.subject?.toUpperCase()} ${h.year}* — ${d}\n   ${h.questionsAnswered || h.questions}/${h.questions}Qs | ${h.participants} players | ${h.winner ? `🥇 ${h.winner}` : "No winner"} | ⏱️ ${h.duration}`;
    });
    await msg.reply(
      `📊 *Quiz History (last ${lines.length}):*\n\n${lines.join("\n\n")}`,
    );
  },

  async handleBroadcast(msg, text) {
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
  },

  async handleChats(msg) {
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can view all chats.");
      return;
    }
    const active = [...activeQuizzes.entries()].filter(([, s]) => s.isActive);
    const ai = aiCircuitBreaker.status();
    let text = `📊 *Bot Overview*\n\n🟢 Active quizzes: ${active.length}\n🔴 Disabled: ${storage.permissions.disabledChats?.length || 0}\n🌐 Global: ${storage.isGloballyDisabled() ? "DISABLED" : "Active"}\n🤖 AI: ${ai.canTry ? "🟢" : "🟡 Circuit open"}\n\n`;
    if (active.length > 0) {
      text += "*Active:*\n";
      active.forEach(([chatId, s], i) => {
        text += `${i + 1}. ${chatId}\n   ${s.subject?.toUpperCase()} ${s.year} — Q${s.currentQuestionIndex + 1}/${s.questions.length}\n`;
      });
    }
    await msg.reply(text);
  },

  async handleAllStaff(msg) {
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
  },

  async handleClearStaff(msg) {
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can clear staff.");
      return;
    }
    const chatId = msg.from;
    await storage.clearBotAdmins(chatId);
    await storage.clearModerators(chatId);
    await msg.reply("✅ All Bot Admins and Moderators cleared for this chat.");
  },

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────
  _resolveTarget(msg, rest) {
    if (msg.mentionedIds?.length > 0) return msg.mentionedIds[0];
    if (rest?.length > 0) return utils.normalizePhone(rest[0]);
    return null;
  },

  async _waitForReply(chatId, userId, timeoutMs) {
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
  },

  async _loadDailyChats() {
    try {
      const raw = await require("fs").promises.readFile(
        "./data/daily_chats.json",
        "utf-8",
      );
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  async _saveDailyChats(chats) {
    await require("fs").promises.mkdir("./data", { recursive: true });
    await require("fs").promises.writeFile(
      "./data/daily_chats.json",
      JSON.stringify(chats, null, 2),
    );
  },

  // Expose for dashboard API
  getAiStatus: () => aiCircuitBreaker.status(),
};

module.exports = commandHandler;
