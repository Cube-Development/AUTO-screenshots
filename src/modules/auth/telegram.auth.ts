// init_telegram_auth.ts
import { chromium, Browser, Page } from "playwright";
import fs from "fs";
import path from "path";

interface UserBot {
  id: number | string;
}

// === Задай список ботов ===
const userBots: UserBot[] = [
  { id: 7697061334},
    { id: 7487149368},
];

// === Папка для сохранения сессий ===
const AUTH_DIR = path.resolve("src/auth/telegram");

// === Утилита для создания папок ===
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// === Проверяет, успешно ли выполнен вход ===
async function checkLogin(page: Page) {
  const url = page.url();
  return /web\.telegram\.org\/[akz]\//.test(url);
}

// === Авторизация одного аккаунта ===
async function authorizeBot(browser: Browser, bot: UserBot) {
  const targetDir = path.join(AUTH_DIR, `user_bot_${bot.id}`);
  ensureDir(targetDir);
  const authPath = path.join(targetDir, "auth.json");

  if (fs.existsSync(authPath)) {
    console.log(`[✓] Сессия уже есть для user_bot_${bot.id}: ${authPath}`);
    return;
  }

  console.log(`\n=== Авторизация для user_bot_${bot.id} ===`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Открываем Telegram Web
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded" });
  console.log("1. На странице Telegram Web.");
  console.log("2. Введите номер телефона и получите код.");
  console.log("3. После входа нажмите Enter в консоли.");

  let success = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Ожидание подтверждения входа... (попытка ${attempt}/3)`);
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

    if (await checkLogin(page)) {
      success = true;
      console.log("Успешный вход подтверждён.");
      break;
    } else {
      console.log("Вход не выполнен. Попробуйте снова.");
    }
  }

  if (success) {
    await ctx.storageState({ path: authPath });
    console.log(`[+] Сессия сохранена: ${authPath}`);
  } else {
    console.log(`[×] Не удалось войти после 3 попыток. Пропуск user_bot_${bot.id}.`);
  }

  await ctx.close();
}

// === Основной запуск ===
async function main() {
  console.log("=== Инициализация Telegram сессий ===");
  ensureDir(AUTH_DIR);

  const browser = await chromium.launch({ headless: false });

  for (const bot of userBots) {
    try {
      await authorizeBot(browser, bot);
    } catch (err) {
      console.error(`[!] Ошибка при обработке user_bot_${bot.id}:`, err);
    }
  }

  await browser.close();
  console.log("\n=== Все аккаунты обработаны ===");
}

main().catch((err) => {
  console.error("Ошибка выполнения:", err);
  process.exit(1);
});
