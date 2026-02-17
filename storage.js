const fs = require("fs").promises;
const CONFIG = require("./config");
const logger = require("./logger");

// ==========================================
// 🗄️ PERSISTENT STORAGE
// ==========================================
// permissions.json structure:
// {
//   botAdmins:       { "chatId": ["userId", ...] },
//   moderators:      { "chatId": ["userId", ...] },
//   disabledChats:   ["chatId", ...],
//   welcomeMessages: { "chatId": "text" },
//   quizHistory:     { "chatId": [{ subject, year, date, participants, winner, score }] }
// }
// global_state.json:
// { disabled: false }

const storage = {
  permissions: {
    botAdmins: {},
    moderators: {},
    disabledChats: [],
    welcomeMessages: {},
    quizHistory: {},
  },
  quizConfig: {},
  globalState: { disabled: false },

  get globalStateFile() {
    return CONFIG.data.dataDirectory + "/global_state.json";
  },

  // ── Load all data ─────────────────────────────────────────────────
  async load() {
    try {
      await fs.mkdir(CONFIG.data.dataDirectory, { recursive: true });

      // Permissions
      try {
        const raw = await fs.readFile(CONFIG.data.permissionsFile, "utf-8");
        const loaded = JSON.parse(raw);
        // Migration from old formats
        this.permissions = {
          botAdmins: loaded.botAdmins || {},
          moderators: loaded.moderators || {},
          disabledChats: Array.isArray(loaded.disabledChats)
            ? loaded.disabledChats
            : [],
          welcomeMessages: loaded.welcomeMessages || {},
          quizHistory: loaded.quizHistory || {},
        };
        const adminCount = Object.values(this.permissions.botAdmins).flat()
          .length;
        const modCount = Object.values(this.permissions.moderators).flat()
          .length;
        logger.success(
          `Loaded permissions: ${adminCount} admin(s), ${modCount} mod(s)`,
        );
      } catch {
        logger.info("No permissions file, starting fresh");
        this.permissions = {
          botAdmins: {},
          moderators: {},
          disabledChats: [],
          welcomeMessages: {},
          quizHistory: {},
        };
        await this.savePermissions();
      }

      // Quiz config
      try {
        const raw = await fs.readFile(CONFIG.data.configFile, "utf-8");
        this.quizConfig = JSON.parse(raw);
        logger.success(
          `Loaded quiz config for ${Object.keys(this.quizConfig).length} chat(s)`,
        );
      } catch {
        this.quizConfig = {};
        await this.saveQuizConfig();
      }

      // Global state
      try {
        const raw = await fs.readFile(this.globalStateFile, "utf-8");
        this.globalState = { disabled: false, ...JSON.parse(raw) };
        if (this.globalState.disabled)
          logger.warn("⚠️  Bot is GLOBALLY DISABLED");
      } catch {
        this.globalState = { disabled: false };
        await this.saveGlobalState();
      }
    } catch (error) {
      logger.error("Error loading storage:", error.message);
    }
  },

  async savePermissions() {
    try {
      await fs.writeFile(
        CONFIG.data.permissionsFile,
        JSON.stringify(this.permissions, null, 2),
        "utf-8",
      );
    } catch (e) {
      logger.error("Error saving permissions:", e.message);
    }
  },

  async saveQuizConfig() {
    try {
      await fs.writeFile(
        CONFIG.data.configFile,
        JSON.stringify(this.quizConfig, null, 2),
        "utf-8",
      );
    } catch (e) {
      logger.error("Error saving quiz config:", e.message);
    }
  },

  async saveGlobalState() {
    try {
      await fs.writeFile(
        this.globalStateFile,
        JSON.stringify(this.globalState, null, 2),
        "utf-8",
      );
    } catch (e) {
      logger.error("Error saving global state:", e.message);
    }
  },

  // ── Global disable ────────────────────────────────────────────────
  isGloballyDisabled() {
    return this.globalState.disabled === true;
  },
  async setGlobalDisabled(value) {
    this.globalState.disabled = value;
    await this.saveGlobalState();
  },

  // ── Per-chat disable ──────────────────────────────────────────────
  isChatDisabled(chatId) {
    return this.permissions.disabledChats.includes(chatId);
  },
  async disableChat(chatId) {
    if (!this.permissions.disabledChats.includes(chatId)) {
      this.permissions.disabledChats.push(chatId);
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async enableChat(chatId) {
    const before = this.permissions.disabledChats.length;
    this.permissions.disabledChats = this.permissions.disabledChats.filter(
      (id) => id !== chatId,
    );
    if (this.permissions.disabledChats.length < before) {
      await this.savePermissions();
      return true;
    }
    return false;
  },

  // ── Bot Admins (per-chat) ─────────────────────────────────────────
  getBotAdmins(chatId) {
    return this.permissions.botAdmins[chatId] || [];
  },
  async addBotAdmin(chatId, userId) {
    if (!this.permissions.botAdmins[chatId])
      this.permissions.botAdmins[chatId] = [];
    if (!this.permissions.botAdmins[chatId].includes(userId)) {
      this.permissions.botAdmins[chatId].push(userId);
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async removeBotAdmin(chatId, userId) {
    if (!this.permissions.botAdmins[chatId]) return false;
    const before = this.permissions.botAdmins[chatId].length;
    this.permissions.botAdmins[chatId] = this.permissions.botAdmins[
      chatId
    ].filter((id) => id !== userId);
    if (this.permissions.botAdmins[chatId].length < before) {
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async clearBotAdmins(chatId) {
    this.permissions.botAdmins[chatId] = [];
    await this.savePermissions();
  },

  // ── Moderators (per-chat) ─────────────────────────────────────────
  getModerators(chatId) {
    return this.permissions.moderators[chatId] || [];
  },
  async addModerator(chatId, userId) {
    if (!this.permissions.moderators[chatId])
      this.permissions.moderators[chatId] = [];
    if (!this.permissions.moderators[chatId].includes(userId)) {
      this.permissions.moderators[chatId].push(userId);
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async removeModerator(chatId, userId) {
    if (!this.permissions.moderators[chatId]) return false;
    const before = this.permissions.moderators[chatId].length;
    this.permissions.moderators[chatId] = this.permissions.moderators[
      chatId
    ].filter((id) => id !== userId);
    if (this.permissions.moderators[chatId].length < before) {
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async clearModerators(chatId) {
    this.permissions.moderators[chatId] = [];
    await this.savePermissions();
  },

  // ── Welcome messages (per-chat) ───────────────────────────────────
  getWelcomeMessage(chatId) {
    return this.permissions.welcomeMessages[chatId] || null;
  },
  async setWelcomeMessage(chatId, message) {
    this.permissions.welcomeMessages[chatId] = message;
    await this.savePermissions();
  },
  async clearWelcomeMessage(chatId) {
    delete this.permissions.welcomeMessages[chatId];
    await this.savePermissions();
  },

  // ── Quiz history (per-chat) ───────────────────────────────────────
  getQuizHistory(chatId) {
    return this.permissions.quizHistory[chatId] || [];
  },
  async addQuizHistory(chatId, entry) {
    if (!this.permissions.quizHistory[chatId])
      this.permissions.quizHistory[chatId] = [];
    this.permissions.quizHistory[chatId].unshift(entry); // newest first
    // keep last 20 per chat
    if (this.permissions.quizHistory[chatId].length > 20) {
      this.permissions.quizHistory[chatId] = this.permissions.quizHistory[
        chatId
      ].slice(0, 20);
    }
    await this.savePermissions();
  },

  // ── Quiz config (per-chat) ────────────────────────────────────────
  getQuizConfig(chatId) {
    const o = this.quizConfig[chatId] || {};
    return {
      questionInterval: o.questionInterval ?? CONFIG.quiz.questionInterval,
      maxQuestionsPerQuiz:
        o.maxQuestionsPerQuiz ?? CONFIG.quiz.maxQuestionsPerQuiz,
      delayBeforeFirstQuestion:
        o.delayBeforeFirstQuestion ?? CONFIG.quiz.delayBeforeFirstQuestion,
      delayBeforeNextQuestion:
        o.delayBeforeNextQuestion ?? CONFIG.quiz.delayBeforeNextQuestion,
    };
  },
  async resetQuizConfig(chatId) {
    delete this.quizConfig[chatId];
    await this.saveQuizConfig();
  },
};

module.exports = storage;
