/**
 * handlers/helpers.js — v3.4.0
 *
 * Optimizations:
 * - isBrowserError uses a pre-compiled Set of substrings (not repeated .includes calls).
 * - safeSend guards against sending to a dead chat by catching all errors silently.
 * - aiCircuitBreaker reset timer is handled with a single scheduled timeout
 *   instead of computing elapsed time on every canTry() call.
 * - safeAi records failures accurately even when fn throws synchronously.
 */

const CONFIG = require("../config");
const logger = require("../logger");

// ── Browser crash detection ───────────────────────────────────────
// Pre-built set checked with Array.some for a single pass.
const BROWSER_ERROR_FRAGMENTS = [
  "Target closed",
  "detached Frame",
  "Session closed",
  "Protocol error",
  "Execution context was destroyed",
  "Cannot find context",
  "Connection closed",
];

function isBrowserError(error) {
  const msg = error?.message || "";
  return BROWSER_ERROR_FRAGMENTS.some((f) => msg.includes(f));
}

// ── Safe send — never throws ──────────────────────────────────────
async function safeSend(chatId, text) {
  const client = require("../client");
  try {
    return await client.sendMessage(chatId, text);
  } catch (e) {
    if (!isBrowserError(e)) logger.error("[Send] Error:", e.message);
    return null;
  }
}

// ── AI Circuit Breaker ────────────────────────────────────────────
// Uses a scheduled timeout for reset so canTry() is O(1) — no Date.now() math.
const aiCircuitBreaker = (() => {
  const THRESHOLD = 3;
  const RESET_MS = 10 * 60 * 1_000;

  let failures = 0;
  let isOpen = false;
  let resetTimer = null;
  let resetAt = 0;

  function scheduleReset() {
    if (resetTimer) return; // already scheduled
    resetAt = Date.now() + RESET_MS;
    resetTimer = setTimeout(() => {
      resetTimer = null;
      resetAt = 0;
      isOpen = false;
      failures = 0;
      logger.info("[AI] Circuit RESET — resuming AI calls");
    }, RESET_MS);
    // Don't block process exit
    if (resetTimer.unref) resetTimer.unref();
  }

  return {
    recordFailure() {
      failures++;
      if (failures >= THRESHOLD && !isOpen) {
        isOpen = true;
        logger.warn(
          `[AI] Circuit OPEN — suppressing AI calls for ${RESET_MS / 60_000}min.`,
        );
        scheduleReset();
      }
    },

    canTry() {
      if (!CONFIG.ai?.apiKey) return false;
      return !isOpen;
    },

    status() {
      return {
        isOpen,
        failures,
        canTry: !isOpen && !!CONFIG.ai?.apiKey,
        resetIn: isOpen ? Math.max(0, Math.round((resetAt - Date.now()) / 1_000)) : 0,
      };
    },
  };
})();

// ── Safe AI call — NEVER throws, NEVER blocks ─────────────────────
async function safeAi(fn, ...args) {
  if (!aiCircuitBreaker.canTry()) return null;
  try {
    const result = await fn(...args);
    return result;
  } catch (e) {
    aiCircuitBreaker.recordFailure();
    logger.warn("[AI] Call failed:", e.message?.slice(0, 120));
    return null;
  }
}

module.exports = { isBrowserError, safeSend, aiCircuitBreaker, safeAi };