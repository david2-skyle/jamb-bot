const { Client, LocalAuth } = require("whatsapp-web.js");
const CONFIG = require("./config");

const client = new Client({
  authStrategy: new LocalAuth(),
  restartOnAuthFail: true,
  webVersion: "2.2412.54",
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
  puppeteer: {
    ...(CONFIG.client.chromePath
      ? { executablePath: CONFIG.client.chromePath }
      : {}),
    headless: CONFIG.client.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--disable-extensions",
      "--disable-features=site-per-process",
      "--disable-web-security",
      "--window-size=1280,720",
    ],
  },
});

module.exports = client;
