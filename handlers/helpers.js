/**
 * handlers/helpers.js
 * Low-level shared utilities used by multiple handler modules.
 * Has NO dependencies on other handler files — this breaks all
 * circular dependency chains.
 *
 * Exports:
 *   isBrowserError     – detects WhatsApp browser crash errors
 *   safeSend           – client.sendMessage that never throws
 *   aiCircuitBreaker   – shared AI rate-limiting singleton
 *   safeAi             – circuit-breaker-aware AI call wrapper
 */

const CONFIG = require("../config");
const logger = require("../logger");
const aiService = require("../Aiservice");

// ── Browser crash detection ───────────────────────────────────────
function isBrowserError(error) {
  const msg = error?.message || "";
  return (
    msg.includes("Target closed") ||
    msg.includes("detached Frame") ||
    msg.includes("Session closed") ||
    msg.includes("Protocol error") ||
    msg.includes("Execution context was destroyed") ||
    msg.includes("Cannot find context") ||
    msg.includes("Connection closed")
  );
}

// ── Safe send — never throws ──────────────────────────────────────
async function safeSend(chatId, text) {
  // Lazy-require client to avoid loading it before it is configured
  const client = require("../client");
  try {
    return await client.sendMessage(chatId, text);
  } catch (e) {
    if (!isBrowserError(e)) logger.error("[Send] Error:", e.message);
    return null;
  }
}

// ── AI Circuit Breaker ────────────────────────────────────────────
// Singleton — shared by quizHandlers (AI explanation after each Q)
// and aiHandlers (user-facing .ai / .genq commands).
// After THRESHOLD consecutive failures, the circuit opens for RESET_MS,
// suppressing further AI calls so quiz flow is never blocked.
const aiCircuitBreaker = {
  failures: 0,
  lastFailure: null,
  isOpen: false,
  THRESHOLD: 3,
  RESET_MS: 10 * 60 * 1000, // 10 minutes

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.THRESHOLD && !this.isOpen) {
      this.isOpen = true;
      logger.warn(
        `[AI] Circuit OPEN — suppressing AI calls for ${this.RESET_MS / 60000} min. ` +
          `(Visit https://console.x.ai to check credits.)`,
      );
    }
  },

  canTry() {
    if (!CONFIG.ai?.apiKey) return false;
    if (!this.isOpen) return true;
    if (Date.now() - this.lastFailure > this.RESET_MS) {
      this.isOpen = false;
      this.failures = 0;
      logger.info("[AI] Circuit RESET — resuming AI calls");
      return true;
    }
    return false;
  },

  status() {
    return {
      isOpen: this.isOpen,
      failures: this.failures,
      canTry: this.canTry(),
      resetIn: this.isOpen
        ? Math.max(
            0,
            Math.round(
              (this.RESET_MS - (Date.now() - this.lastFailure)) / 1000,
            ),
          )
        : 0,
    };
  },
};

// ── Safe AI call — NEVER throws, NEVER blocks ─────────────────────
async function safeAi(fn, ...args) {
  if (!aiCircuitBreaker.canTry()) return null;
  try {
    return await fn(...args);
  } catch (e) {
    aiCircuitBreaker.recordFailure();
    logger.warn("[AI] Call failed:", e.message?.slice(0, 120));
    return null;
  }
}

module.exports = { isBrowserError, safeSend, aiCircuitBreaker, safeAi };
