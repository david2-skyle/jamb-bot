/**
 * utils.js — JAMB Quiz Bot v3.4.0
 *
 * Optimizations:
 * - LRU cache uses a doubly-linked list for O(1) eviction instead of
 *   Map iteration (was O(n) on every insertion once cache was full).
 * - fetchUrl reuses a persistent HTTPS agent (keep-alive).
 * - loadImage avoids redundant fs.access() — just reads and handles ENOENT.
 * - getUserDisplayInfo never throws, always returns a safe fallback.
 */

const path = require("path");
const https = require("https");
const http = require("http");
const { MessageMedia } = require("whatsapp-web.js");
const fs = require("fs").promises;
const CONFIG = require("./config");
const logger = require("./logger");

// ── O(1) LRU contact cache ────────────────────────────────────────
// Doubly-linked list (head = MRU, tail = LRU) + Map for O(1) lookup.
const contactCache = (() => {
  const MAX_SIZE = 500;
  const TTL_MS = 10 * 60 * 1000;

  // Node shape: { key, value, ts, prev, next }
  let head = null; // most-recently used
  let tail = null; // least-recently used
  const map = new Map();

  function unlink(node) {
    if (node.prev) node.prev.next = node.next;
    else head = node.next;
    if (node.next) node.next.prev = node.prev;
    else tail = node.prev;
    node.prev = node.next = null;
  }

  function pushFront(node) {
    node.next = head;
    node.prev = null;
    if (head) head.prev = node;
    head = node;
    if (!tail) tail = node;
  }

  function evictTail() {
    if (!tail) return;
    map.delete(tail.key);
    unlink(tail);
  }

  return {
    get(key) {
      const node = map.get(key);
      if (!node) return null;
      if (Date.now() - node.ts > TTL_MS) {
        map.delete(key);
        unlink(node);
        return null;
      }
      // Move to front (MRU)
      if (node !== head) {
        unlink(node);
        pushFront(node);
      }
      return node.value;
    },

    set(key, value) {
      if (map.has(key)) {
        const node = map.get(key);
        node.value = value;
        node.ts = Date.now();
        if (node !== head) {
          unlink(node);
          pushFront(node);
        }
        return;
      }
      if (map.size >= MAX_SIZE) evictTail();
      const node = { key, value, ts: Date.now(), prev: null, next: null };
      map.set(key, node);
      pushFront(node);
    },

    size() { return map.size; },
    clear() {
      map.clear();
      head = tail = null;
    },
  };
})();

// ── Persistent HTTPS agent for image fetching ─────────────────────
const fetchAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 8,
  timeout: 15_000,
});

// ──────────────────────────────────────────────────────────────────
const utils = {
  indexToLetter: (i) => String.fromCharCode(65 + i),
  letterToIndex: (l) => l.toUpperCase().charCodeAt(0) - 65,
  isValidAnswer: (a) => CONFIG.quiz.allowedAnswers.includes(a.toUpperCase()),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pluralize: (count, singular, plural) =>
    count === 1 ? singular : plural || `${singular}s`,

  formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  },

  formatSeconds(ms) { return `${ms / 1000}s`; },

  mentionText(userId) {
    return `@${userId.replace(/@\S+$/, "")}`;
  },

  guessMimeType(url, buffer) {
    if (buffer && buffer.length >= 4) {
      const hex = buffer.slice(0, 4).toString("hex");
      if (hex.startsWith("ffd8ff"))   return "image/jpeg";
      if (hex.startsWith("89504e47")) return "image/png";
      if (hex.startsWith("47494638")) return "image/gif";
      if (hex.startsWith("52494646")) return "image/webp";
    }
    const ext = url.split("?")[0].split(".").pop().toLowerCase();
    return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
             gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext] || "image/jpeg";
  },

  fetchUrl(url, redirectCount = 0) {
    if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith("https");
      const protocol = isHttps ? https : http;
      const reqOptions = { headers: { "User-Agent": "WhatsApp/2.0" } };
      if (isHttps) reqOptions.agent = fetchAgent;

      protocol.get(url, reqOptions, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          // Consume response to free socket
          res.resume();
          return resolve(this.fetchUrl(res.headers.location, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ buffer, mimeType: this.guessMimeType(url, buffer) });
        });
        res.on("error", reject);
      }).on("error", reject);
    });
  },

  async loadImage(imgPath) {
    if (!imgPath) return null;
    try {
      if (imgPath.startsWith("http://") || imgPath.startsWith("https://")) {
        const { buffer, mimeType } = await this.fetchUrl(imgPath);
        const base64 = buffer.toString("base64");
        const ext = mimeType.split("/")[1] || "jpg";
        return new MessageMedia(mimeType, base64, `image.${ext}`);
      }
      const resolved = path.isAbsolute(imgPath)
        ? imgPath
        : path.join(CONFIG.data.dataDirectory, imgPath);
      // Read directly — avoid a redundant fs.access() syscall
      const buffer = await fs.readFile(resolved);
      const mimeType = this.guessMimeType(resolved, buffer);
      return new MessageMedia(mimeType, buffer.toString("base64"), path.basename(resolved));
    } catch (e) {
      if (e.code !== "ENOENT") logger.warn(`Failed to load image (${imgPath}): ${e.message}`);
      return null;
    }
  },

  normalizePhone(raw) {
    const digits = raw.replace(/\D/g, "");
    const normalized =
      digits.length === 11 && digits.startsWith("0")
        ? "234" + digits.slice(1)
        : digits;
    return `${normalized}@c.us`;
  },

  _client: null,
  setClient(client) { this._client = client; },

  async getContact(userId) {
    try {
      if (!this._client) return null;
      return await this._client.getContactById(userId);
    } catch {
      return null;
    }
  },

  // ── Cached display-info lookup ────────────────────────────────────
  async getUserDisplayInfo(userId, fallbackName = null) {
    const cached = contactCache.get(userId);
    if (cached) return cached;

    const contact = await this.getContact(userId);
    const name =
      contact?.pushname ||
      contact?.verifiedName ||
      contact?.name ||
      fallbackName ||
      userId.replace(/@\S+$/, "");

    const info = { name, text: this.mentionText(userId), contact };
    contactCache.set(userId, info);
    return info;
  },

  contactCache,
};

module.exports = utils;