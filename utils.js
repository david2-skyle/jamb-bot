const path = require("path");
const https = require("https");
const http = require("http");
const { MessageMedia } = require("whatsapp-web.js");
const fs = require("fs").promises;
const CONFIG = require("./config");
const logger = require("./logger");

// ==========================================
// 🛠️ UTILITY FUNCTIONS
// ==========================================
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

  formatSeconds(ms) {
    return `${ms / 1000}s`;
  },

  mentionText(userId) {
    return `@${userId.replace(/@\S+$/, "")}`;
  },

  // Guess MIME type from URL path or file magic bytes
  guessMimeType(url, buffer) {
    // Check magic bytes first (most reliable)
    if (buffer && buffer.length >= 4) {
      const hex = buffer.slice(0, 4).toString("hex");
      if (hex.startsWith("ffd8ff")) return "image/jpeg";
      if (hex.startsWith("89504e47")) return "image/png";
      if (hex.startsWith("47494638")) return "image/gif";
      if (hex.startsWith("52494646")) return "image/webp"; // RIFF....WEBP
    }

    // Fall back to file extension in URL
    const clean = url.split("?")[0].split("#")[0].toLowerCase();
    const ext = clean.split(".").pop();
    const map = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
    };
    return map[ext] || "image/jpeg"; // default to jpeg
  },

  // Fetch a URL and return raw buffer + mime type
  fetchUrl(url, redirectCount = 0) {
    if (redirectCount > 5)
      return Promise.reject(new Error("Too many redirects"));
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith("https") ? https : http;
      protocol
        .get(url, { headers: { "User-Agent": "WhatsApp/2.0" } }, (res) => {
          if (
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location
          ) {
            return resolve(
              this.fetchUrl(res.headers.location, redirectCount + 1),
            );
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            // Prefer magic bytes over content-type header
            const mimeType = this.guessMimeType(url, buffer);
            resolve({ buffer, mimeType });
          });
          res.on("error", reject);
        })
        .on("error", reject);
    });
  },

  async loadImage(imgPath) {
    if (!imgPath) return null;

    try {
      // ── Remote URL ──────────────────────────────────────────────────
      if (imgPath.startsWith("http://") || imgPath.startsWith("https://")) {
        logger.debug(`Fetching image URL: ${imgPath}`);
        const { buffer, mimeType } = await this.fetchUrl(imgPath);
        logger.debug(`Image loaded: ${mimeType} (${buffer.length} bytes)`);
        const base64 = buffer.toString("base64");
        const ext = mimeType.split("/")[1] || "jpg";
        return new MessageMedia(mimeType, base64, `image.${ext}`);
      }

      // ── Local file ──────────────────────────────────────────────────
      const resolved = path.isAbsolute(imgPath)
        ? imgPath
        : path.join(CONFIG.data.dataDirectory, imgPath);
      await fs.access(resolved);
      const buffer = await fs.readFile(resolved);
      const mimeType = this.guessMimeType(resolved, buffer);
      const base64 = buffer.toString("base64");
      return new MessageMedia(mimeType, base64, path.basename(resolved));
    } catch (e) {
      logger.warn(`Failed to load image (${imgPath}): ${e.message}`);
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

  // Set by index.js after the client is created
  _client: null,

  setClient(client) {
    this._client = client;
  },

  async getContact(userId) {
    try {
      if (!this._client) throw new Error("Client not initialized");
      return await this._client.getContactById(userId);
    } catch (e) {
      logger.warn(`getContact failed for ${userId}: ${e.message}`);
      return null;
    }
  },

  async getUserDisplayInfo(userId, fallbackName = null) {
    const contact = await this.getContact(userId);
    const name =
      contact?.pushname ||
      contact?.verifiedName ||
      contact?.name ||
      fallbackName ||
      userId.replace(/@\S+$/, "");
    return { name, text: this.mentionText(userId), contact };
  },
};

module.exports = utils;
