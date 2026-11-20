// npm run auth:instagram -- <accountId>
// Ручной вход в Instagram и экспорт сессии для загрузки в админке
import fs from "fs";
import os from "os";
import path from "path";
import { chromium, Page } from "playwright";
import { exportStorageState, readAccountIdArg, waitForEnter } from "./auth.utils";

/** Вход через кнопку на /explore имитирует естественное поведение, иначе — прямой переход */
async function openLoginPage(page: Page): Promise<void> {
  await page.goto("https://www.instagram.com/explore/", { waitUntil: "networkidle" });
  try {
    const loginButton = page.locator('span:has-text("Log in"), a[href*="/accounts/login"]', { hasText: /Log in/i }).first();
    if (await loginButton.isVisible()) {
      await loginButton.click();
      return;
    }
  } catch {
    // переходим напрямую ниже
  }
  await page.goto("https://www.instagram.com/accounts/login/");
}

async function main() {
  const accountId = readAccountIdArg("npm run auth:instagram -- <accountId, например username>");
  console.log("=== Вход в Instagram ===\n");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw_ig_profile_"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await openLoginPage(page);
    await waitForEnter("1. Войдите в Instagram в открывшемся окне, затем нажмите Enter...");

    const cookies = await context.cookies("https://www.instagram.com");
    if (!cookies.some((cookie) => cookie.name === "sessionid")) {
      console.log("[×] Нет cookie sessionid — вход не выполнен.");
      process.exitCode = 1;
      return;
    }

    await exportStorageState(context, "instagram", accountId);
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Ошибка выполнения:", err);
  process.exit(1);
});
