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
const aiService = require("./Aiservice"); // V3

// ==========================================
// 🎮 COMMAND HANDLER — v3.0.0
// ==========================================

// ── Browser crash detection ───────────────────────────────────────
function isBrowserError(error) {
  const msg = error?.message || "";
  return (
    msg.includes("Target closed") ||
    msg.includes("detached Frame") ||
    msg.includes("Session closed") ||
    msg.includes("Protocol error") ||
    msg.includes("Execution context was destroyed") ||
    msg.includes("Cannot find context")
  );
}

// ── Safe send — never throws on browser crash ─────────────────────
async function safeSend(chatId, text) {
  try {
    return await client.sendMessage(chatId, text);
  } catch (e) {
    if (!isBrowserError(e)) logger.error("safeSend error:", e.message);
    return null;
  }
}

// ── V3: Detect private (DM) vs group chat ────────────────────────
function isPrivateChat(chatId) {
  // Group chats end with @g.us, private chats end with @c.us or @lid
  return chatId.endsWith("@c.us") || chatId.endsWith("@lid");
}

const commandHandler = {
  async handle(msg) {
    try {
      const { prefix } = CONFIG.bot;
      const body = msg.body || "";
      const trimmed = body.trim();
      const chatId = msg.from;
      const isOwner = permissions.isOwner(msg);
      const isBotAdmin = await permissions.isBotAdmin(msg);
      const isDM = isPrivateChat(chatId);

      // ── Global disable: only Owner can act ───────────────────────
      if (storage.isGloballyDisabled() && !isOwner) return;

      // ── Per-chat disable check ────────────────────────────────────
      const chatDisabled = storage.isChatDisabled(chatId);

      // ── Quiz answer detection (A/B/C/D) ──────────────────────────
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
      // Preserve original casing for AI chat text
      const rawArgs = trimmed
        .replace(new RegExp(`^\\${prefix}\\s*\\S+\\s*`), "")
        .trim();

      // ── Commands that always work (even when chat is disabled) ────
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
        // V3 additions that should always be available:
        "ai",
        "daily",
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
          "genq", // V3
        ]);
        if (blockedWhenDisabled.has(cmd)) {
          await msg.reply(
            `${CONFIG.messages.emojis.warning} The bot is disabled in this chat. Use ${prefix}enable to re-enable.`,
          );
          return;
        }
      }

      switch (cmd) {
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

        // ── V3: New commands ────────────────────────────────────────
        case "ai":
          return await this.handleAiChat(msg, rawArgs);
        case "genq":
          return await this.handleGenerateQuestions(msg, argParts);
        case "daily":
          return await this.handleDailyToggle(msg);

        default:
          break;
      }
    } catch (error) {
      if (isBrowserError(error)) {
        logger.warn(
          `Browser error in handle() for ${msg?.from}: ${error.message}`,
        );
        return;
      }
      logger.error("Command error:", error);
      try {
        await msg.reply(
          `${CONFIG.messages.emojis.error} An unexpected error occurred.`,
        );
      } catch {}
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // V3: AI CHAT — .ai [question or topic]
  // Works in both groups and DMs
  // ─────────────────────────────────────────────────────────────────
  async handleAiChat(msg, text) {
    const { emojis } = CONFIG.messages;

    if (!CONFIG.ai.features.aiChat) {
      await msg.reply(`${emojis.ai} AI chat is currently disabled.`);
      return;
    }
    if (!CONFIG.ai.apiKey) {
      await msg.reply(
        `${emojis.ai} AI is not configured yet. Ask the owner to set XAI_API_KEY.`,
      );
      return;
    }
    if (!text || text.length < 2) {
      await msg.reply(
        `${emojis.ai} *AI Assistant*\n\nUsage: ${CONFIG.bot.prefix}ai [your question]\n\n` +
          `Example: _${CONFIG.bot.prefix}ai explain osmosis_`,
      );
      return;
    }
    if (text.length > 500) {
      await msg.reply(
        `${emojis.warning} Message too long. Keep it under 500 characters.`,
      );
      return;
    }

    // Show typing indicator by sending a placeholder first
    const thinking = await msg.reply(`${emojis.ai} _Thinking..._`);

    try {
      const response = await aiService.freeChat(text);
      if (!response) {
        await thinking.edit(
          `${emojis.error} AI is unavailable right now. Try again later.`,
        );
        return;
      }
      await thinking.edit(`${emojis.ai} *AI Answer*\n\n${response}`);
    } catch (e) {
      logger.error("handleAiChat error:", e.message);
      try {
        await thinking.edit(`${emojis.error} AI request failed.`);
      } catch {}
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // V3: GENERATE QUESTIONS — .genq [subject] [topic] [count?]
  // Admin only — generates questions via AI and saves to a temp file
  // ─────────────────────────────────────────────────────────────────
  async handleGenerateQuestions(msg, args) {
    const { emojis } = CONFIG.messages;

    if (!(await permissions.isBotAdmin(msg))) {
      await msg.reply(
        "⛔ Only Bot Admins or the Owner can generate questions.",
      );
      return;
    }
    if (!CONFIG.ai.features.generateQuestions) {
      await msg.reply(`${emojis.ai} Question generation is disabled.`);
      return;
    }
    if (!CONFIG.ai.apiKey) {
      await msg.reply(`${emojis.ai} AI is not configured. Set XAI_API_KEY.`);
      return;
    }
    if (args.length < 2) {
      await msg.reply(
        `${emojis.error} Usage: ${CONFIG.bot.prefix}genq [subject] [topic] [count]\n\n` +
          `Example: _${CONFIG.bot.prefix}genq biology cell division 5_\n` +
          `Count is optional (default: 5, max: 10)`,
      );
      return;
    }

    const subject = args[0];
    const countArg = parseInt(args[args.length - 1]);
    const hasCount = !isNaN(countArg) && countArg > 0;
    const count = Math.min(hasCount ? countArg : 5, 10);
    const topic = hasCount
      ? args.slice(1, -1).join(" ")
      : args.slice(1).join(" ");

    if (!topic) {
      await msg.reply(`${emojis.error} Please provide a topic.`);
      return;
    }

    const status = await msg.reply(
      `${emojis.ai} Generating ${count} questions on *${topic}* (${subject})...\n_This may take 10-15 seconds._`,
    );

    try {
      const questions = await aiService.generateQuestions(
        subject,
        topic,
        count,
      );

      if (!questions || questions.length === 0) {
        await status.edit(
          `${emojis.error} Failed to generate questions. Try a more specific topic.`,
        );
        return;
      }

      // Format preview for the admin
      const preview = questions
        .slice(0, 3)
        .map((q, i) => {
          const opts = q.options
            .map((o, j) => `${utils.indexToLetter(j)}. ${o}`)
            .join("\n");
          const answer = utils.indexToLetter(q.answer_index);
          return `*Q${i + 1}.* ${q.question}\n${opts}\n✅ Answer: ${answer}`;
        })
        .join("\n\n");

      const moreText =
        questions.length > 3
          ? `\n\n_...and ${questions.length - 3} more question(s)_`
          : "";

      await status.edit(
        `${emojis.ai} *Generated ${questions.length} questions for ${subject.toUpperCase()} — "${topic}"*\n\n` +
          `${preview}${moreText}\n\n` +
          `💾 To use these in a quiz, reply with *yes* within 30s to save, or ignore to discard.`,
      );

      // Wait for admin to confirm save
      const filter = (response) =>
        response.from === msg.from &&
        (response.author === permissions.getUserId(msg) ||
          response.from === permissions.getUserId(msg)) &&
        response.body?.trim().toLowerCase() === "yes";

      const collected = await this._waitForReply(
        msg.from,
        permissions.getUserId(msg),
        30000,
      );

      if (!collected) {
        await safeSend(
          msg.from,
          `${emojis.info} Questions discarded (no confirmation).`,
        );
        return;
      }

      // Save to a generated questions file
      const fs = require("fs").promises;
      const path = require("path");
      const timestamp = Date.now();
      const filename = `ai_${subject}_${timestamp}.json`;
      const filePath = path.join(CONFIG.data.dataDirectory, subject, filename);

      const fileData = {
        paper_type: "AI_GENERATED",
        topic,
        generated_at: new Date().toISOString(),
        questions,
      };

      await fs.mkdir(path.join(CONFIG.data.dataDirectory, subject), {
        recursive: true,
      });
      await fs.writeFile(filePath, JSON.stringify(fileData, null, 2), "utf-8");

      await safeSend(
        msg.from,
        `${emojis.success} Saved ${questions.length} questions!\n` +
          `📁 File: \`${filename}\`\n` +
          `▶️ Use: _${CONFIG.bot.prefix}start ${subject} ai_${subject}_${timestamp}_`,
      );
    } catch (e) {
      logger.error("handleGenerateQuestions error:", e.message);
      try {
        await status.edit(
          `${emojis.error} Question generation failed: ${e.message}`,
        );
      } catch {}
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // V3: DAILY QUESTION TOGGLE — .daily
  // Mods can subscribe/unsubscribe their chat to daily practice questions
  // ─────────────────────────────────────────────────────────────────
  async handleDailyToggle(msg) {
    const { emojis } = CONFIG.messages;

    if (!(await permissions.isModerator(msg))) {
      await msg.reply(
        "⛔ Only Moderators or above can toggle daily questions.",
      );
      return;
    }

    const chatId = msg.from;
    const dailyChats = await this._loadDailyChats();

    if (dailyChats.includes(chatId)) {
      const updated = dailyChats.filter((id) => id !== chatId);
      await this._saveDailyChats(updated);
      await msg.reply(
        `${emojis.daily} *Daily questions disabled* for this chat.\n` +
          `Use ${CONFIG.bot.prefix}daily again to re-enable.`,
      );
    } else {
      dailyChats.push(chatId);
      await this._saveDailyChats(dailyChats);
      await msg.reply(
        `${emojis.daily} *Daily questions enabled!* 🎉\n` +
          `You'll receive a practice question every day at ${CONFIG.daily.hour}:00 WAT.\n\n` +
          `_${CONFIG.bot.prefix}daily again to disable._`,
      );
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // V3: SEND DAILY QUESTION — called by the scheduler in index.js
  // ─────────────────────────────────────────────────────────────────
  async sendDailyQuestion(chatId) {
    try {
      const subjects = await dataManager.getAvailableSubjects();
      if (subjects.length === 0) return;

      // Pick a random subject + year
      const subject = subjects[Math.floor(Math.random() * subjects.length)];
      const years = await dataManager.getAvailableYears(subject);
      if (years.length === 0) return;
      const year = years[Math.floor(Math.random() * years.length)];

      const result = await dataManager.getRandomQuestion(subject, year);
      if (!result) return;

      const { question } = result;
      const text =
        `${CONFIG.messages.emojis.daily} *Daily Practice Question*\n` +
        `📖 ${subject.toUpperCase()} ${year}\n\n` +
        messageFormatter.formatQuestion({ ...question, year }, 0) +
        `\n\n_Reply A, B, C, or D — answer revealed in 5 minutes!_`;

      const sent = await safeSend(chatId, text);
      if (!sent) return;

      // V3: Optional AI hint
      if (CONFIG.ai.features.dailyQuestion && CONFIG.ai.apiKey) {
        const hint = await aiService.generateDailyHint(
          question.question,
          subject,
        );
        if (hint) {
          await utils.sleep(3000);
          await safeSend(chatId, `💡 *Hint:* ${hint}`);
        }
      }

      // Reveal answer after 5 minutes
      await utils.sleep(5 * 60 * 1000);

      const answer = utils.indexToLetter(question.answer_index);
      let revealText =
        `${CONFIG.messages.emojis.success} *Daily Answer: ${answer}*\n\n` +
        `${question.explanation || "No explanation available."}`;

      // V3: Enhanced explanation from AI
      if (CONFIG.ai.features.answerExplanation && CONFIG.ai.apiKey) {
        const correctOption = question.options[question.answer_index];
        const aiExplain = await aiService.explainAnswer(
          question.question,
          `${answer}. ${correctOption}`,
          subject,
          year,
        );
        if (aiExplain) {
          revealText += `\n\n${CONFIG.messages.emojis.ai} *AI Insight:* ${aiExplain}`;
        }
      }

      await safeSend(chatId, revealText);
      logger.info(`Daily question sent to ${chatId} (${subject} ${year})`);
    } catch (e) {
      logger.error(`sendDailyQuestion error for ${chatId}:`, e.message);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // V3: AI-ENHANCED processQuestionEnd
  // Adds optional AI explanation after the standard explanation
  // ─────────────────────────────────────────────────────────────────
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

    const sent = await safeSend(chatId, resultsMsg);
    if (!sent) {
      logger.warn(
        `processQuestionEnd: failed to send results in ${chatId}, stopping quiz.`,
      );
      quizManager.stop(chatId);
      return;
    }

    // V3: AI-enhanced explanation (non-blocking, best-effort)
    if (CONFIG.ai.features.answerExplanation && CONFIG.ai.apiKey) {
      const currentQ = quizManager.getCurrentQuestion(state);
      if (currentQ) {
        // Fire and forget — don't let AI failure stop the quiz
        aiService
          .explainAnswer(
            currentQ.question,
            `${correctAnswer}. ${currentQ.options[currentQ.answer_index]}`,
            state.subject,
            state.year,
          )
          .then((explanation) => {
            if (explanation) {
              safeSend(chatId, `${emojis.ai} *AI Insight:* ${explanation}`);
            }
          })
          .catch((e) => logger.warn("AI explanation error:", e.message));
      }
    }

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
      if (!sentMsg) {
        logger.warn(
          `processQuestionEnd: failed to send question in ${chatId}, stopping quiz.`,
        );
        quizManager.stop(chatId);
        return;
      }
      s.lastQuestionMsgId = sentMsg?.id?._serialized || null;
      s.questionSentAt = Date.now();
      await this.startQuizInterval(chatId);
    } else {
      await utils.sleep(CONFIG.quiz.delayBeforeResults);
      await this.sendFinalResults(chatId);
      quizManager.stop(chatId);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────────

  // V3: Wait for a specific user to reply with a given text
  async _waitForReply(chatId, userId, timeoutMs) {
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
  },

  // V3: Load daily chats list from disk
  async _loadDailyChats() {
    const fs = require("fs").promises;
    try {
      const raw = await fs.readFile("./data/daily_chats.json", "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  // V3: Save daily chats list to disk
  async _saveDailyChats(chats) {
    const fs = require("fs").promises;
    await fs.mkdir("./data", { recursive: true });
    await fs.writeFile(
      "./data/daily_chats.json",
      JSON.stringify(chats, null, 2),
      "utf-8",
    );
  },

  // ─────────────────────────────────────────────────────────────────
  // ALL ORIGINAL METHODS BELOW — unchanged from v2
  // ─────────────────────────────────────────────────────────────────

  async handlePing(msg) {
    const t = Date.now();
    const reply = await msg.reply(`${CONFIG.messages.emojis.info} Pong!`);
    await reply.edit(
      `${CONFIG.messages.emojis.success} Pong! _(${Date.now() - t}ms)_`,
    );
  },

  async handleHelp(msg) {
    await msg.reply(await messageFormatter.formatHelp(msg.from, msg));
  },

  async handleMyRole(msg) {
    const role = await permissions.getRoleName(msg);
    await msg.reply(
      `${CONFIG.messages.emojis.info} Your role in this chat: *${role}*`,
    );
  },

  async handleSubjects(msg) {
    const subjects = await dataManager.getAvailableSubjects();
    await msg.reply(
      `${CONFIG.messages.emojis.book} *Available Subjects:*\n\n` +
        subjects.map((s) => `• ${s.toUpperCase()}`).join("\n"),
    );
  },

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

    const welcome = storage.getWelcomeMessage(chatId);
    if (welcome) await safeSend(chatId, welcome);

    await utils.sleep(chatCfg.delayBeforeFirstQuestion);
    const s = getOrCreateState(chatId);
    if (!s.isActive) return;

    const firstQ = quizManager.getCurrentQuestion(s);
    if (!firstQ) return;

    const sentMsg = await this.sendQuestionMessage(
      chatId,
      messageFormatter.formatQuestion(firstQ, 0),
      firstQ.image,
    );
    s.lastQuestionMsgId = sentMsg?.id?._serialized || null;
    s.questionSentAt = Date.now();
    s.startedSubject = subject;
    s.startedYear = year;

    await this.startQuizInterval(chatId);
  },

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
        if (isBrowserError(error)) {
          logger.warn(
            `Browser disconnected during quiz in ${chatId} — stopping quiz.`,
          );
          const s = getOrCreateState(chatId);
          if (s.interval) {
            clearInterval(s.interval);
            s.interval = null;
          }
          quizManager.stop(chatId);
        } else {
          logger.error(`Quiz interval error [${chatId}]:`, error.message);
        }
      }
    }, 1000);
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
    await safeSend(chatId, finalMsg);

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
      if (media) {
        try {
          return await client.sendMessage(chatId, media, { caption: text });
        } catch (e) {
          if (isBrowserError(e)) return null;
        }
      }
      if (replyToMsg) {
        try {
          return await replyToMsg.reply(text);
        } catch (e) {
          if (isBrowserError(e)) return null;
        }
      }
      return await client.sendMessage(chatId, text);
    } catch (e) {
      if (isBrowserError(e)) return null;
      logger.error("sendQuestionMessage error:", e.message);
      try {
        return await client.sendMessage(chatId, text);
      } catch {}
      return null;
    }
  },

  async handleAnswer(msg, answerLetter) {
    const chatId = msg.from;
    const state = getOrCreateState(chatId);
    if (!state.isActive) return;
    try {
      const userId = permissions.getUserId(msg);
      const contact = await msg.getContact();
      const userName =
        contact.pushname || contact.name || contact.number || userId;
      quizManager.updateScore(state, userId, userName, answerLetter);
    } catch (error) {
      if (isBrowserError(error)) return;
      logger.error("handleAnswer error:", error.message);
    }
  },

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
        `📋 Max questions: ${cfg.maxQuestionsPerQuiz}\n` +
        `${emojis.ai} AI features: ${CONFIG.ai.apiKey ? "🟢 On" : "🔴 Off (no API key)"}\n\n` +
        `_Commands: ${CONFIG.bot.prefix}setinterval | ${CONFIG.bot.prefix}setdelay | ${CONFIG.bot.prefix}setmax_`,
    );
  },

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
      await safeSend(
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
          await safeSend(
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
    await safeSend(msg.from, `📢 *Announcement*\n\n${text}`);
  },

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
      const result = await safeSend(chatId, `📢 *Owner Broadcast*\n\n${text}`);
      if (result) sent++;
    }
    await msg.reply(
      `${emojis.success} Broadcast sent to ${sent} active chat(s).`,
    );
  },

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
          admins.map(async (id) => (await utils.getUserDisplayInfo(id)).name),
        );
        text += `  🛡️ Admins: ${adminNames.join(", ")}\n`;
      }
      if (mods.length > 0) {
        const modNames = await Promise.all(
          mods.map(async (id) => (await utils.getUserDisplayInfo(id)).name),
        );
        text += `  ⭐ Mods: ${modNames.join(", ")}\n`;
      }
      text += "\n";
    }
    await msg.reply(text.trim());
  },

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

  _resolveTarget(msg, rest) {
    if (msg.mentionedIds && msg.mentionedIds.length > 0)
      return msg.mentionedIds[0];
    if (rest && rest.length > 0) return utils.normalizePhone(rest[0]);
    return null;
  },
};

module.exports = commandHandler;
