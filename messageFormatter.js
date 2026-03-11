/**
 * messageFormatter.js — v3.4.0
 */

const CONFIG = require("./config");
const utils = require("./utils");
const storage = require("./storage");
const permissions = require("./permissions");

const messageFormatter = {
  formatQuestion(question, index) {
    const optionsText = question.options
      .map((opt, i) => `${utils.indexToLetter(i)}. ${opt}`)
      .join("\n");
    // For AI-generated questions the "year" field is "AI" — show nothing.
    // For normal questions it's a 4-digit year — show it.
    const yearTag =
      question.year && question.year !== "AI"
        ? `\n📅 Year: ${question.year}`
        : "";
    return `*Question ${index + 1}*\n\n${question.question}\n\n${optionsText}${yearTag}`;
  },

  async formatScoreboard(state, showPosition = true) {
    if (Object.keys(state.scoreBoard).length === 0) return "No scores yet.";
    const { emojis } = CONFIG.messages;
    const sorted = Object.entries(state.scoreBoard).sort(
      (a, b) => b[1].score - a[1].score,
    );
    const lines = await Promise.all(
      sorted.map(async ([userId, data], idx) => {
        const info = await utils.getUserDisplayInfo(userId, data.name);
        const medal =
          idx === 0
            ? emojis.medal.first
            : idx === 1
              ? emojis.medal.second
              : idx === 2
                ? emojis.medal.third
                : "  ";
        const pos = showPosition ? `${idx + 1}. ` : "";
        return `${medal} ${pos}${info.name}: ${data.score} ${utils.pluralize(data.score, "pt")} (${data.correct}✅ ${data.wrong}❌)`;
      }),
    );
    return lines.join("\n");
  },

  async formatHelp(chatId, msg = null) {
    const { prefix } = CONFIG.bot;
    const { emojis } = CONFIG.messages;
    const cfg = storage.getQuizConfig(chatId);
    const disabled = storage.isChatDisabled(chatId);
    const globalDisabled = storage.isGloballyDisabled();
    const aiEnabled = !!CONFIG.ai.apiKey;

    const isOwner = msg ? permissions.isOwner(msg) : false;
    const isBotAdmin = msg ? await permissions.isBotAdmin(msg) : false;
    const isMod = msg ? await permissions.isModerator(msg) : false;
    const canAi = msg ? await permissions.canUseAi(msg) : false;

    let text =
      `*${emojis.book} ${CONFIG.bot.name} v${CONFIG.bot.version}*\n` +
      `🌐 Global: ${globalDisabled ? "Disabled 🔴" : "Active 🟢"} | ` +
      `🔌 Chat: ${disabled ? "Disabled 🔴" : "Active 🟢"} | ` +
      `${emojis.ai} AI: ${aiEnabled ? "On 🟢" : "Off 🔴"}\n\n`;

    // General — everyone
    text +=
      `*General Commands:*\n` +
      `• *${prefix}ping* – Check bot status\n` +
      `• *${prefix}help* – Show this message\n` +
      `• *${prefix}myrole* – Your role in this chat\n` +
      `• *${prefix}subjects* – List subjects\n` +
      `• *${prefix}years [subject]* – List years\n` +
      `• *${prefix}question [subject] [year]* – Practice question\n` +
      `• *${prefix}score* – Current scoreboard\n` +
      `• *${prefix}stats* – Quiz statistics\n`;

    // AI chat — only shown if user has access
    if (aiEnabled && CONFIG.ai.features.aiChat && canAi) {
      text +=
        `\n*🤖 AI Commands:*\n` +
        `• *${prefix}ai [question]* – Ask the AI tutor anything\n`;
    } else if (aiEnabled && !canAi) {
      text += `\n_💡 AI chat is available — ask an admin to grant you access with ${prefix}aiuser add_\n`;
    }

    text += "\n";

    if (isMod) {
      text +=
        `*Quiz Commands (⭐ Moderator+):*\n` +
        `• *${prefix}start [subject] [year]* – Start quiz (use \`all\` for mixed years)\n` +
        `• *${prefix}stop* – Stop quiz\n` +
        `• *${prefix}setinterval [sec]* – Time per question (5–300s)\n` +
        `• *${prefix}setdelay [sec]* – Delay before next question (1–60s)\n` +
        `• *${prefix}setmax [num]* – Max questions per quiz (1–200)\n` +
        `• *${prefix}chatconfig* – Show this chat's config\n`;

      if (aiEnabled && CONFIG.ai.features.generateQuestions) {
        text +=
          `• *${prefix}genq [subject] [topic] [count]* – 🤖 Generate & start an AI quiz\n` +
          `  _e.g. ${prefix}genq biology photosynthesis 5_\n`;
      }

      text += "\n";
    }

    if (isBotAdmin) {
      text +=
        `*Bot Admin Commands (🛡️ Bot Admin+):*\n` +
        `• *${prefix}enable / ${prefix}disable* – Enable or disable bot in this chat\n` +
        `• *${prefix}admin add/remove/list @user* – Manage Bot Admins\n` +
        `• *${prefix}mod add/remove/list @user* – Manage Moderators\n` +
        `• *${prefix}aiuser add/remove/list @user* – Manage AI access 🤖\n` +
        `• *${prefix}announce [msg]* – Send announcement to this chat\n` +
        `• *${prefix}setwelcome [msg]* – Message sent when quiz starts\n` +
        `• *${prefix}clearwelcome* – Remove welcome message\n` +
        `• *${prefix}resetconfig* – Reset quiz settings to defaults\n` +
        `• *${prefix}quizhistory* – View past quiz results\n\n`;
    }

    if (isOwner) {
      text +=
        `*Owner Commands (👑 Owner only):*\n` +
        `• *${prefix}genable* – Globally enable bot (all chats)\n` +
        `• *${prefix}gdisable* – Globally disable bot (all chats)\n` +
        `• *${prefix}broadcast [msg]* – Send message to all active chats\n` +
        `• *${prefix}chats* – Overview of all active & disabled chats\n` +
        `• *${prefix}allstaff* – View all admins & mods across all chats\n` +
        `• *${prefix}clearstaff* – Remove all admins & mods in this chat\n\n`;
    }

    text +=
      `*How to Answer:*\n` +
      `Just send *A*, *B*, *C*, or *D* — no need to reply to the question!\n` +
      `You can change your answer any time before the timer runs out.\n\n` +
      `*This Chat's Settings:*\n` +
      `${emojis.timer} Question time: ${utils.formatSeconds(cfg.questionInterval)}\n` +
      `⏳ Next Q delay: ${utils.formatSeconds(cfg.delayBeforeNextQuestion)}\n` +
      `📋 Max Questions: ${cfg.maxQuestionsPerQuiz}`;

    return text;
  },
};

module.exports = messageFormatter;
