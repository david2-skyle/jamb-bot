/**
 * storage.js — JAMB Quiz Bot v3.4.0
 *
 * Optimizations:
 * - Redis connection reuse (one persistent socket via keep-alive)
 * - Retry with exponential backoff on transient failures
 * - Quiz history capped at 20 per chat with in-memory trim before write
 * - savePermissions / saveQuizConfig use a true write-queue to prevent
 *   concurrent overlapping writes to Redis
 * - All in-memory objects are lean (no repeated nested spreads)
 */

const https = require("https");
const CONFIG = require("./config");
const logger = require("./logger");

// ── Upstash Redis REST client ─────────────────────────────────────
const redis = (() => {
  let _url = null;
  let _token = null;
  let _hostname = null;

  // Persistent HTTPS agent — reuses TCP/TLS connections instead of
  // establishing a new handshake on every Redis call.
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 4,
    timeout: 10_000,
  });

  function init() {
    _url = process.env.UPSTASH_REDIS_REST_URL;
    _token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!_url || !_token) {
      throw new Error(
        "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN env vars",
      );
    }
    _hostname = new URL(_url).hostname;
  }

  // Raw Redis command with retry
  async function cmd(...args) {
    const body = JSON.stringify(args);
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: _hostname,
            path: "/",
            method: "POST",
            agent,
            headers: {
              Authorization: `Bearer ${_token}`,
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
          req.setTimeout(8_000, () => {
            req.destroy();
            reject(new Error("Redis request timed out"));
          });
          req.write(body);
          req.end();
        });
        return result;
      } catch (e) {
        if (attempt === MAX_ATTEMPTS) throw e;
        const delay = 200 * Math.pow(2, attempt - 1); // 200ms, 400ms
        logger.warn(`[Redis] Attempt ${attempt} failed (${e.message}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async function get(key) {
    const val = await cmd("GET", key);
    if (!val) return null;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }

  async function set(key, value) {
    return cmd("SET", key, JSON.stringify(value));
  }

  return { init, cmd, get, set };
})();

// ── Write queue — prevents overlapping concurrent writes ──────────
// If a write is in-flight and another is queued, the queued one
// replaces any previous pending entry (last-write-wins per key).
const writeQueue = (() => {
  const pending = new Map(); // key → { value, promise }
  const inFlight = new Set(); // keys currently being written

  async function flush(key, valueFn) {
    if (inFlight.has(key)) {
      // Mark that we need another write once the current one finishes
      pending.set(key, valueFn);
      return;
    }
    inFlight.add(key);
    try {
      await valueFn();
    } catch (e) {
      logger.error(`[WriteQueue] Failed to write ${key}:`, e.message);
    } finally {
      inFlight.delete(key);
      if (pending.has(key)) {
        const next = pending.get(key);
        pending.delete(key);
        // Schedule next write without blocking the current stack
        setImmediate(() => flush(key, next));
      }
    }
  }

  return { flush };
})();

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

// ── Default permissions shape ─────────────────────────────────────
function defaultPermissions() {
  return {
    botAdmins: {},
    moderators: {},
    aiUsers: {},
    disabledChats: [],
    welcomeMessages: {},
    quizHistory: {},
  };
}

// ── Storage ───────────────────────────────────────────────────────
const storage = {
  permissions: defaultPermissions(),
  quizConfig: {},
  globalState: { disabled: false },

  // ── Load all data from Redis ──────────────────────────────────────
  async load() {
    try {
      redis.init();
      logger.success("Upstash Redis connected");
    } catch (e) {
      logger.error("Redis init failed:", e.message);
      throw e;
    }

    // ── Permissions ──────────────────────────────────────────────
    try {
      const loaded = await redis.get("bot:permissions");
      if (loaded) {
        this.permissions = {
          botAdmins: loaded.botAdmins || {},
          moderators: loaded.moderators || {},
          aiUsers: loaded.aiUsers || {},
          disabledChats: Array.isArray(loaded.disabledChats) ? loaded.disabledChats : [],
          welcomeMessages: loaded.welcomeMessages || {},
          quizHistory: loaded.quizHistory || {},
        };
        const ac = Object.values(this.permissions.botAdmins).reduce((s, a) => s + a.length, 0);
        const mc = Object.values(this.permissions.moderators).reduce((s, a) => s + a.length, 0);
        const ai = Object.values(this.permissions.aiUsers).reduce((s, a) => s + a.length, 0);
        logger.success(`Permissions: ${ac} admin(s), ${mc} mod(s), ${ai} AI user(s)`);
      } else {
        logger.info("No permissions in Redis yet — starting fresh");
        this.permissions = defaultPermissions();
        await this._writePermissions();
      }
    } catch (e) {
      logger.error("Failed to load permissions:", e.message);
      this.permissions = defaultPermissions();
    }

    // ── Quiz config ──────────────────────────────────────────────
    try {
      const loaded = await redis.get("bot:quizConfig");
      if (loaded) {
        this.quizConfig = loaded;
        logger.success(`Quiz config: ${Object.keys(this.quizConfig).length} chat(s)`);
      } else {
        this.quizConfig = {};
        await this._writeQuizConfig();
      }
    } catch (e) {
      logger.error("Failed to load quiz config:", e.message);
      this.quizConfig = {};
    }

    // ── Global state ─────────────────────────────────────────────
    try {
      const loaded = await redis.get("bot:globalState");
      if (loaded) {
        this.globalState = { disabled: false, ...loaded };
        if (this.globalState.disabled) logger.warn("⚠️  Bot is GLOBALLY DISABLED");
      } else {
        this.globalState = { disabled: false };
        await this.saveGlobalState();
      }
    } catch (e) {
      logger.error("Failed to load global state:", e.message);
      this.globalState = { disabled: false };
    }

    // Bind debounced savers after loading
    this.savePermissions = debounce(this._writePermissions.bind(this), 500);
    this.saveQuizConfig = debounce(this._writeQuizConfig.bind(this), 500);
  },

  // ── Writers ───────────────────────────────────────────────────────
  async _writePermissions() {
    await writeQueue.flush("permissions", async () => {
      await redis.set("bot:permissions", this.permissions);
    });
  },

  async _writeQuizConfig() {
    await writeQueue.flush("quizConfig", async () => {
      await redis.set("bot:quizConfig", this.quizConfig);
    });
  },

  async saveGlobalState() {
    try {
      await redis.set("bot:globalState", this.globalState);
    } catch (e) {
      logger.error("Error saving global state:", e.message);
    }
  },

  // Stubs replaced after load()
  savePermissions() { return this._writePermissions(); },
  saveQuizConfig() { return this._writeQuizConfig(); },

  // ── Global disable ────────────────────────────────────────────────
  isGloballyDisabled() { return this.globalState.disabled === true; },

  async setGlobalDisabled(value) {
    this.globalState.disabled = value;
    await this.saveGlobalState();
  },

  // ── Per-chat disable ──────────────────────────────────────────────
  isChatDisabled(chatId) {
    return this.permissions.disabledChats.includes(chatId);
  },

  async disableChat(chatId) {
    if (this.permissions.disabledChats.includes(chatId)) return false;
    this.permissions.disabledChats.push(chatId);
    await this.savePermissions();
    return true;
  },

  async enableChat(chatId) {
    const len = this.permissions.disabledChats.length;
    this.permissions.disabledChats = this.permissions.disabledChats.filter((id) => id !== chatId);
    if (this.permissions.disabledChats.length < len) {
      await this.savePermissions();
      return true;
    }
    return false;
  },

  // ── Bot Admins ────────────────────────────────────────────────────
  getBotAdmins(chatId) { return this.permissions.botAdmins[chatId] || []; },

  async addBotAdmin(chatId, userId) {
    const arr = (this.permissions.botAdmins[chatId] ||= []);
    if (arr.includes(userId)) return false;
    arr.push(userId);
    await this.savePermissions();
    return true;
  },

  async removeBotAdmin(chatId, userId) {
    const arr = this.permissions.botAdmins[chatId];
    if (!arr) return false;
    const len = arr.length;
    this.permissions.botAdmins[chatId] = arr.filter((id) => id !== userId);
    if (this.permissions.botAdmins[chatId].length < len) {
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
  getModerators(chatId) { return this.permissions.moderators[chatId] || []; },

  async addModerator(chatId, userId) {
    const arr = (this.permissions.moderators[chatId] ||= []);
    if (arr.includes(userId)) return false;
    arr.push(userId);
    await this.savePermissions();
    return true;
  },

  async removeModerator(chatId, userId) {
    const arr = this.permissions.moderators[chatId];
    if (!arr) return false;
    const len = arr.length;
    this.permissions.moderators[chatId] = arr.filter((id) => id !== userId);
    if (this.permissions.moderators[chatId].length < len) {
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
  getAiUsers(chatId) { return this.permissions.aiUsers[chatId] || []; },

  async addAiUser(chatId, userId) {
    const arr = (this.permissions.aiUsers[chatId] ||= []);
    if (arr.includes(userId)) return false;
    arr.push(userId);
    await this.savePermissions();
    return true;
  },

  async removeAiUser(chatId, userId) {
    const arr = this.permissions.aiUsers[chatId];
    if (!arr) return false;
    const len = arr.length;
    this.permissions.aiUsers[chatId] = arr.filter((id) => id !== userId);
    if (this.permissions.aiUsers[chatId].length < len) {
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

  // ── Quiz history (capped at 20 per chat) ──────────────────────────
  getQuizHistory(chatId) {
    return this.permissions.quizHistory[chatId] || [];
  },

  async addQuizHistory(chatId, entry) {
    const hist = (this.permissions.quizHistory[chatId] ||= []);
    hist.unshift(entry);
    if (hist.length > 20) hist.length = 20; // in-place trim — no allocation
    await this.savePermissions();
  },

  // ── Quiz config ───────────────────────────────────────────────────
  getQuizConfig(chatId) {
    const o = this.quizConfig[chatId] || {};
    return {
      questionInterval:         o.questionInterval         ?? CONFIG.quiz.questionInterval,
      maxQuestionsPerQuiz:      o.maxQuestionsPerQuiz      ?? CONFIG.quiz.maxQuestionsPerQuiz,
      delayBeforeFirstQuestion: o.delayBeforeFirstQuestion ?? CONFIG.quiz.delayBeforeFirstQuestion,
      delayBeforeNextQuestion:  o.delayBeforeNextQuestion  ?? CONFIG.quiz.delayBeforeNextQuestion,
    };
  },

  async resetQuizConfig(chatId) {
    delete this.quizConfig[chatId];
    await this.saveQuizConfig();
  },
};

module.exports = storage;