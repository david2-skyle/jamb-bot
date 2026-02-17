const CONFIG = require("./config");

// ==========================================
// 📝 LOGGING UTILITIES
// ==========================================
const logger = {
  info: (msg, ...args) =>
    CONFIG.logging.enabled && console.log(`ℹ️  ${msg}`, ...args),
  success: (msg, ...args) =>
    CONFIG.logging.enabled && console.log(`✅ ${msg}`, ...args),
  error: (msg, ...args) => console.error(`❌ ${msg}`, ...args),
  warn: (msg, ...args) =>
    CONFIG.logging.enabled && console.warn(`⚠️  ${msg}`, ...args),
  debug: (msg, ...args) =>
    CONFIG.logging.verbose && console.log(`🐛 ${msg}`, ...args),
};

module.exports = logger;
