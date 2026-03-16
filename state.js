/**
 * state.js — v3.4.0
 *
 * Changes:
 * - _questionTimer: replaces the old interval handle. A single setTimeout
 *   per question fires processQuestionEnd — no 1-second polling loop.
 * - _endingQuestion: per-state flag replaces module-level Set, cutting one
 *   Set.has() lookup per processQuestionEnd call.
 * - interval field kept as null for backward compatibility with any
 *   third-party code that checks it, but it is no longer used internally.
 */

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
    currentAnswers: {},
    chatId,
    startTime: null,
    // Legacy — kept for compatibility; not used by the new scheduler
    interval: null,
    // New: single-shot question timer handle
    _questionTimer: null,
    // Guard against re-entrant processQuestionEnd
    _endingQuestion: false,
    lastQuestionMsgId: null,
    questionSentAt: null,
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