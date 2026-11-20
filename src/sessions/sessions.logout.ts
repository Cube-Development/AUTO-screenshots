import { Browser, Page } from "playwright";
import { ENUM_SESSION_PLATFORM, ENUM_SESSION_PLATFORM_TYPE, ISessionLogoutResult, TStorageState } from "../type";
import { TELEGRAM_SIGN_PAGE } from "./sessions.checker";

const STEP_TIMEOUT_MS = 30_000;
/** Публичный app-id веба Instagram: без него logout/ajax отвечает 400 */
const INSTAGRAM_APP_ID = "936619743392459";

/** Web K: меню → Settings → «⋮» → Log Out → подтверждение; итог — страница входа */
async function logoutTelegram(page: Page): Promise<void> {
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
  await page.locator("#column-left .chatlist").first().waitFor({ timeout: STEP_TIMEOUT_MS });

  await page.locator("#column-left .sidebar-tools-button").first().click({ timeout: STEP_TIMEOUT_MS });
  await page.locator(".btn-menu-item:visible", { hasText: /Settings|Настройки/ }).first().click({ timeout: STEP_TIMEOUT_MS });
  await page
    .locator("#column-left .sidebar-header .btn-menu-toggle:not(.sidebar-tools-button):visible")
    .first()
    .click({ timeout: STEP_TIMEOUT_MS });
  await page.locator(".btn-menu-item:visible", { hasText: /Log Out|Выйти/ }).first().click({ timeout: STEP_TIMEOUT_MS });
  await page.locator(".popup-button:visible", { hasText: /Log Out|Выйти/i }).first().click({ timeout: STEP_TIMEOUT_MS });

  await page.locator(TELEGRAM_SIGN_PAGE).first().waitFor({ timeout: STEP_TIMEOUT_MS });
}

/** Тот же запрос, что делает кнопка «Выйти» на сайте; csrftoken берётся из cookie */
async function logoutInstagram(page: Page): Promise<void> {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
  const status = await page.evaluate(async (appId) => {
    const csrf = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1] ?? "";
    const response = await fetch("/api/v1/web/accounts/logout/ajax/", {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": csrf, "X-IG-App-ID": appId, "Content-Type": "application/x-www-form-urlencoded" },
      body: "one_tap_app_login=0",
    });
    return response.status;
  }, INSTAGRAM_APP_ID);
  if (status >= 400) throw new Error(`Instagram ответил ${status} на выход`);
}

/** Выход Google на всех сервисах этого набора cookies */
async function logoutYoutube(page: Page): Promise<void> {
  await page.goto("https://www.youtube.com/logout", { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
}

const LOGOUTS: Record<ENUM_SESSION_PLATFORM_TYPE, (page: Page) => Promise<void>> = {
  [ENUM_SESSION_PLATFORM.TELEGRAM]: logoutTelegram,
  [ENUM_SESSION_PLATFORM.INSTAGRAM]: logoutInstagram,
  [ENUM_SESSION_PLATFORM.YOUTUBE]: logoutYoutube,
};

/**
 * Выход из аккаунта перед удалением сессии: иначе web-сессия остаётся в «Устройствах» аккаунта.
 * Лучшее усилие — при ошибке сессия всё равно удаляется, а причина уходит в ответ и историю
 */
export async function logoutStorageState(
  browser: Browser,
  platform: ENUM_SESSION_PLATFORM_TYPE,
  state: TStorageState,
): Promise<ISessionLogoutResult> {
  // Браузер не создал контекст — это тоже «выход не удался», удаление сессии не должно падать
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    context = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    await LOGOUTS[platform](await context.newPage());
    return { ok: true, error: null };
  } catch (err: any) {
    return { ok: false, error: err?.message?.split("\n")[0] || String(err) };
  } finally {
    await context?.close().catch(() => null);
  }
}
