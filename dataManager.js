const fs = require("fs").promises;
const path = require("path");
const CONFIG = require("./config");
const logger = require("./logger");

// ==========================================
// 📚 DATA MANAGEMENT
// ==========================================
const dataManager = {
  async loadQuestions(subject, year) {
    try {
      const filePath = path.join(
        CONFIG.data.dataDirectory,
        subject,
        `${year}.json`,
      );
      logger.debug(`Loading: ${filePath}`);
      try {
        await fs.access(filePath);
      } catch {
        logger.warn(`File not found: ${filePath}`);
        return null;
      }
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (!data.questions || !Array.isArray(data.questions)) {
        logger.error(`Invalid structure: ${filePath}`);
        return null;
      }
      if (data.questions.length === 0) {
        logger.warn(`Empty: ${filePath}`);
        return null;
      }
      logger.success(
        `Loaded ${data.questions.length} questions (${subject} ${year})`,
      );
      return {
        paperType: data.paper_type || "STANDARD",
        questions: data.questions,
      };
    } catch (e) {
      logger.error("loadQuestions error:", e.message);
      return null;
    }
  },

  async getRandomQuestion(subject, year) {
    const data = await this.loadQuestions(subject, year);
    if (!data) return null;
    const idx = Math.floor(Math.random() * data.questions.length);
    return {
      question: data.questions[idx],
      paperType: data.paperType,
      index: idx,
    };
  },

  async getAvailableSubjects() {
    try {
      const entries = await fs.readdir(CONFIG.data.dataDirectory, {
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => !n.startsWith("."));
    } catch {
      return CONFIG.data.subjects;
    }
  },

  async getAvailableYears(subject) {
    try {
      const dir = path.join(CONFIG.data.dataDirectory, subject);
      const files = await fs.readdir(dir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""))
        .sort();
    } catch {
      return CONFIG.data.years;
    }
  },
};

module.exports = dataManager;
