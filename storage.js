/**
 * storage.js — JAMB Quiz Bot v3.3.1
 *
 * Upstash Redis backend replacing file-based storage.
 * Data persists across Railway restarts/redeploys with no disk needed.
 *
 * Setup:
 *   1. Go to https://console.upstash.com → Create Database
 *      - Type: Redis
 *      - Region: pick closest to your Railway region
 *      - Eviction: OFF (so data never gets deleted)
 *   2. After creation, open the database → "REST API" tab
 *   3. Copy UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 *   4. Add both to Railway environment variables:
 *        UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
 *        UPSTASH_REDIS_REST_TOKEN=AXXXxxxxx...
 *
 * No npm install needed — uses Node's built-in https module only.
 */

const https = require("https");
const CONFIG = require("./config");
const logger = require("./logger");

// ── Upstash Redis REST client ─────────────────────────────────────
const redis = {
  _url: null,
  _token: null,

  init() {
    this._url = process.env.UPSTASH_REDIS_REST_URL;
    this._token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!this._url || !this._token) {
      throw new Error(
        "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN env vars",
      );
    }
  },

  // Execute any Redis command e.g. cmd("SET","key","value") or cmd("GET","key")
  async cmd(...args) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(args);
      const url = new URL(this._url);

      const options = {
        hostname: url.hostname,
        path: "/",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(json.error));
            resolve(json.result);
          } catch (e) {
            reject(new Error("Redis parse error: " + e.message));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(8000, () => {
        req.destroy();
        reject(new Error("Redis request timed out"));
      });
      req.write(body);
      req.end();
    });
  },

  async get(key) {
    const val = await this.cmd("GET", key);
    if (!val) return null;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  },

  async set(key, value) {
    return this.cmd("SET", key, JSON.stringify(value));
  },
};

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
    aiUsers: {},
    disabledChats: [],
    welcomeMessages: {},
    quizHistory: {},
  },
  quizConfig: {},
  globalState: { disabled: false },

  // ── Load all data from Redis ──────────────────────────────────────
  async load() {
    try {
      redis.init();
      logger.success("Upstash Redis connected");

      // ── Permissions ──────────────────────────────────────────────
      try {
        const loaded = await redis.get("bot:permissions");
        if (loaded) {
          this.permissions = {
            botAdmins: loaded.botAdmins || {},
            moderators: loaded.moderators || {},
            aiUsers: loaded.aiUsers || {},
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
        } else {
          logger.info("No permissions in Redis yet, starting fresh");
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
      } catch (e) {
        logger.error("Failed to load permissions from Redis:", e.message);
      }

      // ── Quiz config ──────────────────────────────────────────────
      try {
        const loaded = await redis.get("bot:quizConfig");
        if (loaded) {
          this.quizConfig = loaded;
          logger.success(
            `Loaded quiz config for ${Object.keys(this.quizConfig).length} chat(s)`,
          );
        } else {
          this.quizConfig = {};
          await this._writeQuizConfig();
        }
      } catch (e) {
        logger.error("Failed to load quiz config from Redis:", e.message);
        this.quizConfig = {};
      }

      // ── Global state ─────────────────────────────────────────────
      try {
        const loaded = await redis.get("bot:globalState");
        if (loaded) {
          this.globalState = { disabled: false, ...loaded };
          if (this.globalState.disabled)
            logger.warn("⚠️  Bot is GLOBALLY DISABLED");
        } else {
          this.globalState = { disabled: false };
          await this.saveGlobalState();
        }
      } catch (e) {
        logger.error("Failed to load global state from Redis:", e.message);
        this.globalState = { disabled: false };
      }

      // Bind debounced savers after loading
      this.savePermissions = debounce(this._writePermissions.bind(this), 500);
      this.saveQuizConfig = debounce(this._writeQuizConfig.bind(this), 500);
    } catch (error) {
      logger.error("Error loading storage:", error.message);
      throw error;
    }
  },

  // ── Writers ───────────────────────────────────────────────────────
  async _writePermissions() {
    try {
      await redis.set("bot:permissions", this.permissions);
    } catch (e) {
      logger.error("Error saving permissions to Redis:", e.message);
    }
  },

  async _writeQuizConfig() {
    try {
      await redis.set("bot:quizConfig", this.quizConfig);
    } catch (e) {
      logger.error("Error saving quiz config to Redis:", e.message);
    }
  },

  async saveGlobalState() {
    try {
      await redis.set("bot:globalState", this.globalState);
    } catch (e) {
      logger.error("Error saving global state to Redis:", e.message);
    }
  },

  // Debounced stubs — replaced after load()
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
