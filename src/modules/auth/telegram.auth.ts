// npm run auth:telegram
// Ручной вход в Telegram Web K под юзерботом и экспорт сессии для загрузки в админке
import { chromium, Page } from "playwright";
import { exportStorageState, waitForEnter } from "./auth.utils";

const MAX_ATTEMPTS = 3;

/** id аккаунта Web K хранит в localStorage.user_auth: {"dcID":2,"id":7697061334,...} */
async function readTelegramUserId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      const auth = JSON.parse(localStorage.getItem("user_auth") || "null");
      return auth?.id ? String(auth.id) : null;
    } catch {
      return null;
    }
  });
}

async function main() {
  console.log("=== Вход в Telegram Web K ===");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded" });
  console.log("1. Войдите в аккаунт юзербота (номер телефона → код → пароль 2FA).");

  let userId: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !userId; attempt++) {
    await waitForEnter(`2. После входа нажмите Enter (попытка ${attempt}/${MAX_ATTEMPTS})...`);
    userId = await readTelegramUserId(page);
    if (!userId) console.log("Вход не обнаружен (нет localStorage.user_auth). Попробуйте снова.");
  }

  if (userId) {
    console.log(`[✓] Вход выполнен, telegram_user_id: ${userId}`);
    await exportStorageState(context, "telegram", userId);
  } else {
    console.log(`[×] Не удалось войти после ${MAX_ATTEMPTS} попыток.`);
  }

  await browser.close();
  process.exit(userId ? 0 : 1);
}

main().catch((err) => {
  console.error("Ошибка выполнения:", err);
  process.exit(1);
});
