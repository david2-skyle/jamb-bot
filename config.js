// ==========================================
// 🔧 GLOBAL CONFIGURATION
// ==========================================
const CONFIG = {
  bot: {
    name: "JAMB Quiz Bot",
    version: "2.1.0",
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

  data: {
    dataDirectory: "./data",
    permissionsFile: "./data/permissions.json",
    configFile: "./data/quiz_config.json",
    subjects: ["chemistry"],
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
    // Uses env var on Railway, falls back to local Chrome path for development
    chromePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
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
    },
  },

  logging: {
    enabled: true,
    verbose: process.env.NODE_ENV !== "production",
  },
};

module.exports = CONFIG;
