const { Client, LocalAuth } = require("whatsapp-web.js");
const CONFIG = require("./config");

// ==========================================
// 🤖 WHATSAPP CLIENT (singleton)
// ==========================================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: CONFIG.client.chromePath,
    headless: CONFIG.client.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
    ],
  },
  webVersionCache: { type: "none" },
});

module.exports = client;
