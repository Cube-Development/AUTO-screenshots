import { Browser, Page } from "playwright";
import { ENUM_SESSION_PLATFORM, ENUM_SESSION_PLATFORM_TYPE, ISessionCheckResult, TStorageState } from "../type";
import { TELEGRAM_ACCOUNT_ID_JS } from "./telegram-auth";

const CHECK_TIMEOUT_MS = 30_000;
const CHECK_POLL_MS = 500;
const CHECK_GOTO_TIMEOUT_MS = 30_000;

/** Страница входа Web K: старые классы и новые CSS-модули с хешем (_pageSignQR_1njl8_264) */
export const TELEGRAM_SIGN_PAGE = ".page-sign, .page-signQR, [class*=\"_pageSignQR_\"], [class*=\"_pageSign_\"]";

/** Ждём, что раньше станет видно: признак входа (ok) или форма логина */
async function waitForEither(page: Page, okSelector: string, loginSelector: string): Promise<ISessionCheckResult> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  // Только видимые: первый из нескольких совпадений бывает скрыт (у Web K два .chatlist, один — архив)
  const ok = page.locator(okSelector).filter({ visible: true });
  const login = page.locator(loginSelector).filter({ visible: true });
  const shown = (locator: typeof ok) => locator.count().then((count) => count > 0).catch(() => false);

  while (Date.now() < deadline) {
    if (await shown(ok)) return { ok: true, error: null };
    if (await shown(login)) return { ok: false, error: "Открылась страница входа" };
    await page.waitForTimeout(CHECK_POLL_MS);
  }
  return { ok: false, error: `Не дождались ни входа, ни страницы входа за ${CHECK_TIMEOUT_MS / 1000}с`, inconclusive: true };
}

async function checkTelegram(page: Page): Promise<ISessionCheckResult> {
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded", timeout: CHECK_GOTO_TIMEOUT_MS });
  const result = await waitForEither(page, "#column-left .chatlist, #page-chats, .chatlist-chat", TELEGRAM_SIGN_PAGE);
  if (!result.ok) return result;

  // Web K стирает ключи авторизации, когда Telegram её отозвал
  const accountId = await page.evaluate<string | null>(TELEGRAM_ACCOUNT_ID_JS).catch(() => null);
  return accountId ? result : { ok: false, error: "Авторизация Web K удалена после загрузки (нет user_auth и accountN.userId)" };
}

async function checkInstagram(page: Page): Promise<ISessionCheckResult> {
  // Страница настроек без входа всегда редиректит на /accounts/login
  await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded", timeout: CHECK_GOTO_TIMEOUT_MS });
  await page.waitForTimeout(3_000);
  if (page.url().includes("/accounts/login")) return { ok: false, error: "Редирект на /accounts/login" };

  const cookies = await page.context().cookies("https://www.instagram.com");
  return cookies.some((cookie) => cookie.name === "sessionid")
    ? { ok: true, error: null }
    : { ok: false, error: "Instagram удалил cookie sessionid" };
}

async function checkYoutube(page: Page): Promise<ISessionCheckResult> {
  await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded", timeout: CHECK_GOTO_TIMEOUT_MS });
  return waitForEither(
    page,
    "button#avatar-btn, img.yt-spec-avatar-shape__avatar",
    'a[href^="https://accounts.google.com/ServiceLogin"]',
  );
}

const CHECKERS: Record<ENUM_SESSION_PLATFORM_TYPE, (page: Page) => Promise<ISessionCheckResult>> = {
  [ENUM_SESSION_PLATFORM.TELEGRAM]: checkTelegram,
  [ENUM_SESSION_PLATFORM.INSTAGRAM]: checkInstagram,
  [ENUM_SESSION_PLATFORM.YOUTUBE]: checkYoutube,
};

/** Живая проверка сессии в отдельном headless-контексте общего браузера */
export async function checkStorageState(
  browser: Browser,
  platform: ENUM_SESSION_PLATFORM_TYPE,
  state: TStorageState,
): Promise<ISessionCheckResult> {
  // Браузер не создал контекст (упал, закрыт) — тоже «проверить не удалось», а не обрыв всей массовой проверки
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    context = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    return await CHECKERS[platform](page);
  } catch (err: any) {
    // Таймаут goto, обрыв сети — платформа не ответила, о входе это ничего не говорит
    return { ok: false, error: err?.message?.split("\n")[0] || String(err), inconclusive: true };
  } finally {
    await context?.close().catch(() => null);
  }
}
