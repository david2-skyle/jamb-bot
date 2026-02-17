const CONFIG = require("./config");
const storage = require("./storage");

// ==========================================
// 🔐 PERMISSION HELPERS
// ==========================================
// Owner     → set in config.owners, global
// Bot Admin → per-chat: explicitly added OR is a WhatsApp group admin
// Moderator → per-chat: explicitly added

const permissions = {
  getUserId(msg) {
    return msg.author || msg.from;
  },

  // ── Check if sender is a WhatsApp group admin in this chat ────────
  async isWhatsAppGroupAdmin(msg) {
    try {
      const chat = await msg.getChat();
      if (!chat.isGroup) return false;
      const userId = this.getUserId(msg);
      const participant = chat.participants.find(
        (p) => p.id._serialized === userId,
      );
      return participant
        ? participant.isAdmin || participant.isSuperAdmin
        : false;
    } catch {
      return false;
    }
  },

  // ── Tier checks ───────────────────────────────────────────────────
  isOwner(msg) {
    return CONFIG.bot.owners.includes(this.getUserId(msg));
  },

  async isBotAdmin(msg) {
    const userId = this.getUserId(msg);
    const chatId = msg.from;
    if (CONFIG.bot.owners.includes(userId)) return true;
    if (storage.getBotAdmins(chatId).includes(userId)) return true;
    // Auto: WhatsApp group admins are Bot Admins
    return await this.isWhatsAppGroupAdmin(msg);
  },

  async isModerator(msg) {
    if (await this.isBotAdmin(msg)) return true;
    const userId = this.getUserId(msg);
    const chatId = msg.from;
    return storage.getModerators(chatId).includes(userId);
  },

  // ── Role name (for display) ───────────────────────────────────────
  async getRoleName(msg) {
    const userId = this.getUserId(msg);
    const chatId = msg.from;
    if (CONFIG.bot.owners.includes(userId)) return "Owner 👑";
    if (storage.getBotAdmins(chatId).includes(userId)) return "Bot Admin 🛡️";
    if (await this.isWhatsAppGroupAdmin(msg)) return "Bot Admin 🛡️ (WA Admin)";
    if (storage.getModerators(chatId).includes(userId)) return "Moderator ⭐";
    return "Member";
  },

  // ── Static role name (no async, uses stored data only) ────────────
  getStoredRoleName(userId, chatId) {
    if (CONFIG.bot.owners.includes(userId)) return "Owner 👑";
    if (storage.getBotAdmins(chatId).includes(userId)) return "Bot Admin 🛡️";
    if (storage.getModerators(chatId).includes(userId)) return "Moderator ⭐";
    return "Member";
  },

  // ── Management helpers ────────────────────────────────────────────
  async addBotAdmin(chatId, userId) {
    await storage.removeModerator(chatId, userId); // promote out of mod
    return storage.addBotAdmin(chatId, userId);
  },

  async removeBotAdmin(chatId, userId) {
    return storage.removeBotAdmin(chatId, userId);
  },

  listBotAdmins(chatId) {
    return storage.getBotAdmins(chatId);
  },

  async addModerator(chatId, userId) {
    if (storage.getBotAdmins(chatId).includes(userId)) return "already_admin";
    return storage.addModerator(chatId, userId);
  },

  async removeModerator(chatId, userId) {
    return storage.removeModerator(chatId, userId);
  },

  listModerators(chatId) {
    return storage.getModerators(chatId);
  },
};

module.exports = permissions;
