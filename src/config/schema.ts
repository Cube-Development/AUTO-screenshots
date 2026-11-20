import { z } from "zod";

/**
 * Zod-схема для валидации env-переменных при старте.
 * Сервер не запустится без обязательных переменных — ошибка будет читаемой.
 */
const envSchema = z.object({
  // Внешние сервисы
  BLOGIX_API_URL:    z.url("BLOGIX_API_URL должен быть валидным URL"),
  SERVER_API_KEY:    z.string().min(1, "SERVER_API_KEY обязателен"),
  BLOGIX_API_KEY:    z.string().min(1, "BLOGIX_API_KEY обязателен"),
  // Telegram-нотификация (опционально)
  SEND_TO_TELEGRAM:     z.string().default("false"),
  TG_BOT_TOKEN:         z.string().default(""),
  TG_CHAT_ID:           z.string().default(""),
  TG_TOPIC_ID:          z.string().default("").optional(),
  // Лимиты и порт
  TEST_SCREENSHOTS:     z.string().default("false"),
  MAX_SCREENSHOT_LIMIT: z.coerce.number().int().positive().default(5),
  PORT:                 z.coerce.number().int().positive().default(3000),
  // Хранилище сессий (SQLite)
  SESSIONS_DB_PATH:     z.string().min(1).default("./data/sessions.db"),
  // Стартовая копия из репо: копируется, только если SESSIONS_DB_PATH ещё нет
  SESSIONS_SEED_PATH:   z.string().default("./seed/sessions.db"),
  // Ежедневная живая проверка всех активных сессий, час по Ташкенту
  SESSIONS_CHECK_HOUR:  z.coerce.number().int().min(0).max(23).default(4),
  // Ежедневный бэкап базы (в тот же час, перед проверкой): папка и сколько копий хранить
  SESSIONS_BACKUP_DIR:  z.string().min(1).default("./data/backups"),
  SESSIONS_BACKUP_KEEP: z.coerce.number().int().min(1).max(90).default(7),
  SESSIONS_ENC_KEY:     z.string().refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "SESSIONS_ENC_KEY должен быть 32 байтами в base64 (openssl rand -base64 32)",
  ),
  // Старые папки с auth.json: разовый импорт в пустую SQLite; не задано — импорта нет
  LEGACY_AUTH_DIR:      z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Ошибка валидации env-переменных:");
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
