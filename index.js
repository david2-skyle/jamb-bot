require("dotenv").config();
const qrcode = require("qrcode-terminal");
const qrcodeLib = require("qrcode");
const http = require("http");
const https = require("https");
const CONFIG = require("./config");
const logger = require("./logger");
const storage = require("./storage");
const utils = require("./utils");
const quizManager = require("./quizManager");
const commandHandler = require("./commandHandler");
const dataManager = require("./dataManager");
const { activeQuizzes } = require("./state");
const client = require("./client");
const apiServer = require("./api-server");

utils.setClient(client);

let currentQR = null;
let isAuthenticated = false;

// ── QR / health HTTP server ───────────────────────────────────────
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
    } catch {
      res.writeHead(500);
      res.end("Error generating QR");
    }
    return;
  }

  if (req.url === "/health") {
    const mem = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      authenticated: isAuthenticated,
      version: CONFIG.bot.version,
      ai: !!CONFIG.ai.apiKey,
      activeQuizzes: activeQuizzes.size,
      contactCache: utils.contactCache.size(),
      questionCache: dataManager._questionCache.size(),
      uptime: process.uptime(),
      memory: {
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
        heap: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      },
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`QR server running on port ${PORT}`));

// ── Render keep-alive (with abort on shutdown) ────────────────────
let keepAliveTimer = null;
if (process.env.RENDER_EXTERNAL_URL) {
  const keepAliveUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
  keepAliveTimer = setInterval(() => {
    https.get(keepAliveUrl, (res) => {
      res.resume(); // consume response body so socket is released
      logger.debug(`Keep-alive ping: ${res.statusCode}`);
    }).on("error", (e) => {
      logger.warn("Keep-alive ping failed:", e.message);
    });
  }, 10 * 60 * 1_000);
  if (keepAliveTimer.unref) keepAliveTimer.unref();
  logger.info(`Keep-alive enabled → ${keepAliveUrl}`);
}

// ── Periodic memory log (helps spot leaks early) ──────────────────
const memTimer = setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (mb > 400) logger.warn(`[Memory] RSS ${mb}MB — approaching limit`);
  else logger.debug(`[Memory] RSS ${mb}MB`);
}, 5 * 60 * 1_000);
if (memTimer.unref) memTimer.unref();

// ── WhatsApp client events ────────────────────────────────────────
client.on("qr", (qr) => {
  currentQR = qr;
  isAuthenticated = false;
  qrcode.generate(qr, { small: true });
  logger.info("QR code ready — visit your Railway URL to scan it");
});

client.on("ready", () => {
  isAuthenticated = true;
  currentQR = null;
  logger.success(`${CONFIG.bot.name} v${CONFIG.bot.version} is ready!`);
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

// ── Startup ───────────────────────────────────────────────────────
async function initializeBot() {
  logger.info(`Starting ${CONFIG.bot.name} v${CONFIG.bot.version}...`);
  await storage.load();

  logger.info(`Prefix:  ${CONFIG.bot.prefix}`);
  logger.info(`Owners:  ${CONFIG.bot.owners.length}`);
  logger.info(`AI:      ${CONFIG.ai.apiKey ? `enabled (${CONFIG.ai.model})` : "disabled (no GROQ_API_KEY)"}`);

  const adminCount = Object.values(storage.permissions.botAdmins).reduce((s, a) => s + a.length, 0);
  const modCount   = Object.values(storage.permissions.moderators).reduce((s, a) => s + a.length, 0);
  logger.info(`Bot Admins: ${adminCount} | Moderators: ${modCount}`);

  if (storage.permissions.disabledChats.length > 0)
    logger.warn(`Disabled chats: ${storage.permissions.disabledChats.length}`);
  if (storage.isGloballyDisabled())
    logger.warn("⚠️  Bot is GLOBALLY DISABLED — only Owner can use it");

  apiServer.init({ activeQuizzes, storage, commandHandler, dataManager, server });

  logger.info("Starting WhatsApp client...");
  client.initialize();
}

// ── Graceful shutdown ─────────────────────────────────────────────
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  clearInterval(memTimer);
  for (const [chatId] of activeQuizzes) quizManager.stop(chatId);
  try { await client.destroy(); } catch { }
  server.close();
  process.exit(0);
}

process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason?.stack || reason?.message || reason);
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error?.stack || error?.message || error);
  // Don't exit — let Railway restart if truly fatal
});

initializeBot();