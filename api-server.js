/**
 * JAMB Quiz Bot — Dashboard API Server
 * =====================================
 * Drop this file into your bot root directory, then require it in index.js:
 *
 *   const apiServer = require('./api-server');
 *   apiServer.init({ activeQuizzes, storage, commandHandler, dataManager });
 *
 * The React dashboard connects to this on port 3001 (or DASHBOARD_PORT env var).
 */

const http = require("http");
const WebSocket = require("ws");

let _deps = {
  activeQuizzes: null,
  storage: null,
  commandHandler: null,
  dataManager: null,
};

// ── In-memory event log (last 200) ───────────────────────────────
const eventLog = [];
function pushEvent(type, data) {
  const event = { type, data, ts: Date.now() };
  eventLog.push(event);
  if (eventLog.length > 200) eventLog.shift();
  broadcast(event);
}

// ── WebSocket clients ─────────────────────────────────────────────
const wsClients = new Set();
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Snapshot builder ──────────────────────────────────────────────
function buildSnapshot() {
  const { activeQuizzes, storage, commandHandler } = _deps;
  if (!activeQuizzes || !storage) return { error: "bot not ready" };

  const chats = [];
  const seen = new Set();

  // Active quizzes
  for (const [chatId, state] of activeQuizzes) {
    seen.add(chatId);
    const scores = Object.entries(state.scoreBoard || {})
      .map(([uid, d]) => ({ uid, name: d.name, score: d.score }))
      .sort((a, b) => b.score - a.score);

    chats.push({
      chatId,
      isActive: state.isActive,
      subject: state.subject,
      year: state.year,
      currentQuestion: state.currentQuestionIndex + 1,
      totalQuestions: state.questions?.length || 0,
      scores,
      participants: scores.length,
      startedAt: state.startedAt || null,
      disabled: storage.isChatDisabled(chatId),
    });
  }

  // Disabled chats that have no active quiz
  const perms = storage.permissions || {};
  for (const chatId of perms.disabledChats || []) {
    if (!seen.has(chatId)) {
      chats.push({
        chatId,
        isActive: false,
        disabled: true,
        scores: [],
        participants: 0,
      });
    }
  }

  const aiStatus = commandHandler?.getAiStatus?.() || { isOpen: false, canTry: true };

  return {
    ts: Date.now(),
    globalDisabled: storage.isGloballyDisabled(),
    aiStatus,
    chats,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };
}

// ── Router ────────────────────────────────────────────────────────
function router(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const readBody = () =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({});
        }
      });
    });

  // Validate simple bearer token
  const token = process.env.DASHBOARD_TOKEN;
  if (token) {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
      json({ error: "Unauthorized" }, 401);
      return;
    }
  }

  // ── GET /api/snapshot ──────────────────────────────────────────
  if (path === "/api/snapshot" && req.method === "GET") {
    return json(buildSnapshot());
  }

  // ── GET /api/history/:chatId ──────────────────────────────────
  if (path.startsWith("/api/history/") && req.method === "GET") {
    const chatId = decodeURIComponent(path.slice("/api/history/".length));
    const history = _deps.storage?.getQuizHistory?.(chatId) || [];
    return json({ chatId, history });
  }

  // ── GET /api/events ───────────────────────────────────────────
  if (path === "/api/events" && req.method === "GET") {
    return json({ events: eventLog.slice(-50) });
  }

  // ── GET /api/subjects ─────────────────────────────────────────
  if (path === "/api/subjects" && req.method === "GET") {
    const dm = _deps.dataManager;
    if (!dm) return json({ subjects: [] });
    dm.getAvailableSubjects().then((subjects) => json({ subjects }));
    return;
  }

  // ── POST /api/chat/disable ────────────────────────────────────
  if (path === "/api/chat/disable" && req.method === "POST") {
    readBody().then(({ chatId }) => {
      if (!chatId) return json({ error: "chatId required" }, 400);
      _deps.storage.disableChat(chatId);
      pushEvent("chat_disabled", { chatId });
      json({ ok: true });
    });
    return;
  }

  // ── POST /api/chat/enable ─────────────────────────────────────
  if (path === "/api/chat/enable" && req.method === "POST") {
    readBody().then(({ chatId }) => {
      if (!chatId) return json({ error: "chatId required" }, 400);
      _deps.storage.enableChat(chatId);
      pushEvent("chat_enabled", { chatId });
      json({ ok: true });
    });
    return;
  }

  // ── POST /api/global/disable ──────────────────────────────────
  if (path === "/api/global/disable" && req.method === "POST") {
    _deps.storage.setGlobalDisabled(true);
    pushEvent("global_disabled", {});
    return json({ ok: true });
  }

  // ── POST /api/global/enable ───────────────────────────────────
  if (path === "/api/global/enable" && req.method === "POST") {
    _deps.storage.setGlobalDisabled(false);
    pushEvent("global_enabled", {});
    return json({ ok: true });
  }

  // ── POST /api/quiz/stop ───────────────────────────────────────
  if (path === "/api/quiz/stop" && req.method === "POST") {
    readBody().then(({ chatId }) => {
      if (!chatId) return json({ error: "chatId required" }, 400);
      const state = _deps.activeQuizzes?.get(chatId);
      if (!state?.isActive) return json({ error: "No active quiz" }, 404);
      // Import quizManager lazily
      try {
        const quizManager = require("./quizManager");
        quizManager.stop(chatId);
        pushEvent("quiz_stopped", { chatId, source: "dashboard" });
        json({ ok: true });
      } catch (e) {
        json({ error: e.message }, 500);
      }
    });
    return;
  }

  // ── POST /api/config ──────────────────────────────────────────
  if (path === "/api/config" && req.method === "POST") {
    readBody().then(({ chatId, questionInterval, delayBeforeNextQuestion, maxQuestionsPerQuiz }) => {
      if (!chatId) return json({ error: "chatId required" }, 400);
      const cfg = _deps.storage?.quizConfig;
      if (!cfg) return json({ error: "storage not ready" }, 500);
      if (!cfg[chatId]) cfg[chatId] = {};
      if (questionInterval) cfg[chatId].questionInterval = questionInterval * 1000;
      if (delayBeforeNextQuestion) cfg[chatId].delayBeforeNextQuestion = delayBeforeNextQuestion * 1000;
      if (maxQuestionsPerQuiz) cfg[chatId].maxQuestionsPerQuiz = maxQuestionsPerQuiz;
      _deps.storage.saveQuizConfig?.();
      pushEvent("config_updated", { chatId });
      json({ ok: true });
    });
    return;
  }

  json({ error: "Not found" }, 404);
}

// ── Periodic broadcast of snapshot ───────────────────────────────
let broadcastInterval = null;

// ── Public API ────────────────────────────────────────────────────
const apiServer = {
  init(deps) {
    _deps = { ..._deps, ...deps };

    const PORT = process.env.DASHBOARD_PORT || 3001;
    const server = http.createServer(router);
    const wss = new WebSocket.Server({ server, path: "/ws" });

    wss.on("connection", (ws) => {
      wsClients.add(ws);
      // Send current snapshot immediately on connect
      ws.send(JSON.stringify({ type: "snapshot", data: buildSnapshot() }));
      ws.on("close", () => wsClients.delete(ws));
    });

    server.listen(PORT, () => {
      console.log(`✅ Dashboard API server running on port ${PORT}`);
    });

    // Broadcast snapshot every 3 seconds to all connected dashboards
    broadcastInterval = setInterval(() => {
      if (wsClients.size > 0) {
        broadcast({ type: "snapshot", data: buildSnapshot() });
      }
    }, 3000);

    return this;
  },

  pushEvent,
};

module.exports = apiServer;