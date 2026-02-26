const https = require("https");
const CONFIG = require("./config");
const logger = require("./logger");

// ==========================================
// 🤖 AI SERVICE (Grok via xAI API)
// ==========================================
// Uses xAI's Grok API (OpenAI-compatible format)
// Sign up free: https://console.x.ai/
// Set XAI_API_KEY in your .env

const aiService = {
  /**
   * Core request to Grok API
   * @param {Array} messages - OpenAI-format messages array
   * @param {Object} opts - { maxTokens, temperature }
   * @returns {string|null} AI response text
   */
  async chat(messages, opts = {}) {
    const apiKey = CONFIG.ai.apiKey;
    if (!apiKey) {
      logger.warn("AI: No XAI_API_KEY set — skipping AI call");
      return null;
    }

    const payload = JSON.stringify({
      model: CONFIG.ai.model,
      messages,
      max_tokens: opts.maxTokens || CONFIG.ai.maxTokens,
      temperature: opts.temperature ?? CONFIG.ai.temperature,
    });

    return new Promise((resolve) => {
      const options = {
        hostname: "api.x.ai",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              logger.error("AI API error:", json.error.message || json.error);
              return resolve(null);
            }
            const text = json.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch (e) {
            logger.error("AI parse error:", e.message);
            resolve(null);
          }
        });
      });

      req.on("error", (e) => {
        logger.error("AI request failed:", e.message);
        resolve(null);
      });

      req.setTimeout(CONFIG.ai.timeoutMs, () => {
        logger.warn("AI request timed out");
        req.destroy();
        resolve(null);
      });

      req.write(payload);
      req.end();
    });
  },

  // ── Explain a quiz answer ─────────────────────────────────────────
  // Called after a question ends — enhances the built-in explanation
  async explainAnswer(question, correctOption, subject, year) {
    if (!CONFIG.ai.apiKey) return null;

    const messages = [
      {
        role: "system",
        content:
          "You are a helpful JAMB exam tutor. Give a clear, concise explanation " +
          "(2-3 sentences max) of why the correct answer is right. " +
          "Use plain text only — no markdown, no asterisks.",
      },
      {
        role: "user",
        content:
          `Subject: ${subject?.toUpperCase()} ${year || ""}\n` +
          `Question: ${question}\n` +
          `Correct Answer: ${correctOption}\n\n` +
          `Explain briefly why this is correct.`,
      },
    ];

    return this.chat(messages, { maxTokens: 200, temperature: 0.3 });
  },

  // ── Generate quiz questions ───────────────────────────────────────
  // Returns array of question objects matching your JSON schema, or null
  async generateQuestions(subject, topic, count = 5) {
    if (!CONFIG.ai.apiKey) return null;

    const messages = [
      {
        role: "system",
        content:
          "You are a JAMB exam question generator. " +
          "Return ONLY a valid JSON array of question objects. No explanation, no markdown. " +
          "Each object must have: question (string), options (array of 4 strings), " +
          "answer_index (0-3), explanation (string).",
      },
      {
        role: "user",
        content:
          `Generate ${count} multiple-choice JAMB questions for ${subject.toUpperCase()} ` +
          `on the topic: "${topic}". Return JSON array only.`,
      },
    ];

    const raw = await this.chat(messages, {
      maxTokens: 1500,
      temperature: 0.7,
    });
    if (!raw) return null;

    try {
      // Strip any accidental markdown fences
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;

      // Validate each question has required fields
      return parsed.filter(
        (q) =>
          q.question &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          typeof q.answer_index === "number",
      );
    } catch (e) {
      logger.error("AI: Failed to parse generated questions:", e.message);
      return null;
    }
  },

  // ── Free-form chat ────────────────────────────────────────────────
  // Used for the !ai command — general educational chat
  async freeChat(userMessage, context = "") {
    if (!CONFIG.ai.apiKey) return null;

    const systemPrompt =
      "You are a helpful JAMB exam assistant. " +
      "Help students understand concepts, answer questions about biology, chemistry, physics, and maths. " +
      "Keep responses short (3-5 sentences). Plain text only.";

    const messages = [{ role: "system", content: systemPrompt }];

    if (context) {
      messages.push({ role: "assistant", content: context });
    }

    messages.push({ role: "user", content: userMessage });

    return this.chat(messages, { maxTokens: 300, temperature: 0.6 });
  },

  // ── Daily question hint ───────────────────────────────────────────
  async generateDailyHint(question, subject) {
    if (!CONFIG.ai.apiKey) return null;

    const messages = [
      {
        role: "system",
        content:
          "You are a JAMB tutor. Give a short hint (1 sentence) for the question without revealing the answer.",
      },
      {
        role: "user",
        content: `${subject?.toUpperCase()} Question: ${question}\n\nGive a 1-sentence hint only.`,
      },
    ];

    return this.chat(messages, { maxTokens: 80, temperature: 0.5 });
  },
};

module.exports = aiService;
