const CONFIG = require("./config");
const storage = require("./storage");

// ==========================================
// 🔐 PERMISSION HELPERS
// ==========================================
// Owner      → set in config.owners, global
// Bot Admin  → per-chat: explicitly added OR is a WhatsApp group admin
// Moderator  → per-chat: explicitly added
// AI User    → per-chat: explicitly granted by a Bot Admin
//              (Bot Admins and above always have AI access automatically)

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
    return await this.isWhatsAppGroupAdmin(msg);
  },

  async isModerator(msg) {
    if (await this.isBotAdmin(msg)) return true;
    const userId = this.getUserId(msg);
    const chatId = msg.from;
    return storage.getModerators(chatId).includes(userId);
  },

  // ── AI access check ───────────────────────────────────────────────
  // Bot Admins and above always have AI access.
  // Regular members/mods need to be explicitly granted by an admin.
  async canUseAi(msg) {
    if (await this.isBotAdmin(msg)) return true;
    const userId = this.getUserId(msg);
    const chatId = msg.from;
    return storage.getAiUsers(chatId).includes(userId);
  },

  // ── Role name (for display) ───────────────────────────────────────
  async getRoleName(msg) {
    const userId = this.getUserId(msg);
    const chatId = msg.from;
    if (CONFIG.bot.owners.includes(userId)) return "Owner 👑";
    if (storage.getBotAdmins(chatId).includes(userId)) return "Bot Admin 🛡️";
    if (await this.isWhatsAppGroupAdmin(msg)) return "Bot Admin 🛡️ (WA Admin)";
    if (storage.getModerators(chatId).includes(userId)) return "Moderator ⭐";
    if (storage.getAiUsers(chatId).includes(userId)) return "AI User 🤖";
    return "Member";
  },

  // ── Static role name (no async, uses stored data only) ────────────
  getStoredRoleName(userId, chatId) {
    if (CONFIG.bot.owners.includes(userId)) return "Owner 👑";
    if (storage.getBotAdmins(chatId).includes(userId)) return "Bot Admin 🛡️";
    if (storage.getModerators(chatId).includes(userId)) return "Moderator ⭐";
    if (storage.getAiUsers(chatId).includes(userId)) return "AI User 🤖";
    return "Member";
  },

  // ── Management helpers ────────────────────────────────────────────
  async addBotAdmin(chatId, userId) {
    await storage.removeModerator(chatId, userId);
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

  // ── AI User management ────────────────────────────────────────────
  async addAiUser(chatId, userId) {
    return storage.addAiUser(chatId, userId);
  },

  async removeAiUser(chatId, userId) {
    return storage.removeAiUser(chatId, userId);
  },

  listAiUsers(chatId) {
    return storage.getAiUsers(chatId);
  },
};

module.exports = permissions;
