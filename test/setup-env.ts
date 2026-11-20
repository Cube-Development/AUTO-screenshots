// Тестовое окружение до импорта кода: src/config валидирует env при загрузке модуля.
// .env не читается — у каждого процесса тестов своя временная база, Telegram-уведомления выключены
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-screenshots-test-"));

Object.assign(process.env, {
  LOG_LEVEL: "silent",
  BLOGIX_API_URL: "http://blogix.test",
  SERVER_API_KEY: "test-api-key",
  BLOGIX_API_KEY: "test-blogix-key",
  SEND_TO_TELEGRAM: "false",
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  SESSIONS_DB_PATH: path.join(dir, "sessions.db"),
  SESSIONS_SEED_PATH: path.join(dir, "no-seed.db"),
  SESSIONS_BACKUP_DIR: path.join(dir, "backups"),
  SESSIONS_BACKUP_KEEP: "2",
  SESSIONS_ENC_KEY: crypto.randomBytes(32).toString("base64"),
});

process.env.TEST_TMP_DIR = dir;
// На Windows открытую SQLite не удалить — временная папка тогда остаётся, тесты от этого не падают
process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* файл базы ещё открыт */
  }
});
