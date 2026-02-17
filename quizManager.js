const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const dataManager = require("./dataManager");
const {
  activeQuizzes,
  getOrCreateState,
  createFreshState,
} = require("./state");

// ==========================================
// 🎯 QUIZ MANAGER (per-chat)
// ==========================================
const quizManager = {
  getCurrentQuestion(state) {
    if (!state.isActive || state.currentQuestionIndex >= state.questions.length)
      return null;
    return state.questions[state.currentQuestionIndex];
  },

  getCurrentAnswerLetter(state) {
    const q = this.getCurrentQuestion(state);
    return q ? utils.indexToLetter(q.answer_index) : null;
  },

  getCurrentQuestionExplanation(state) {
    const q = this.getCurrentQuestion(state);
    return q && q.explanation
      ? `💡 Explanation: ${q.explanation}`
      : "No Explanation Available";
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
        if (data)
          allQuestions.push(...data.questions.map((q) => ({ ...q, year: y })));
      }
    } else {
      const data = await dataManager.loadQuestions(subject, year);
      if (!data) return false;
      allQuestions = data.questions.map((q) => ({ ...q, year }));
    }

    if (allQuestions.length === 0) return false;

    allQuestions = allQuestions
      .sort(() => 0.5 - Math.random())
      .slice(0, chatCfg.maxQuestionsPerQuiz);

    state.isActive = true;
    state.subject = subject;
    state.year = year.toLowerCase();
    state.paperType = "STANDARD";
    state.questions = allQuestions;
    state.currentQuestionIndex = 0;
    state.scoreBoard = {};
    state.currentRespondents = {};
    state.startTime = Date.now();
    state.lastQuestionMsgId = null;
    state.questionSentAt = null;

    logger.success(
      `Quiz started in ${chatId}: ${subject} ${year} (${allQuestions.length} questions)`,
    );
    return true;
  },

  stop(chatId) {
    const state = activeQuizzes.get(chatId);
    if (!state) return false;
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
    const wasActive = state.isActive;
    activeQuizzes.set(chatId, createFreshState(chatId));
    if (wasActive) logger.info(`Quiz stopped in ${chatId}`);
    return wasActive;
  },

  updateScore(state, userId, userName, answerLetter) {
    if (!state.isActive) return false;
    const answerIndex = utils.letterToIndex(answerLetter);
    const isCorrect = this.checkAnswer(state, answerIndex);

    if (!state.scoreBoard[userId]) {
      state.scoreBoard[userId] = {
        name: userName,
        score: 0,
        correct: 0,
        wrong: 0,
      };
    }
    if (isCorrect) {
      state.scoreBoard[userId].score++;
      state.scoreBoard[userId].correct++;
    } else {
      state.scoreBoard[userId].wrong++;
    }

    state.currentRespondents[userId] = { name: userName, isCorrect };
    logger.debug(
      `${userName} → ${answerLetter}: ${isCorrect ? "✓" : "✗"} [${state.chatId}]`,
    );
    return isCorrect;
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
