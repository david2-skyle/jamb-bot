/**
 * handlers/generalHandlers.js
 * Lightweight commands available to all users.
 *
 * Exports:
 *   handlePing
 *   handleHelp
 *   handleMyRole
 *   handleSubjects
 *   handleYears
 */

const CONFIG = require("../config");
const storage = require("../storage");
const utils = require("../utils");
const permissions = require("../permissions");
const dataManager = require("../dataManager");
const messageFormatter = require("../messageFormatter");

// ── handlePing ────────────────────────────────────────────────────
async function handlePing(msg) {
  const t = Date.now();
  const reply = await msg.reply("ℹ️ Pong!");
  await reply.edit(`✅ Pong! _(${Date.now() - t}ms)_`);
}

// ── handleHelp ────────────────────────────────────────────────────
async function handleHelp(msg) {
  await msg.reply(await messageFormatter.formatHelp(msg.from, msg));
}

// ── handleMyRole ──────────────────────────────────────────────────
async function handleMyRole(msg) {
  const role = await permissions.getRoleName(msg);
  await msg.reply(`ℹ️ Your role: *${role}*`);
}

// ── handleSubjects ────────────────────────────────────────────────
async function handleSubjects(msg) {
  const subjects = await dataManager.getAvailableSubjects();
  await msg.reply(
    `📚 *Available Subjects:*\n\n${subjects.map((s) => `• ${s.toUpperCase()}`).join("\n")}`,
  );
}

// ── handleYears ───────────────────────────────────────────────────
async function handleYears(msg, args) {
  if (!args[0]) {
    await msg.reply(`❌ Usage: ${CONFIG.bot.prefix}years [subject]`);
    return;
  }
  const years = await dataManager.getAvailableYears(args[0].toLowerCase());
  await msg.reply(
    `📅 *Years for ${args[0].toUpperCase()}:*\n\n` +
      `${years.map((y) => `• ${y}`).join("\n")}\n\n_Use \`all\` for all years_`,
  );
}

module.exports = {
  handlePing,
  handleHelp,
  handleMyRole,
  handleSubjects,
  handleYears,
};
