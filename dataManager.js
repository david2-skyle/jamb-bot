/**
 * dataManager.js — JAMB Quiz Bot v3.4.0
 *
 * Optimizations:
 * - In-memory question file cache with TTL (5 min).
 *   Hot quizzes stop hitting the filesystem on every question load.
 * - getAvailableSubjects / getAvailableYears results cached for 60s.
 * - loadQuestions validates structure once and caches the result.
 * - getRandomQuestion uses the cache, not a fresh readFile each call.
 */

const fs = require("fs").promises;
const path = require("path");
const CONFIG = require("./config");
const logger = require("./logger");

// ── Simple TTL cache ──────────────────────────────────────────────
function makeCache(ttlMs) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts > ttlMs) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, ts: Date.now() });
    },
    delete(key) {
      store.delete(key);
    },
    size() { return store.size; },
  };
}

// Question files: 5-minute TTL (they don't change during runtime)
const questionCache = makeCache(5 * 60 * 1_000);
// Directory listings: 60-second TTL
const dirCache = makeCache(60 * 1_000);

// ──────────────────────────────────────────────────────────────────
const dataManager = {
  async loadQuestions(subject, year) {
    const cacheKey = `${subject}:${year}`;
    const cached = questionCache.get(cacheKey);
    if (cached !== undefined) return cached; // null is a valid cached value

    const filePath = path.join(CONFIG.data.dataDirectory, subject, `${year}.json`);
    logger.debug(`Loading: ${filePath}`);

    let raw;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (e) {
      if (e.code !== "ENOENT") logger.error(`readFile error (${filePath}):`, e.message);
      else logger.warn(`File not found: ${filePath}`);
      questionCache.set(cacheKey, null); // cache the miss too
      return null;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      logger.error(`JSON parse error (${filePath}):`, e.message);
      questionCache.set(cacheKey, null);
      return null;
    }

    if (!Array.isArray(data.questions) || data.questions.length === 0) {
      logger.warn(`Invalid/empty questions in: ${filePath}`);
      questionCache.set(cacheKey, null);
      return null;
    }

    const result = {
      paperType: data.paper_type || "STANDARD",
      questions: data.questions,
    };

    questionCache.set(cacheKey, result);
    logger.success(`Loaded ${result.questions.length} questions (${subject} ${year})`);
    return result;
  },

  async getRandomQuestion(subject, year) {
    const data = await this.loadQuestions(subject, year);
    if (!data) return null;
    const idx = Math.floor(Math.random() * data.questions.length);
    return { question: data.questions[idx], paperType: data.paperType, index: idx };
  },

  async getAvailableSubjects() {
    const cached = dirCache.get("subjects");
    if (cached !== undefined) return cached;
    try {
      const entries = await fs.readdir(CONFIG.data.dataDirectory, { withFileTypes: true });
      const subjects = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
      dirCache.set("subjects", subjects);
      return subjects;
    } catch {
      return CONFIG.data.subjects;
    }
  },

  async getAvailableYears(subject) {
    const cacheKey = `years:${subject}`;
    const cached = dirCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const dir = path.join(CONFIG.data.dataDirectory, subject);
      const files = await fs.readdir(dir);
      const years = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""))
        .sort();
      dirCache.set(cacheKey, years);
      return years;
    } catch {
      return CONFIG.data.years;
    }
  },

  // Expose cache for diagnostics
  _questionCache: questionCache,
  _dirCache: dirCache,
};

module.exports = dataManager;