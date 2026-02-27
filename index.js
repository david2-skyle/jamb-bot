require("dotenv").config();
const qrcode = require("qrcode-terminal");
const qrcodeLib = require("qrcode");
const http = require("http");
const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const quizManager = require("./quizManager");
const commandHandler = require("./commandHandler");
const dataManager = require("./dataManager"); // ← ADD THIS
const { activeQuizzes } = require("./state");
const client = require("./client");
const apiServer = require("./api-server");

utils.setClient(client);

let currentQR = null;
let isAuthenticated = false;

const server = http.createServer(async (req, res) => {
  if (req.url === "/qr" || req.url === "/") {
    if (isAuthenticated) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>✅ Bot is authenticated and running!</h2>
          <p>No QR code needed — WhatsApp session is active.</p>
        </body></html>
      `);
      return;
    }
    if (!currentQR) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>⏳ Waiting for QR code...</h2>
          <p>Refresh this page in a few seconds.</p>
          <script>setTimeout(() => location.reload(), 3000);</script>
        </body></html>
      `);
      return;
    }
    try {
      const qrImage = await qrcodeLib.toDataURL(currentQR);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>📱 Scan this QR code with WhatsApp</h2>
          <p>Open WhatsApp → Linked Devices → Link a Device</p>
          <img src="${qrImage}" style="width:300px;height:300px" />
          <p><small>Page auto-refreshes every 20s if needed</small></p>
          <script>setTimeout(() => location.reload(), 20000);</script>
        </body></html>
      `);
    } catch (e) {
      res.writeHead(500);
      res.end("Error generating QR");
    }
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        authenticated: isAuthenticated,
        version: CONFIG.bot.version,
        ai: !!CONFIG.ai.apiKey,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`QR server running on port ${PORT}`));

client.on("qr", (qr) => {
  currentQR = qr;
  isAuthenticated = false;
  qrcode.generate(qr, { small: true });
  logger.info(`QR code ready — visit your Railway URL to scan it`);
});

client.on("ready", () => {
  isAuthenticated = true;
  currentQR = null;
  logger.success(`${CONFIG.bot.name} v${CONFIG.bot.version} is ready!`);
  startDailyScheduler();
  // ← REMOVED apiServer.init() from here
});

client.on("authenticated", () => {
  isAuthenticated = true;
  logger.success("Authenticated");
});

client.on("auth_failure", (msg) => {
  isAuthenticated = false;
  logger.error("Auth failure:", msg);
});

client.on("disconnected", (reason) => {
  isAuthenticated = false;
  logger.warn("Disconnected:", reason);
  for (const [chatId] of activeQuizzes) quizManager.stop(chatId);
});

client.on("message_create", async (msg) => {
  await commandHandler.handle(msg);
});

let _lastFiredDate = null;

function startDailyScheduler() {
  if (!CONFIG.ai.features.dailyQuestion) {
    logger.info("Daily question scheduler: disabled via config");
    return;
  }
  logger.info(
    `Daily question scheduler started (fires at ${CONFIG.daily.hour}:00 WAT)`,
  );
  setInterval(async () => {
    try {
      const now = new Date(Date.now() + 60 * 60 * 1000);
      const todayStr = now.toISOString().slice(0, 10);
      const currentHour = now.getUTCHours();
      if (currentHour === CONFIG.daily.hour && _lastFiredDate !== todayStr) {
        _lastFiredDate = todayStr;
        await fireDailyQuestions();
      }
    } catch (e) {
      logger.error("Daily scheduler error:", e.message);
    }
  }, 60 * 1000);
}

async function fireDailyQuestions() {
  if (!isAuthenticated) {
    logger.warn("Daily: bot not authenticated, skipping");
    return;
  }
  const dailyChats = await commandHandler._loadDailyChats();
  if (dailyChats.length === 0) return;
  logger.info(`Daily: sending questions to ${dailyChats.length} chat(s)`);
  for (const chatId of dailyChats) {
    await utils.sleep(2000);
    await commandHandler.sendDailyQuestion(chatId);
  }
}

async function initializeBot() {
  logger.info(`Starting ${CONFIG.bot.name} v${CONFIG.bot.version}...`);
  await storage.load();

  logger.info(`Prefix: ${CONFIG.bot.prefix}`);
  logger.info(`Owners: ${CONFIG.bot.owners.length}`);
  logger.info(
    `AI: ${CONFIG.ai.apiKey ? `enabled (${CONFIG.ai.model})` : "disabled (no XAI_API_KEY)"}`,
  );

  const adminCount = Object.values(storage.permissions.botAdmins).flat().length;
  const modCount = Object.values(storage.permissions.moderators).flat().length;
  const disabledCount = storage.permissions.disabledChats.length;

  logger.info(
    `Bot Admins: ${adminCount} across ${Object.keys(storage.permissions.botAdmins).length} chat(s)`,
  );
  logger.info(
    `Moderators: ${modCount} across ${Object.keys(storage.permissions.moderators).length} chat(s)`,
  );
  if (disabledCount > 0) logger.warn(`Disabled chats: ${disabledCount}`);
  if (storage.isGloballyDisabled())
    logger.warn("⚠️  Bot is GLOBALLY DISABLED — only Owner can use it");

  // ✅ Start API server immediately — before WhatsApp authenticates
  apiServer.init({ activeQuizzes, storage, commandHandler, dataManager });

  logger.info("Starting WhatsApp client...");
  client.initialize();
}

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  for (const [chatId] of activeQuizzes) quizManager.stop(chatId);
  try {
    await client.destroy();
  } catch {}
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("unhandledRejection", (error) =>
  logger.error("Unhandled rejection:", error?.message || error),
);
process.on("uncaughtException", (error) =>
  logger.error("Uncaught exception:", error?.message || error),
);

initializeBot();
