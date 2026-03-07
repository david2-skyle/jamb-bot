// ==========================================
// 🎮 PER-CHAT QUIZ STATE
// ==========================================
const activeQuizzes = new Map();

function createFreshState(chatId) {
  return {
    isActive: false,
    subject: null,
    year: null,
    paperType: null,
    questions: [],
    currentQuestionIndex: 0,
    scoreBoard: {},
    currentRespondents: {},
    // Tracks each user's LATEST answer this round (letter → scored at question end)
    currentAnswers: {},
    chatId,
    startTime: null,
    interval: null,
    lastQuestionMsgId: null,
    questionSentAt: null,
    // Pause/resume support: quiz pauses instead of stopping on send errors
    isPaused: false,
    pausedAt: null,
  };
}

function getOrCreateState(chatId) {
  if (!activeQuizzes.has(chatId)) {
    activeQuizzes.set(chatId, createFreshState(chatId));
  }
  return activeQuizzes.get(chatId);
}

module.exports = { activeQuizzes, createFreshState, getOrCreateState };
