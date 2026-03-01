/**
 * commandHandler.js — JAMB Quiz Bot v3.2.0
 * =========================================
 * Pure message router. No business logic lives here.
 *
 * Handler modules:
 *   handlers/quizHandlers.js    – quiz engine + quiz commands
 *   handlers/adminHandlers.js   – admin/mod/config/owner commands
 *   handlers/aiHandlers.js      – AI circuit breaker + AI commands
 *   handlers/generalHandlers.js – ping, help, myrole, subjects, years
 */

const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const permissions = require("./permissions");

// ── Handler imports ───────────────────────────────────────────────
const {
  isBrowserError,
  handleAnswer,
  handleStartQuiz,
  handleStopQuiz,
  handleScore,
  handleStats,
  handleQuestion,
  processQuestionEnd,
} = require("./handlers/quizHandlers");

const {
  handleSetInterval,
  handleSetDelay,
  handleSetMax,
  handleChatConfig,
  handleEnable,
  handleDisable,
  handleGlobalEnable,
  handleGlobalDisable,
  handleAdmin,
  handleMod,
  handleAnnounce,
  handleSetWelcome,
  handleClearWelcome,
  handleResetConfig,
  handleQuizHistory,
  handleBroadcast,
  handleChats,
  handleAllStaff,
  handleClearStaff,
} = require("./handlers/adminHandlers");

const {
  aiCircuitBreaker,
  handleAiChat,
  handleGenerateQuestions,
} = require("./handlers/aiHandlers");

const {
  handlePing,
  handleHelp,
  handleMyRole,
  handleSubjects,
  handleYears,
} = require("./handlers/generalHandlers");

// ── Commands always allowed even when chat is disabled ────────────
const ALWAYS_ALLOWED = new Set([
  "help",
  "myrole",
  "ping",
  "enable",
  "genable",
  "gdisable",
  "whoami",
  "admin",
  "mod",
  "chatconfig",
]);

// ── Resolve mention or phone number to a userId ───────────────────
function resolveTarget(msg, rest) {
  if (msg.mentionedIds?.length > 0) return msg.mentionedIds[0];
  if (rest?.length > 0) return utils.normalizePhone(rest[0]);
  return null;
}

// ── Wait for a "yes" reply within timeout ─────────────────────────
const client = require("./client");
function _waitForReply(chatId, userId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeListener("message_create", handler);
      resolve(null);
    }, timeoutMs);
    const handler = async (m) => {
      if (
        m.from === chatId &&
        (m.author === userId || m.from === userId) &&
        m.body?.trim().toLowerCase() === "yes"
      ) {
        clearTimeout(timer);
        client.removeListener("message_create", handler);
        resolve(m);
      }
    };
    client.on("message_create", handler);
  });
}

// ── Main message router ───────────────────────────────────────────
const commandHandler = {
  async handle(msg) {
    try {
      const { prefix } = CONFIG.bot;
      const body = msg.body || "";
      const trimmed = body.trim();
      const chatId = msg.from;
      const isOwner = permissions.isOwner(msg);

      if (storage.isGloballyDisabled() && !isOwner) return;

      const chatDisabled = storage.isChatDisabled(chatId);

      // A/B/C/D answers — checked before prefix, no prefix needed
      if (!chatDisabled) {
        const upper = trimmed.toUpperCase();
        if (/^[A-D]$/.test(upper)) {
          await handleAnswer(msg, upper);
          return;
        }
      }

      // Ignore messages that don't start with the prefix
      const prefixRegex = new RegExp(`^\\${prefix}\\s*\\S`);
      if (!prefixRegex.test(trimmed)) return;

      const withoutPrefix = trimmed
        .replace(new RegExp(`^\\${prefix}\\s*`), "")
        .trim();
      const [cmd, ...argParts] = withoutPrefix.toLowerCase().split(/\s+/);
      const rawArgs = trimmed
        .replace(new RegExp(`^\\${prefix}\\s*\\S+\\s*`), "")
        .trim();

      if (
        chatDisabled &&
        !permissions.isOwner(msg) &&
        !(await permissions.isBotAdmin(msg)) &&
        !ALWAYS_ALLOWED.has(cmd)
      ) {
        await msg.reply(
          `⚠️ Bot is disabled here. Use ${prefix}enable to re-enable.`,
        );
        return;
      }

      switch (cmd) {
        // ── General ───────────────────────────────────────────────
        case "ping":
          return await handlePing(msg);
        case "help":
          return await handleHelp(msg);
        case "myrole":
          return await handleMyRole(msg);
        case "subjects":
          return await handleSubjects(msg);
        case "years":
          return await handleYears(msg, argParts);
        case "whoami":
          return await msg.reply(permissions.getUserId(msg));

        // ── Quiz ──────────────────────────────────────────────────
        case "question":
          return await handleQuestion(msg, argParts);
        case "score":
          return await handleScore(msg);
        case "stats":
          return await handleStats(msg);
        case "start":
          return await handleStartQuiz(msg, argParts);
        case "stop":
          return await handleStopQuiz(msg);

        // ── Quiz config ───────────────────────────────────────────
        case "setinterval":
          return await handleSetInterval(msg, argParts);
        case "setdelay":
          return await handleSetDelay(msg, argParts);
        case "setmax":
          return await handleSetMax(msg, argParts);
        case "chatconfig":
          return await handleChatConfig(msg);
        case "resetconfig":
          return await handleResetConfig(msg);

        // ── Bot admin ─────────────────────────────────────────────
        case "enable":
          return await handleEnable(msg);
        case "disable":
          return await handleDisable(msg);
        case "admin":
          return await handleAdmin(msg, argParts, resolveTarget);
        case "mod":
          return await handleMod(msg, argParts, resolveTarget);
        case "announce":
          return await handleAnnounce(msg, rawArgs);
        case "setwelcome":
          return await handleSetWelcome(msg, rawArgs);
        case "clearwelcome":
          return await handleClearWelcome(msg);
        case "quizhistory":
          return await handleQuizHistory(msg);
        case "clearstaff":
          return await handleClearStaff(msg);

        // ── Owner ─────────────────────────────────────────────────
        case "genable":
          return await handleGlobalEnable(msg);
        case "gdisable":
          return await handleGlobalDisable(msg);
        case "broadcast":
          return await handleBroadcast(msg, rawArgs);
        case "chats":
          return await handleChats(msg);
        case "allstaff":
          return await handleAllStaff(msg);

        // ── AI ────────────────────────────────────────────────────
        case "ai":
          return await handleAiChat(msg, rawArgs);
        case "genq":
          return await handleGenerateQuestions(msg, argParts);

        default:
          break;
      }
    } catch (error) {
      if (isBrowserError(error)) {
        logger.warn(
          `[Handle] Browser error for ${msg?.from}: ${error.message?.slice(0, 80)}`,
        );
        return;
      }
      logger.error("[Handle] Unhandled error:", error);
      try {
        await msg.reply("❌ An unexpected error occurred.");
      } catch {}
    }
  },

  // Exposed for dashboard API
  getAiStatus: () => aiCircuitBreaker.status(),

  // Exposed for index.js (processQuestionEnd is used by quizManager.stop dashboard path)
  processQuestionEnd,

  // Exposed for api-server.js quiz stop
  _waitForReply,
};

module.exports = commandHandler;
