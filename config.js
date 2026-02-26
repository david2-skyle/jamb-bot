
// ==========================================
// 🔧 GLOBAL CONFIGURATION — v3.0.0
// ==========================================
const CONFIG = {
  bot: {
    name: "JAMB Quiz Bot",
    version: "3.0.0",
    prefix: ".",
    owners: ["249250474627313@lid", "222917996585169@lid"], // Level 1 - universal across all chats
  },

  quiz: {
    questionInterval: 60000,
    delayBeforeFirstQuestion: 1000,
    delayBeforeResults: 2000,
    delayBeforeNextQuestion: 10000,
    allowedAnswers: ["A", "B", "C", "D"],
    maxQuestionsPerQuiz: 50,
  },

  // ── NEW in V3: AI configuration ───────────────────────────────────
  ai: {
    // Get free API key at https://console.x.ai/
    apiKey: process.env.XAI_API_KEY,
    model: "grok-4-fast-reasoning",
    maxTokens: 500,
    temperature: 0.5,
    timeoutMs: 15000,

    // Feature flags — set to false to disable without removing code
    features: {
      answerExplanation: true, // AI explains answers after each question
      generateQuestions: true, // .genq command for admins
      aiChat: true, // .ai command for free chat
      dailyQuestion: true, // scheduled daily practice question
    },
  },

  data: {
    dataDirectory: "./data",
    permissionsFile: "./data/permissions.json",
    configFile: "./data/quiz_config.json",
    subjects: ["chemistry", "physics", "biology"],
    years: [
      "2010",
      "2011",
      "2012",
      "2013",
      "2014",
      "2015",
      "2016",
      "2017",
      "2018",
    ],
  },

  client: {
    chromePath:
      process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: true,
  },

  // ── NEW in V3: Daily question config ──────────────────────────────
  daily: {
    // Hour in 24h format (WAT = UTC+1). 8 = 8am WAT
    hour: 8,
    // Chats that receive daily questions (populated at runtime via .daily command)
    // Stored in data/daily_chats.json
  },

  messages: {
    emojis: {
      success: "✅",
      error: "❌",
      warning: "⚠️",
      info: "ℹ️",
      question: "❓",
      timer: "⏰",
      trophy: "🏆",
      medal: { first: "🥇", second: "🥈", third: "🥉" },
      celebrate: "🎉",
      book: "📚",
      rocket: "🚀",
      stop: "🛑",
      chart: "📊",
      gear: "⚙️",
      crown: "👑",
      shield: "🛡️",
      star: "⭐",
      ai: "🤖", // NEW
      daily: "📅", // NEW
    },
  },

  logging: {
    enabled: true,
    verbose: process.env.NODE_ENV !== "production",
  },
};

module.exports = CONFIG;
