/**
 * quizManager.js — v3.4.0
 *
 * Changes:
 * - stop() clears _questionTimer (single-shot setTimeout) instead of
 *   interval (the old setInterval handle). Both are cleared for safety.
 * - commitAnswers uses for..of instead of Object.entries().map() to
 *   avoid intermediate array allocations in the scoring hot path.
 * - getStats accesses state fields directly — no intermediate objects.
 */

const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const dataManager = require("./dataManager");
const { activeQuizzes, getOrCreateState, createFreshState } = require("./state");

const quizManager = {
  getCurrentQuestion(state) {
    if (!state.isActive || state.currentQuestionIndex >= state.questions.length) return null;
    return state.questions[state.currentQuestionIndex];
  },

  getCurrentAnswerLetter(state) {
    const q = this.getCurrentQuestion(state);
    return q ? utils.indexToLetter(q.answer_index) : null;
  },

  getCurrentQuestionExplanation(state) {
    const q = this.getCurrentQuestion(state);
    return q?.explanation ? `💡 Explanation: ${q.explanation}` : "No Explanation Available";
  },

  checkAnswer(state, answerIndex) {
    const q = this.getCurrentQuestion(state);
    return q ? answerIndex === q.answer_index : false;
  },

  nextQuestion(state) {
    state.currentQuestionIndex++;
    return this.getCurrentQuestion(state);
  },

  async start(subject, year, chatId) {
    const state = getOrCreateState(chatId);
    const chatCfg = storage.getQuizConfig(chatId);
    let allQuestions = [];

    if (["random", "all"].includes(year.toLowerCase())) {
      const years = await dataManager.getAvailableYears(subject);
      for (const y of years) {
        const data = await dataManager.loadQuestions(subject, y);
        if (data) {
          for (const q of data.questions) allQuestions.push({ ...q, year: y });
        }
      }
    } else {
      const data = await dataManager.loadQuestions(subject, year);
      if (!data) return false;
      for (const q of data.questions) allQuestions.push({ ...q, year });
    }

    if (allQuestions.length === 0) return false;

    // Fisher-Yates shuffle — avoids sort(() => 0.5 - Math.random()) bias
    for (let i = allQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allQuestions[i], allQuestions[j]] = [allQuestions[j], allQuestions[i]];
    }
    if (allQuestions.length > chatCfg.maxQuestionsPerQuiz) {
      allQuestions.length = chatCfg.maxQuestionsPerQuiz;
    }

    state.isActive = true;
    state.subject = subject;
    state.year = year.toLowerCase();
    state.paperType = "STANDARD";
    state.questions = allQuestions;
    state.currentQuestionIndex = 0;
    state.scoreBoard = {};
    state.currentRespondents = {};
    state.currentAnswers = {};
    state.startTime = Date.now();
    state.lastQuestionMsgId = null;
    state.questionSentAt = null;
    state._endingQuestion = false;

    logger.success(`Quiz started in ${chatId}: ${subject} ${year} (${allQuestions.length} questions)`);
    return true;
  },

  stop(chatId) {
    const state = activeQuizzes.get(chatId);
    if (!state) return false;

    // Clear both timer types for safety
    if (state._questionTimer) {
      clearTimeout(state._questionTimer);
      state._questionTimer = null;
    }
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }

    const wasActive = state.isActive;
    activeQuizzes.set(chatId, createFreshState(chatId));
    if (wasActive) logger.info(`Quiz stopped in ${chatId}`);
    return wasActive;
  },

  // ── recordAnswer ──────────────────────────────────────────────────
  // Stores the latest choice only — scoring deferred to commitAnswers.
  recordAnswer(state, userId, userName, answerLetter) {
    if (!state.isActive) return false;
    const isFirst = !state.currentAnswers[userId];
    state.currentAnswers[userId] = { letter: answerLetter, name: userName };
    return isFirst;
  },

  // ── commitAnswers ─────────────────────────────────────────────────
  commitAnswers(state) {
    if (!state.currentAnswers) return;
    for (const [userId, { letter, name }] of Object.entries(state.currentAnswers)) {
      const answerIndex = utils.letterToIndex(letter);
      const isCorrect = this.checkAnswer(state, answerIndex);
      const entry = state.scoreBoard[userId];
      if (entry) {
        if (isCorrect) { entry.score++; entry.correct++; }
        else { entry.wrong++; }
      } else {
        state.scoreBoard[userId] = {
          name,
          score: isCorrect ? 1 : 0,
          correct: isCorrect ? 1 : 0,
          wrong: isCorrect ? 0 : 1,
        };
      }
      state.currentRespondents[userId] = { name, isCorrect };
    }
    state.currentAnswers = {};
  },

  // Backward-compat alias
  updateScore(state, userId, userName, answerLetter) {
    return this.recordAnswer(state, userId, userName, answerLetter);
  },

  getStats(state) {
    const duration = state.startTime ? Date.now() - state.startTime : 0;
    return {
      duration: utils.formatDuration(duration),
      totalQuestions: state.questions.length,
      completedQuestions: state.currentQuestionIndex,
      remainingQuestions: state.questions.length - state.currentQuestionIndex,
      participants: Object.keys(state.scoreBoard).length,
      isActive: state.isActive,
    };
  },
};

module.exports = quizManager;