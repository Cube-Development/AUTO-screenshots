// npm run auth:youtube -- <accountId>
// Ручной вход в Google/YouTube и экспорт сессии для загрузки в админке
import fs from "fs";
import os from "os";
import path from "path";
import { chromium } from "playwright";
import { exportStorageState, readAccountIdArg, waitForEnter } from "./auth.utils";

async function main() {
  const accountId = readAccountIdArg("npm run auth:youtube -- <accountId, например логин Google>");
  console.log("=== Вход в YouTube (Google) ===\n");

  // Системный Chrome (не Playwright Chromium): Google блокирует вход через автоматизированные браузеры
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw_yt_profile_"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded" });
    await waitForEnter("1. Войдите в Google аккаунт, затем нажмите Enter...");

    await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const avatarBtn = await page.$("button#avatar-btn, img.yt-spec-avatar-shape__avatar");
    if (avatarBtn) {
      console.log("[✓] YouTube: аватар найден — авторизация успешна.");
    } else {
      await waitForEnter("[!] YouTube: аватар не найден. Примите cookies/consent вручную, затем нажмите Enter...");
    }

    await exportStorageState(context, "youtube", accountId);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Ошибка выполнения:", err);
  process.exit(1);
});
