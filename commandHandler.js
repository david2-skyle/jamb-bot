const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const permissions = require("./permissions");
const dataManager = require("./dataManager");
const quizManager = require("./quizManager");
const messageFormatter = require("./messageFormatter");
const { getOrCreateState, activeQuizzes } = require("./state");
const client = require("./client");

// ==========================================
// 🎮 COMMAND HANDLER
// ==========================================
const commandHandler = {
  async handle(msg) {
    try {
      const { prefix } = CONFIG.bot;
      const body = msg.body || "";
      const trimmed = body.trim();
      const chatId = msg.from;
      const isOwner = permissions.isOwner(msg);
      const isBotAdmin = await permissions.isBotAdmin(msg);

      // ── Global disable: only Owner can act ─────────────────────────
      if (storage.isGloballyDisabled() && !isOwner) return;

      // ── Per-chat disable check ──────────────────────────────────────
      const chatDisabled = storage.isChatDisabled(chatId);

      // ── Quiz answer detection (A/B/C/D in any message) ─────────────
      // Must check BEFORE prefix routing so answers work in all contexts
      if (!chatDisabled) {
        const upperTrimmed = trimmed.toUpperCase();
        if (/^[A-D]$/.test(upperTrimmed)) {
          await this.handleAnswer(msg, upperTrimmed);
          return;
        }
      }

      const prefixRegex = new RegExp(`^\\${prefix}\\s*\\S`);
      if (!prefixRegex.test(trimmed)) return;

      const withoutPrefix = trimmed
        .replace(new RegExp(`^\\${prefix}\\s*`), "")
        .trim();
      const [cmd, ...argParts] = withoutPrefix.toLowerCase().split(/\s+/);

      // When chat is disabled, only Bot Admin+ can run config commands
      const configOnlyCmds = new Set([
        "setinterval",
        "setdelay",
        "setmax",
        "chatconfig",
        "enable",
        "admin",
        "mod",
        "announce",
        "setwelcome",
        "clearwelcome",
        "resetconfig",
        "quizhistory",
        "help",
        "myrole",
        "ping",
        "genable",
        "gdisable",
        "broadcast",
        "chats",
        "allstaff",
        "clearstaff",
        "whoami",
      ]);

      if (chatDisabled && !isBotAdmin && !configOnlyCmds.has(cmd)) return;
      if (chatDisabled && !isBotAdmin) {
        const blockedWhenDisabled = new Set([
          "start",
          "stop",
          "score",
          "stats",
          "question",
          "subjects",
          "years",
        ]);
        if (blockedWhenDisabled.has(cmd)) {
          await msg.reply(
            `${CONFIG.messages.emojis.warning} The bot is disabled in this chat. Use ${prefix}enable to re-enable.`,
          );
          return;
        }
      }

      switch (cmd) {
        // ── General (anyone) ─────────────────────────────────────────
        case "ping":
          return await this.handlePing(msg);
        case "help":
          return await this.handleHelp(msg);
        case "myrole":
          return await this.handleMyRole(msg);
        case "subjects":
          return await this.handleSubjects(msg);
        case "years":
          return await this.handleYears(msg, argParts);
        case "question":
          return await this.handleQuestion(msg, argParts);
        case "score":
          return await this.handleScore(msg);
        case "stats":
          return await this.handleStats(msg);

        // ── Moderator+ ───────────────────────────────────────────────
        case "start":
          return await this.handleStartQuiz(msg, argParts);
        case "stop":
          return await this.handleStopQuiz(msg);
        case "setinterval":
          return await this.handleSetInterval(msg, argParts);
        case "setdelay":
          return await this.handleSetDelay(msg, argParts);
        case "setmax":
          return await this.handleSetMax(msg, argParts);
        case "chatconfig":
          return await this.handleChatConfig(msg);

        // ── Bot Admin+ ───────────────────────────────────────────────
        case "enable":
          return await this.handleEnable(msg);
        case "disable":
          return await this.handleDisable(msg);
        case "admin":
          return await this.handleAdmin(msg, argParts);
        case "mod":
          return await this.handleMod(msg, argParts);
        case "announce":
          return await this.handleAnnounce(msg, argParts);
        case "setwelcome":
          return await this.handleSetWelcome(msg, argParts);
        case "clearwelcome":
          return await this.handleClearWelcome(msg);
        case "resetconfig":
          return await this.handleResetConfig(msg);
        case "quizhistory":
          return await this.handleQuizHistory(msg);

        // ── Owner only ───────────────────────────────────────────────
        case "genable":
          return await this.handleGlobalEnable(msg);
        case "gdisable":
          return await this.handleGlobalDisable(msg);
        case "broadcast":
          return await this.handleBroadcast(msg, argParts);
        case "chats":
          return await this.handleChats(msg);
        case "allstaff":
          return await this.handleAllStaff(msg);
        case "clearstaff":
          return await this.handleClearStaff(msg, argParts);

        case "whoami":
          await msg.reply(permissions.getUserId(msg));
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error("Command error:", error);
      try {
        await msg.reply(
          `${CONFIG.messages.emojis.error} An unexpected error occurred.`,
        );
      } catch {}
    }
  },

  // ── PING ─────────────────────────────────────────────────────────
  async handlePing(msg) {
    const t = Date.now();
    const reply = await msg.reply(`${CONFIG.messages.emojis.info} Pong!`);
    await reply.edit(
      `${CONFIG.messages.emojis.success} Pong! _(${Date.now() - t}ms)_`,
    );
  },

  // ── HELP ─────────────────────────────────────────────────────────
  async handleHelp(msg) {
    await msg.reply(await messageFormatter.formatHelp(msg.from, msg));
  },

  // ── MY ROLE ──────────────────────────────────────────────────────
  async handleMyRole(msg) {
    const role = await permissions.getRoleName(msg);
    await msg.reply(
      `${CONFIG.messages.emojis.info} Your role in this chat: *${role}*`,
    );
  },

  // ── SUBJECTS ─────────────────────────────────────────────────────
  async handleSubjects(msg) {
    const subjects = await dataManager.getAvailableSubjects();
    await msg.reply(
      `${CONFIG.messages.emojis.book} *Available Subjects:*\n\n` +
        subjects.map((s) => `• ${s.toUpperCase()}`).join("\n"),
    );
  },

  // ── YEARS ────────────────────────────────────────────────────────
  async handleYears(msg, args) {
    if (args.length < 1) {
      await msg.reply(
        `${CONFIG.messages.emojis.error} Usage: ${CONFIG.bot.prefix}years [subject]`,
      );
      return;
    }
    const subject = args[0].toLowerCase();
    const years = await dataManager.getAvailableYears(subject);
    await msg.reply(
      `📅 *Years for ${subject.toUpperCase()}:*\n\n` +
        years.map((y) => `• ${y}`).join("\n") +
        `\n\n_Use \`all\` to quiz across all years_`,
    );
  },

  // ── PRACTICE QUESTION ────────────────────────────────────────────
  async handleQuestion(msg, args) {
    if (args.length < 2) {
      await msg.reply(
        `${CONFIG.messages.emojis.error} Usage: ${CONFIG.bot.prefix}question [subject] [year]`,
      );
      return;
    }
    const [subject, year] = args;
    const result = await dataManager.getRandomQuestion(subject, year);
    if (!result) {
      await msg.reply(
        `${CONFIG.messages.emojis.error} No questions found for *${subject} ${year}*.`,
      );
      return;
    }
    const text =
      `*🎲 Practice Question*\n${subject.toUpperCase()} ${year} (${result.paperType})\n\n` +
      messageFormatter.formatQuestion(
        { ...result.question, year },
        result.index,
      ) +
      `\n\n_Reply with A, B, C, or D_`;
    await this.sendQuestionMessage(msg.from, text, result.question.image, msg);
  },

  // ── START QUIZ ───────────────────────────────────────────────────
  async handleStartQuiz(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators, Bot Admins, or the Owner can start quizzes.",
      );
      return;
    }
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (state.isActive) {
      await msg.reply(
        `${emojis.warning} *Quiz already active!*\n\n` +
          `Subject: ${state.subject?.toUpperCase()}\n` +
          `Q: ${state.currentQuestionIndex + 1}/${state.questions.length}\n\n` +
          `Use ${CONFIG.bot.prefix}stop to end it first.`,
      );
      return;
    }
    if (args.length < 2) {
      await msg.reply(
        `${emojis.error} Usage: ${CONFIG.bot.prefix}start [subject] [year]\n` +
          `Example: ${CONFIG.bot.prefix}start chemistry 2010\n` +
          `Use \`all\` as year for all years mixed.`,
      );
      return;
    }
    const [subject, year] = args;
    const chatCfg = storage.getQuizConfig(chatId);
    const started = await quizManager.start(subject, year, chatId);
    if (!started) {
      await msg.reply(
        `${emojis.error} No questions found for *${subject} ${year}*.`,
      );
      return;
    }
    const freshState = getOrCreateState(chatId);
    await msg.reply(
      `${emojis.trophy} *Quiz Started!*\n\n` +
        `📖 Subject: ${subject.toUpperCase()}\n` +
        `📅 Year: ${year}\n` +
        `📋 Questions: ${freshState.questions.length}\n` +
        `${emojis.timer} Question time: ${utils.formatSeconds(chatCfg.questionInterval)}\n` +
        `⏳ Next Q delay: ${utils.formatSeconds(chatCfg.delayBeforeNextQuestion)}\n\n` +
        `Send *A, B, C, or D* to answer each question. You can change your answer until time is up!\n` +
        `Good luck! 🍀`,
    );

    // Send welcome message if set
    const welcome = storage.getWelcomeMessage(chatId);
    if (welcome) await client.sendMessage(chatId, welcome);

    await utils.sleep(chatCfg.delayBeforeFirstQuestion);

    const firstQ = quizManager.getCurrentQuestion(freshState);
    const sentMsg = await this.sendQuestionMessage(
      chatId,
      messageFormatter.formatQuestion(firstQ, 0),
      firstQ.image,
    );
    freshState.lastQuestionMsgId = sentMsg?.id?._serialized || null;
    freshState.questionSentAt = Date.now();
    freshState.startedSubject = subject;
    freshState.startedYear = year;

    await this.startQuizInterval(chatId);
  },

  // ── QUIZ INTERVAL ────────────────────────────────────────────────
  async startQuizInterval(chatId) {
    const state = getOrCreateState(chatId);
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
    const chatCfg = storage.getQuizConfig(chatId);

    state.interval = setInterval(async () => {
      try {
        const s = getOrCreateState(chatId);
        if (!s.isActive) {
          clearInterval(s.interval);
          s.interval = null;
          return;
        }
        const elapsed = Date.now() - (s.questionSentAt || Date.now());
        if (elapsed >= chatCfg.questionInterval) {
          clearInterval(s.interval);
          s.interval = null;
          await commandHandler.processQuestionEnd(chatId);
        }
      } catch (error) {
        logger.error(`Quiz interval error [${chatId}]:`, error.message);
      }
    }, 1000);
  },

  async processQuestionEnd(chatId) {
    const { emojis } = CONFIG.messages;
    const state = getOrCreateState(chatId);
    if (!state.isActive) return;

    const correctAnswer = quizManager.getCurrentAnswerLetter(state);
    const correctList = Object.entries(state.currentRespondents)
      .filter(([, d]) => d.isCorrect)
      .map(([, d]) => d.name);

    let resultsMsg = `${emojis.timer} *Time's Up!*\n\n${emojis.success} *Answer: ${correctAnswer}*\n\n`;
    resultsMsg += quizManager.getCurrentQuestionExplanation(state) + "\n\n";
    resultsMsg += `${emojis.success} *Correct (${correctList.length}):*\n`;
    resultsMsg += correctList.length > 0 ? correctList.join(", ") : "No one";

    await client.sendMessage(chatId, resultsMsg);

    const chatCfg = storage.getQuizConfig(chatId);
    const nextQ = quizManager.nextQuestion(state);
    state.currentRespondents = {};

    if (nextQ) {
      await utils.sleep(chatCfg.delayBeforeNextQuestion);
      const s = getOrCreateState(chatId);
      if (!s.isActive) return;
      const sentMsg = await this.sendQuestionMessage(
        chatId,
        messageFormatter.formatQuestion(nextQ, s.currentQuestionIndex),
        nextQ.image,
      );
      s.lastQuestionMsgId = sentMsg?.id?._serialized || null;
      s.questionSentAt = Date.now();
      await this.startQuizInterval(chatId);
    } else {
      await utils.sleep(CONFIG.quiz.delayBeforeResults);
      await this.sendFinalResults(chatId);
      quizManager.stop(chatId);
    }
  },

  async sendFinalResults(chatId) {
    const state = getOrCreateState(chatId);
    const stats = quizManager.getStats(state);
    let finalMsg = `🏁 *Quiz Complete!*\n\n`;
    let winnerName = null;
    let winnerScore = 0;

    if (Object.keys(state.scoreBoard).length > 0) {
      const sorted = Object.entries(state.scoreBoard).sort(
        (a, b) => b[1].score - a[1].score,
      );
      const scoreboardText = await messageFormatter.formatScoreboard(
        state,
        true,
      );
      finalMsg += `*${CONFIG.messages.emojis.trophy} Final Scoreboard:*\n\n${scoreboardText}\n\n`;

      if (sorted.length > 0) {
        const [winnerId, winnerData] = sorted[0];
        const winnerInfo = await utils.getUserDisplayInfo(
          winnerId,
          winnerData.name,
        );
        const pct = Math.round(
          (winnerData.score / state.questions.length) * 100,
        );
        winnerName = winnerInfo.name;
        winnerScore = winnerData.score;
        finalMsg += `${CONFIG.messages.emojis.celebrate} Winner: ${winnerInfo.name}\n`;
        finalMsg += `Score: ${winnerData.score}/${state.questions.length} (${pct}%)\n\n`;
      }
    } else {
      finalMsg += `No scores recorded.\n\n`;
    }

    finalMsg += `⏱️ Duration: ${stats.duration}\nThanks for playing! 💚`;
    await client.sendMessage(chatId, finalMsg);

    // Save to quiz history
    await storage.addQuizHistory(chatId, {
      subject: state.startedSubject || state.subject,
      year: state.startedYear || state.year,
      date: new Date().toISOString(),
      questions: state.questions.length,
      participants: stats.participants,
      winner: winnerName,
      winnerScore,
      duration: stats.duration,
    });
  },

  async sendQuestionMessage(chatId, text, imgPath, replyToMsg = null) {
    try {
      const media = await utils.loadImage(imgPath);
      if (media)
        return await client.sendMessage(chatId, media, { caption: text });
      if (replyToMsg) return await replyToMsg.reply(text);
      return await client.sendMessage(chatId, text);
    } catch (e) {
      logger.error("sendQuestionMessage error:", e.message);
      try {
        return await client.sendMessage(chatId, text);
      } catch {}
    }
  },

  // ── ANSWER ───────────────────────────────────────────────────────
  // Users can re-answer freely until time is up. No warnings, no reply required.
  async handleAnswer(msg, answerLetter) {
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) return;
    try {
      const userId = permissions.getUserId(msg);
      const contact = await msg.getContact();
      const userName =
        contact.pushname || contact.name || contact.number || userId;
      // Always overwrite — last answer before time's up counts
      quizManager.updateScore(state, userId, userName, answerLetter);
    } catch (error) {
      logger.error("handleAnswer error:", error.message);
    }
  },

  // ── STOP QUIZ ────────────────────────────────────────────────────
  async handleStopQuiz(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators, Bot Admins, or the Owner can stop quizzes.",
      );
      return;
    }
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) {
      await msg.reply(`${emojis.warning} No active quiz in this chat.`);
      return;
    }
    const stats = quizManager.getStats(state);
    let stopMsg =
      `${emojis.stop} *Quiz Stopped*\n\n` +
      `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
      `Duration: ${stats.duration}\n\n`;
    stopMsg +=
      Object.keys(state.scoreBoard).length > 0
        ? `*Scores:*\n${await messageFormatter.formatScoreboard(state)}`
        : `No scores recorded.`;
    await msg.reply(stopMsg);
    quizManager.stop(chatId);
  },

  // ── SCORE ────────────────────────────────────────────────────────
  async handleScore(msg) {
    const { emojis } = CONFIG.messages;
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) {
      await msg.reply(
        `${emojis.warning} No active quiz.\n\nStart with ${CONFIG.bot.prefix}start [subject] [year]`,
      );
      return;
    }
    if (Object.keys(state.scoreBoard).length === 0) {
      await msg.reply(`${emojis.chart} *Scoreboard*\n\nNo answers yet!`);
      return;
    }
    const scoreboardText = await messageFormatter.formatScoreboard(state, true);
    await msg.reply(
      `${emojis.chart} *Scoreboard*\n\n${scoreboardText}\n\nQ: ${state.currentQuestionIndex + 1}/${state.questions.length}`,
    );
  },

  // ── STATS ────────────────────────────────────────────────────────
  async handleStats(msg) {
    const { emojis } = CONFIG.messages;
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) {
      await msg.reply(`${emojis.warning} No active quiz in this chat.`);
      return;
    }
    const stats = quizManager.getStats(state);
    await msg.reply(
      `${emojis.info} *Quiz Statistics*\n\n` +
        `Subject: ${state.subject?.toUpperCase()}\nYear: ${state.year}\n\n` +
        `Progress: ${stats.completedQuestions}/${stats.totalQuestions}\n` +
        `Remaining: ${stats.remainingQuestions}\n` +
        `Participants: ${stats.participants}\n` +
        `Duration: ${stats.duration}`,
    );
  },

  // ── SET INTERVAL ─────────────────────────────────────────────────
  async handleSetInterval(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators, Bot Admins, or the Owner can change quiz settings.",
      );
      return;
    }
    const seconds = parseInt(args[0]);
    if (isNaN(seconds) || seconds < 5 || seconds > 300) {
      await msg.reply(
        `${emojis.error} Provide seconds between 5 and 300.\nExample: ${CONFIG.bot.prefix}setinterval 30`,
      );
      return;
    }
    const chatId = msg.from;
    if (!storage.quizConfig[chatId]) storage.quizConfig[chatId] = {};
    storage.quizConfig[chatId].questionInterval = seconds * 1000;
    await storage.saveQuizConfig();
    await msg.reply(
      `${emojis.success} Question time set to *${seconds}s* for this chat.`,
    );
  },

  // ── SET DELAY ────────────────────────────────────────────────────
  async handleSetDelay(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators, Bot Admins, or the Owner can change quiz settings.",
      );
      return;
    }
    const seconds = parseInt(args[0]);
    if (isNaN(seconds) || seconds < 1 || seconds > 60) {
      await msg.reply(
        `${emojis.error} Provide seconds between 1 and 60.\nExample: ${CONFIG.bot.prefix}setdelay 5`,
      );
      return;
    }
    const chatId = msg.from;
    if (!storage.quizConfig[chatId]) storage.quizConfig[chatId] = {};
    storage.quizConfig[chatId].delayBeforeNextQuestion = seconds * 1000;
    await storage.saveQuizConfig();
    await msg.reply(
      `${emojis.success} Delay before next question set to *${seconds}s* for this chat.`,
    );
  },

  // ── SET MAX ───────────────────────────────────────────────────────
  async handleSetMax(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators, Bot Admins, or the Owner can change quiz settings.",
      );
      return;
    }
    const max = parseInt(args[0]);
    if (isNaN(max) || max < 1 || max > 200) {
      await msg.reply(
        `${emojis.error} Provide a number between 1 and 200.\nExample: ${CONFIG.bot.prefix}setmax 20`,
      );
      return;
    }
    const chatId = msg.from;
    if (!storage.quizConfig[chatId]) storage.quizConfig[chatId] = {};
    storage.quizConfig[chatId].maxQuestionsPerQuiz = max;
    await storage.saveQuizConfig();
    await msg.reply(
      `${emojis.success} Max questions per quiz set to *${max}* for this chat.`,
    );
  },

  // ── CHAT CONFIG ───────────────────────────────────────────────────
  async handleChatConfig(msg) {
    const { emojis } = CONFIG.messages;
    const chatId = msg.from;
    const cfg = storage.getQuizConfig(chatId);
    const disabled = storage.isChatDisabled(chatId);
    const globalDisabled = storage.isGloballyDisabled();
    await msg.reply(
      `${emojis.gear} *Config for this chat:*\n\n` +
        `🌐 Global status: ${globalDisabled ? "Disabled 🔴" : "Active 🟢"}\n` +
        `🔌 Chat status: ${disabled ? "Disabled 🔴" : "Active 🟢"}\n` +
        `${emojis.timer} Question time: ${utils.formatSeconds(cfg.questionInterval)}\n` +
        `⏳ Next Q delay: ${utils.formatSeconds(cfg.delayBeforeNextQuestion)}\n` +
        `📋 Max questions: ${cfg.maxQuestionsPerQuiz}\n\n` +
        `_Commands: ${CONFIG.bot.prefix}setinterval | ${CONFIG.bot.prefix}setdelay | ${CONFIG.bot.prefix}setmax_`,
    );
  },

  // ── ENABLE (per-chat, Bot Admin+) ─────────────────────────────────
  async handleEnable(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can enable the bot in this chat.",
      );
      return;
    }
    const chatId = msg.from;
    if (!storage.isChatDisabled(chatId)) {
      await msg.reply(`${emojis.warning} Bot is already enabled in this chat.`);
      return;
    }
    await storage.enableChat(chatId);
    logger.success(`Chat enabled: ${chatId} by ${permissions.getUserId(msg)}`);
    await msg.reply(`${emojis.success} Bot is now *enabled* in this chat.`);
  },

  // ── DISABLE (per-chat, Bot Admin+) ────────────────────────────────
  async handleDisable(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can disable the bot in this chat.",
      );
      return;
    }
    const chatId = msg.from;
    if (storage.isChatDisabled(chatId)) {
      await msg.reply(
        `${emojis.warning} Bot is already disabled in this chat.`,
      );
      return;
    }
    const state = getOrCreateState(chatId);
    if (state.isActive) {
      quizManager.stop(chatId);
      await client.sendMessage(
        chatId,
        `${emojis.stop} Active quiz stopped — bot is being disabled.`,
      );
    }
    await storage.disableChat(chatId);
    logger.info(`Chat disabled: ${chatId} by ${permissions.getUserId(msg)}`);
    await msg.reply(
      `${emojis.stop} Bot is now *disabled* in this chat.\n` +
        `Mods and users cannot use the bot here.\n` +
        `Bot Admins can still configure settings.\n` +
        `Use ${CONFIG.bot.prefix}enable to re-enable.`,
    );
  },

  // ── GLOBAL ENABLE (Owner only) ─────────────────────────────────────
  async handleGlobalEnable(msg) {
    const { emojis } = CONFIG.messages;
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can globally enable the bot.");
      return;
    }
    if (!storage.isGloballyDisabled()) {
      await msg.reply(`${emojis.warning} Bot is already globally enabled.`);
      return;
    }
    await storage.setGlobalDisabled(false);
    logger.success("Bot globally ENABLED");
    await msg.reply(
      `${emojis.success} Bot is now *globally enabled* across all chats. 🌐`,
    );
  },

  // ── GLOBAL DISABLE (Owner only) ─────────────────────────────────────
  async handleGlobalDisable(msg) {
    const { emojis } = CONFIG.messages;
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can globally disable the bot.");
      return;
    }
    if (storage.isGloballyDisabled()) {
      await msg.reply(`${emojis.warning} Bot is already globally disabled.`);
      return;
    }
    let stopped = 0;
    for (const [chatId, state] of activeQuizzes) {
      if (state.isActive) {
        quizManager.stop(chatId);
        stopped++;
        try {
          await client.sendMessage(
            chatId,
            `${emojis.stop} Quiz stopped — bot has been globally disabled by the Owner.`,
          );
        } catch {}
      }
    }
    await storage.setGlobalDisabled(true);
    logger.warn("Bot globally DISABLED");
    await msg.reply(
      `${emojis.stop} Bot is now *globally disabled*. 🌐\n` +
        `${stopped > 0 ? `Stopped ${stopped} active quiz(zes).\n` : ""}` +
        `Only you (Owner) can use the bot.\n` +
        `Use ${CONFIG.bot.prefix}genable to restore.`,
    );
  },

  // ── ADMIN MANAGEMENT (Bot Admin+) ─────────────────────────────────
  async handleAdmin(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply("⛔ Only Bot Admins or the Owner can manage Bot Admins.");
      return;
    }
    const [action, ...rest] = args;
    const chatId = msg.from;

    if (!action) {
      await msg.reply(
        `${emojis.shield} *Bot Admin Management*\n\n` +
          `• ${CONFIG.bot.prefix}admin add @user\n` +
          `• ${CONFIG.bot.prefix}admin remove @user\n` +
          `• ${CONFIG.bot.prefix}admin list`,
      );
      return;
    }

    if (action === "list") {
      const list = permissions.listBotAdmins(chatId);
      if (list.length === 0) {
        await msg.reply(
          `${emojis.info} No explicitly added Bot Admins in this chat.\n_Note: WhatsApp group admins are automatically Bot Admins._`,
        );
        return;
      }
      const lines = await Promise.all(
        list.map(async (id, i) => {
          const info = await utils.getUserDisplayInfo(id);
          return `${i + 1}. ${info.name}`;
        }),
      );
      await msg.reply(
        `${emojis.shield} *Bot Admins (${list.length}):*\n\n${lines.join("\n")}\n\n_WA group admins are also Bot Admins automatically._`,
      );
      return;
    }

    const targetId = this._resolveTarget(msg, rest);
    if (!targetId) {
      await msg.reply(
        `${emojis.error} Mention someone or provide a phone number.\nExample: ${CONFIG.bot.prefix}admin add @user`,
      );
      return;
    }
    if (CONFIG.bot.owners.includes(targetId)) {
      await msg.reply(`${emojis.warning} That user is already the Owner.`);
      return;
    }
    const targetInfo = await utils.getUserDisplayInfo(targetId);

    if (action === "add") {
      const added = await permissions.addBotAdmin(chatId, targetId);
      await msg.reply(
        added
          ? `${emojis.success} *${targetInfo.name}* is now a Bot Admin in this chat. 🛡️`
          : `${emojis.warning} *${targetInfo.name}* is already a Bot Admin here.`,
      );
    } else if (action === "remove") {
      const removed = await permissions.removeBotAdmin(chatId, targetId);
      await msg.reply(
        removed
          ? `${emojis.success} *${targetInfo.name}* removed as Bot Admin.`
          : `${emojis.warning} *${targetInfo.name}* is not an explicitly added Bot Admin here.`,
      );
    } else {
      await msg.reply(
        `${emojis.error} Unknown action: *${action}*\nUse: add / remove / list`,
      );
    }
  },

  // ── MOD MANAGEMENT (Bot Admin+) ────────────────────────────────────
  async handleMod(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply("⛔ Only Bot Admins or the Owner can manage Moderators.");
      return;
    }
    const [action, ...rest] = args;
    const chatId = msg.from;

    if (!action) {
      await msg.reply(
        `${emojis.star} *Moderator Management*\n\n` +
          `• ${CONFIG.bot.prefix}mod add @user\n` +
          `• ${CONFIG.bot.prefix}mod remove @user\n` +
          `• ${CONFIG.bot.prefix}mod list`,
      );
      return;
    }

    if (action === "list") {
      const list = permissions.listModerators(chatId);
      if (list.length === 0) {
        await msg.reply(`${emojis.info} No Moderators in this chat yet.`);
        return;
      }
      const lines = await Promise.all(
        list.map(async (id, i) => {
          const info = await utils.getUserDisplayInfo(id);
          return `${i + 1}. ${info.name}`;
        }),
      );
      await msg.reply(
        `${emojis.star} *Moderators (${list.length}):*\n\n${lines.join("\n")}`,
      );
      return;
    }

    const targetId = this._resolveTarget(msg, rest);
    if (!targetId) {
      await msg.reply(
        `${emojis.error} Mention someone or provide a phone number.\nExample: ${CONFIG.bot.prefix}mod add @user`,
      );
      return;
    }
    if (CONFIG.bot.owners.includes(targetId)) {
      await msg.reply(`${emojis.warning} That user is already the Owner.`);
      return;
    }
    const targetInfo = await utils.getUserDisplayInfo(targetId);

    if (action === "add") {
      const result = await permissions.addModerator(chatId, targetId);
      if (result === "already_admin") {
        await msg.reply(
          `${emojis.warning} *${targetInfo.name}* is already a Bot Admin — no need to add as Moderator.`,
        );
      } else {
        await msg.reply(
          result
            ? `${emojis.success} *${targetInfo.name}* is now a Moderator in this chat. ⭐`
            : `${emojis.warning} *${targetInfo.name}* is already a Moderator here.`,
        );
      }
    } else if (action === "remove") {
      const removed = await permissions.removeModerator(chatId, targetId);
      await msg.reply(
        removed
          ? `${emojis.success} *${targetInfo.name}* removed as Moderator.`
          : `${emojis.warning} *${targetInfo.name}* is not a Moderator in this chat.`,
      );
    } else {
      await msg.reply(
        `${emojis.error} Unknown action: *${action}*\nUse: add / remove / list`,
      );
    }
  },

  // ── ANNOUNCE (Bot Admin+) ─────────────────────────────────────────
  async handleAnnounce(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can make announcements.",
      );
      return;
    }
    const text = args.join(" ").trim();
    if (!text) {
      await msg.reply(
        `${emojis.error} Usage: ${CONFIG.bot.prefix}announce [message]`,
      );
      return;
    }
    await client.sendMessage(msg.from, `📢 *Announcement*\n\n${text}`);
  },

  // ── SET WELCOME (Bot Admin+) ──────────────────────────────────────
  async handleSetWelcome(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can set a welcome message.",
      );
      return;
    }
    const text = args.join(" ").trim();
    if (!text) {
      await msg.reply(
        `${emojis.error} Usage: ${CONFIG.bot.prefix}setwelcome [message]\nThis message will be sent when a quiz starts.`,
      );
      return;
    }
    await storage.setWelcomeMessage(msg.from, text);
    await msg.reply(
      `${emojis.success} Welcome message set! It will be sent at the start of each quiz.\n\n_Preview:_\n${text}`,
    );
  },

  // ── CLEAR WELCOME (Bot Admin+) ────────────────────────────────────
  async handleClearWelcome(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can clear the welcome message.",
      );
      return;
    }
    await storage.clearWelcomeMessage(msg.from);
    await msg.reply(`${emojis.success} Welcome message cleared.`);
  },

  // ── RESET CONFIG (Bot Admin+) ─────────────────────────────────────
  async handleResetConfig(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply("⛔ Only Bot Admins or the Owner can reset quiz config.");
      return;
    }
    await storage.resetQuizConfig(msg.from);
    await msg.reply(
      `${emojis.success} Quiz config for this chat has been reset to defaults.`,
    );
  },

  // ── QUIZ HISTORY (Bot Admin+) ─────────────────────────────────────
  async handleQuizHistory(msg) {
    const { emojis } = CONFIG.messages;
    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply("⛔ Only Bot Admins or the Owner can view quiz history.");
      return;
    }
    const chatId = msg.from;
    const history = storage.getQuizHistory(chatId);
    if (history.length === 0) {
      await msg.reply(`${emojis.info} No quiz history for this chat yet.`);
      return;
    }
    const lines = history.slice(0, 10).map((h, i) => {
      const date = new Date(h.date).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      const winner = h.winner
        ? `🥇 ${h.winner} (${h.winnerScore}pts)`
        : "No winner";
      return `${i + 1}. *${h.subject?.toUpperCase()} ${h.year}* — ${date}\n   ${h.questions}Qs | ${h.participants} players | ${winner} | ⏱️ ${h.duration}`;
    });
    await msg.reply(
      `${emojis.chart} *Quiz History (last ${lines.length}):*\n\n${lines.join("\n\n")}`,
    );
  },

  // ── BROADCAST (Owner only) ────────────────────────────────────────
  async handleBroadcast(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can broadcast messages.");
      return;
    }
    const text = args.join(" ").trim();
    if (!text) {
      await msg.reply(
        `${emojis.error} Usage: ${CONFIG.bot.prefix}broadcast [message]`,
      );
      return;
    }

    const activeChats = [...activeQuizzes.keys()];
    if (activeChats.length === 0) {
      await msg.reply(`${emojis.warning} No active chats to broadcast to.`);
      return;
    }

    let sent = 0;
    for (const chatId of activeChats) {
      try {
        await client.sendMessage(chatId, `📢 *Owner Broadcast*\n\n${text}`);
        sent++;
      } catch {
        /* skip failed sends */
      }
    }
    await msg.reply(
      `${emojis.success} Broadcast sent to ${sent} active chat(s).`,
    );
  },

  // ── CHATS (Owner only) ────────────────────────────────────────────
  async handleChats(msg) {
    const { emojis } = CONFIG.messages;
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can view all chats.");
      return;
    }

    const activeList = [...activeQuizzes.entries()].filter(
      ([, s]) => s.isActive,
    );
    const disabledChats = storage.permissions.disabledChats;

    let text = `${emojis.chart} *Bot Chat Overview*\n\n`;
    text += `🟢 Active quizzes: ${activeList.length}\n`;
    text += `🔴 Disabled chats: ${disabledChats.length}\n`;
    text += `🌐 Global status: ${storage.isGloballyDisabled() ? "DISABLED 🔴" : "Active 🟢"}\n\n`;

    if (activeList.length > 0) {
      text += `*Active Quizzes:*\n`;
      activeList.forEach(([chatId, s], i) => {
        text += `${i + 1}. ${chatId}\n   ${s.subject?.toUpperCase()} ${s.year} — Q${s.currentQuestionIndex + 1}/${s.questions.length}\n`;
      });
    }

    if (disabledChats.length > 0) {
      text += `\n*Disabled Chats:*\n`;
      disabledChats.forEach((id, i) => {
        text += `${i + 1}. ${id}\n`;
      });
    }

    await msg.reply(text);
  },

  // ── ALL STAFF (Owner only) ────────────────────────────────────────
  async handleAllStaff(msg) {
    const { emojis } = CONFIG.messages;
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can view all staff.");
      return;
    }

    const { botAdmins, moderators } = storage.permissions;
    const allChatIds = new Set([
      ...Object.keys(botAdmins),
      ...Object.keys(moderators),
    ]);

    if (allChatIds.size === 0) {
      await msg.reply(`${emojis.info} No staff assigned in any chat yet.`);
      return;
    }

    let text = `${emojis.shield} *All Staff Across Chats*\n\n`;
    for (const chatId of allChatIds) {
      const admins = botAdmins[chatId] || [];
      const mods = moderators[chatId] || [];
      if (admins.length === 0 && mods.length === 0) continue;

      text += `*Chat:* ${chatId}\n`;
      if (admins.length > 0) {
        const adminNames = await Promise.all(
          admins.map(async (id) => {
            const info = await utils.getUserDisplayInfo(id);
            return info.name;
          }),
        );
        text += `  🛡️ Admins: ${adminNames.join(", ")}\n`;
      }
      if (mods.length > 0) {
        const modNames = await Promise.all(
          mods.map(async (id) => {
            const info = await utils.getUserDisplayInfo(id);
            return info.name;
          }),
        );
        text += `  ⭐ Mods: ${modNames.join(", ")}\n`;
      }
      text += "\n";
    }
    await msg.reply(text.trim());
  },

  // ── CLEAR STAFF (Owner only) ──────────────────────────────────────
  async handleClearStaff(msg, args) {
    const { emojis } = CONFIG.messages;
    if (!permissions.isOwner(msg)) {
      await msg.reply("⛔ Only the Owner can clear staff.");
      return;
    }
    const chatId = msg.from;
    await storage.clearBotAdmins(chatId);
    await storage.clearModerators(chatId);
    logger.warn(`All staff cleared in ${chatId} by Owner`);
    await msg.reply(
      `${emojis.success} All Bot Admins and Moderators cleared for this chat.`,
    );
  },

  // ── INTERNAL: resolve @mention or phone to userId ─────────────────
  _resolveTarget(msg, rest) {
    if (msg.mentionedIds && msg.mentionedIds.length > 0)
      return msg.mentionedIds[0];
    if (rest && rest.length > 0) return utils.normalizePhone(rest[0]);
    return null;
  },
};

module.exports = commandHandler;
