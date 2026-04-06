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