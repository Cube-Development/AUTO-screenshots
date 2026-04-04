// init_youtube_auth.ts
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// === Папка для сохранения сессии ===
const AUTH_DIR = path.resolve("src/auth/youtube");
const AUTH_PATH = path.join(AUTH_DIR, "auth.json");

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function main() {
  console.log("=== Инициализация YouTube (Google) сессии ===\n");
  ensureDir(AUTH_DIR);

  if (fs.existsSync(AUTH_PATH)) {
    console.log(`[✓] Сессия уже существует: ${AUTH_PATH}`);
    console.log("Удалите файл вручную, если хотите перелогиниться.");
    return;
  }

  // Используем системный Chrome (не Playwright Chromium) — Google блокирует вход через автоматизированные браузеры
  const userDataDir = path.join(AUTH_DIR, ".chrome_profile");
  ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = context.pages()[0] || await context.newPage();

  // 1. Логин Google
  await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded" });
  console.log("1. Откроется страница входа Google.");
  console.log("2. Войдите в Google аккаунт.");

  console.log("\nПосле входа в Google нажмите Enter...");
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  // 2. Проверяем YouTube
  await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const avatarBtn = await page.$("button#avatar-btn, img.yt-spec-avatar-shape__avatar");
  if (avatarBtn) {
    console.log("[✓] YouTube: аватар найден — авторизация успешна.");
  } else {
    console.log("[!] YouTube: аватар не найден. Примите cookies/consent вручную, затем нажмите Enter...");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  }

  // 3. Сохраняем сессию
  await context.storageState({ path: AUTH_PATH });
  console.log(`\n[+] Сессия сохранена: ${AUTH_PATH}`);

  await context.close();
  console.log("=== Google/YouTube авторизация завершена ===");
}

main().catch((err) => {
  console.error("Ошибка выполнения:", err);
  process.exit(1);
});
