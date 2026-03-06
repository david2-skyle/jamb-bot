// ==========================================
// 🔧 GLOBAL CONFIGURATION — v3.2.0
// ==========================================
const CONFIG = {
  bot: {
    name: "JAMB Quiz Bot",
    version: "3.2.0",
    prefix: ".",
    owners: ["249250474627313@lid", "222917996585169@lid"],
  },

  quiz: {
    questionInterval: 60000,
    delayBeforeFirstQuestion: 1000,
    delayBeforeResults: 2000,
    delayBeforeNextQuestion: 10000,
    allowedAnswers: ["A", "B", "C", "D"],
    maxQuestionsPerQuiz: 50,
  },

  ai: {
    // Get a FREE API key at: https://console.groq.com
    // Free tier: ~14,400 requests/day, 30 req/min — no credit card needed
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile", // fast & free; swap to "llama-3.1-8b-instant" for faster/lighter responses
    maxTokens: 500,
    temperature: 0.5,
    timeoutMs: 15000,

    features: {
      answerExplanation: true, // AI explains answers after each question
      generateQuestions: true, // .genq command for admins
      aiChat: true, // .ai command for free chat
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
      ai: "🤖",
    },
  },

  logging: {
    enabled: true,
    verbose: process.env.NODE_ENV !== "production",
  },
};

module.exports = CONFIG;
