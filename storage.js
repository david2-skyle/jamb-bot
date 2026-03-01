/**
 * storage.js — JAMB Quiz Bot v3.2.0
 *
 * Multi-group optimization: permission saves are debounced.
 * Under load (many groups answering simultaneously), multiple
 * savePermissions() calls within DEBOUNCE_MS are coalesced into
 * one single disk write, preventing I/O thrash.
 */

const fs = require("fs").promises;
const CONFIG = require("./config");
const logger = require("./logger");

// ── Debounce helper ───────────────────────────────────────────────
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delay);
  };
}

// ── Storage ───────────────────────────────────────────────────────
const storage = {
  permissions: {
    botAdmins: {},
    moderators: {},
    aiUsers: {}, // NEW: per-chat list of users allowed to use AI
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
        this.permissions = {
          botAdmins: loaded.botAdmins || {},
          moderators: loaded.moderators || {},
          aiUsers: loaded.aiUsers || {}, // NEW
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
        const aiCount = Object.values(this.permissions.aiUsers).flat().length;
        logger.success(
          `Loaded permissions: ${adminCount} admin(s), ${modCount} mod(s), ${aiCount} AI user(s)`,
        );
      } catch {
        logger.info("No permissions file, starting fresh");
        this.permissions = {
          botAdmins: {},
          moderators: {},
          aiUsers: {},
          disabledChats: [],
          welcomeMessages: {},
          quizHistory: {},
        };
        await this._writePermissions();
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
        await this._writeQuizConfig();
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

      // Bind debounced savers
      this.savePermissions = debounce(this._writePermissions.bind(this), 300);
      this.saveQuizConfig = debounce(this._writeQuizConfig.bind(this), 300);
    } catch (error) {
      logger.error("Error loading storage:", error.message);
    }
  },

  // ── Internal (immediate) writers ─────────────────────────────────
  async _writePermissions() {
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

  async _writeQuizConfig() {
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

  // Debounced stubs (replaced after load())
  savePermissions() {
    return this._writePermissions();
  },
  saveQuizConfig() {
    return this._writeQuizConfig();
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

  // ── Bot Admins ────────────────────────────────────────────────────
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

  // ── Moderators ────────────────────────────────────────────────────
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

  // ── AI Users ──────────────────────────────────────────────────────
  // Bot Admins and above always have access — this list is for
  // explicit per-chat grants given to mods / regular members.
  getAiUsers(chatId) {
    return this.permissions.aiUsers[chatId] || [];
  },
  async addAiUser(chatId, userId) {
    if (!this.permissions.aiUsers[chatId])
      this.permissions.aiUsers[chatId] = [];
    if (!this.permissions.aiUsers[chatId].includes(userId)) {
      this.permissions.aiUsers[chatId].push(userId);
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async removeAiUser(chatId, userId) {
    if (!this.permissions.aiUsers[chatId]) return false;
    const before = this.permissions.aiUsers[chatId].length;
    this.permissions.aiUsers[chatId] = this.permissions.aiUsers[chatId].filter(
      (id) => id !== userId,
    );
    if (this.permissions.aiUsers[chatId].length < before) {
      await this.savePermissions();
      return true;
    }
    return false;
  },
  async clearAiUsers(chatId) {
    this.permissions.aiUsers[chatId] = [];
    await this.savePermissions();
  },

  // ── Welcome messages ──────────────────────────────────────────────
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

  // ── Quiz history ──────────────────────────────────────────────────
  getQuizHistory(chatId) {
    return this.permissions.quizHistory[chatId] || [];
  },
  async addQuizHistory(chatId, entry) {
    if (!this.permissions.quizHistory[chatId]) {
      this.permissions.quizHistory[chatId] = [];
    }
    this.permissions.quizHistory[chatId].unshift(entry);
    if (this.permissions.quizHistory[chatId].length > 20) {
      this.permissions.quizHistory[chatId] = this.permissions.quizHistory[
        chatId
      ].slice(0, 20);
    }
    await this.savePermissions();
  },

  // ── Quiz config ───────────────────────────────────────────────────
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
