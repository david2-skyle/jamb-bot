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
    chatId,
    startTime: null,
    interval: null,
    lastQuestionMsgId: null,
    questionSentAt: null,
  };
}

function getOrCreateState(chatId) {
  if (!activeQuizzes.has(chatId)) {
    activeQuizzes.set(chatId, createFreshState(chatId));
  }
  return activeQuizzes.get(chatId);
}

module.exports = { activeQuizzes, createFreshState, getOrCreateState };
