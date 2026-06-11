import fs from "fs";
import os from "os";
import path from "path";
import { chromium, Page } from "playwright";
import { log } from "../utils";
import { SETTINGS } from "../config";
import { ResourceType } from "../type";
import { TEST_SCREENS_DIR, getCISDateString } from "./utils";
import { extractPostId, installTargetOnlyMediaGuard, waitForTargetMessage } from "./telegram-message";

const TG_GOTO_TIMEOUT_MS = 60_000;
const TG_CHAT_OPEN_TIMEOUT_MS = 45_000;
const TG_CONTENT_TIMEOUT_MS = 60_000;
const TG_SETTLE_MS = 2_000;
const TG_AFTER_GOTO_MS = 2_000;
const TG_MODAL_DISMISS_ATTEMPTS = 3;
const TG_MODAL_DISMISS_DELAY_MS = 300;
const TG_WARMUP_TIMEOUT_MS = 30_000;
const TG_AUTH_WAIT_MS = 15_000;
const TG_WS_SETTLE_MS = 1_500;
const TG_WS_STABLE_MS = 4_000;
const TG_APP_READY_TIMEOUT_MS = 45_000;

function extractPrivateChannelId(link: string): string | null {
  return link.match(/t\.me\/c\/(\d+)/)?.[1] ?? null;
}

function isPrivatePostLink(link: string): boolean {
  return /t\.me\/c\/\d+\/\d+/.test(link);
}

function toTelegramA(url: string): string {
  return url.replace(/web\.telegram\.org\/k\//, "web.telegram.org/a/");
}

export function buildWebHrefFromTgaddr(tgaddr: string) {
  if (!tgaddr) return null;
  if (/tg%3A|%3A/.test(tgaddr)) {
    if (tgaddr.startsWith("https://")) return toTelegramA(tgaddr);
    return "https://web.telegram.org/a/#?tgaddr=" + tgaddr.split("tgaddr=")[1];
  }
  const raw = tgaddr.startsWith("tg://") ? tgaddr : tgaddr;
  return "https://web.telegram.org/a/#?tgaddr=" + encodeURIComponent(raw);
}

/**
 * Прямая ссылка для приватных постов: t.me/c/{channelId}/{postId}
 */
export function tryResolvePrivatePostLink(link: string): string | null {
  const match = link.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (!match) return null;
  const tgaddr = `tg://privatepost?channel=${match[1]}&post=${match[2]}`;
  return `https://web.telegram.org/a/#?tgaddr=${encodeURIComponent(tgaddr)}`;
}

/**
 * Пробует создать прямую ссылку на Telegram Web A минуя t.me
 * Работает для ссылок вида t.me/channel/id
 */
export function tryResolveDirectTelegramKLink(link: string): string | null {
  const match = link.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
  if (!match || match[1] === "c") return null;
  const tgaddr = `tg://resolve?domain=${match[1]}&post=${match[2]}`;
  return `https://web.telegram.org/a/#?tgaddr=${encodeURIComponent(tgaddr)}`;
}

export async function ensureTelegramAuth(auth_path: string) {
  if (fs.existsSync(auth_path)) return;

  const tmpProfile = path.join(os.tmpdir(), `pw_profile_${Date.now()}`);
  fs.mkdirSync(tmpProfile, { recursive: true });

  const context = await chromium.launchPersistentContext(tmpProfile, { headless: false, viewport: { width: 1280, height: 800 } });
  const page = context.pages()[0] || await context.newPage();

  console.log("Открылся чистый профиль. Выполните вход в Telegram Web вручную.");
  await page.goto("https://web.telegram.org/a/");

  console.log("После успешного входа нажмите Enter в консоли.");
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: auth_path });
  await context.close();
  console.log("auth.json сохранён из чистого профиля.");
}

async function dismissTelegramModals(page: Page, logCtx?: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < TG_MODAL_DISMISS_ATTEMPTS; i++) {
    try {
      const modal = await page.$(".Modal.open, .Modal.shown, .Modal.error.shown.open, div.modal-dialog");
      let btn = modal ? await modal.$("button, div[role='button'], .btn-primary") : null;

      if (!btn) {
        const okBtn = page.getByRole("button", { name: /^OK$/i });
        if (!(await okBtn.isVisible().catch(() => false))) break;
        btn = await okBtn.elementHandle();
      }

      if (!btn) break;

      const text = modal
        ? await modal.innerText().catch(() => "")
        : await page.locator(".Modal").first().innerText().catch(() => "");

      log.info({ ...logCtx, modalText: text.slice(0, 100) }, "Закрываю модальное окно");
      await btn.click().catch(() => null);
      await page.waitForTimeout(TG_MODAL_DISMISS_DELAY_MS);
    } catch {
      break;
    }
  }
}

export async function closeModalIfExists(page: Page): Promise<void> {
  await dismissTelegramModals(page);
}

async function blockVideoStreaming(page: Page): Promise<void> {
  await page.route("**/progressive/**", (route) => route.abort());
}

async function warmupTelegramSession(page: Page, link: string, logCtx: Record<string, unknown>): Promise<void> {
  log.info(logCtx, "Прогрев Telegram Web сессии...");
  await page.goto("https://web.telegram.org/a/", { waitUntil: "domcontentloaded", timeout: TG_WARMUP_TIMEOUT_MS });
  await page
    .waitForFunction(() => {
      const auth = localStorage.getItem("user_auth");
      return auth !== null && auth !== "null" && auth.length > 0;
    }, null, { timeout: TG_AUTH_WAIT_MS })
    .catch(() => log.warn(logCtx, "user_auth не найден после прогрева, продолжаем"));
  const settleMs = isPrivatePostLink(link) ? TG_WS_SETTLE_MS * 2 : TG_WS_SETTLE_MS;
  await page.waitForTimeout(settleMs);
}

async function dismissAppInactive(page: Page, logCtx: Record<string, unknown>): Promise<void> {
  const inactive = page.locator("#AppInactive button");
  if (!(await inactive.first().isVisible().catch(() => false))) return;
  log.info(logCtx, "AppInactive — перезагружаю вкладку");
  await inactive.first().click().catch(() => null);
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(TG_WS_SETTLE_MS);
}

async function waitForTelegramConnectionReady(page: Page, logCtx: Record<string, unknown>): Promise<void> {
  await dismissAppInactive(page, logCtx);

  const wsResponse = page
    .waitForResponse((r) => /zws\d*[-.]?.*\.web\.telegram\.org/.test(r.url()) && r.status() < 400, {
      timeout: TG_APP_READY_TIMEOUT_MS,
    })
    .catch(() => null);

  await page
    .waitForFunction(
      () => {
        const inactive = document.getElementById("AppInactive");
        if (inactive?.closest(".Transition_slide-active")) return false;
        if (document.querySelector(".chat-list .Loading")) return false;
        const items = document.querySelectorAll(".chat-list .ListItem, #LeftColumn .ListItem");
        if (items.length === 0) return false;
        return Array.from(items).some((el) => {
          const title = el.querySelector(".title, .fullName, .peer-title");
          return (title?.textContent?.trim().length ?? 0) > 0;
        });
      },
      null,
      { timeout: TG_APP_READY_TIMEOUT_MS },
    )
    .catch(() => log.warn(logCtx, "Список чатов не загрузился"));

  await wsResponse;
  await page.waitForTimeout(TG_WS_STABLE_MS);
  log.info(logCtx, "WS и чаты готовы");
}

async function gotoTelegramTarget(
  page: Page,
  target: string,
  link: string,
  logCtx: Record<string, unknown>,
  postId: string | null,
): Promise<Page> {
  if (!isPrivatePostLink(link)) {
    if (postId) await installTargetOnlyMediaGuard(page, postId);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: TG_GOTO_TIMEOUT_MS }).catch(() => null);
    await page.waitForTimeout(TG_AFTER_GOTO_MS);
    await dismissTelegramModals(page, logCtx);
    return page;
  }

  await warmupTelegramSession(page, link, logCtx);
  await waitForTelegramConnectionReady(page, logCtx);

  const postPage = await page.context().newPage();
  await blockVideoStreaming(postPage);
  if (postId) await installTargetOnlyMediaGuard(postPage, postId);
  log.info(logCtx, "Открываю private post во второй вкладке");
  await postPage.goto(target, { waitUntil: "domcontentloaded", timeout: TG_GOTO_TIMEOUT_MS }).catch(() => null);
  await postPage.waitForTimeout(TG_AFTER_GOTO_MS);
  await dismissTelegramModals(postPage, logCtx);

  return postPage;
}

async function waitForChatOpened(page: Page, logCtx: Record<string, unknown>, link: string): Promise<void> {
  log.info(logCtx, "Ожидание открытия чата...");
  const privateChannelId = extractPrivateChannelId(link);

  if (privateChannelId) {
    const expectedHash = `-100${privateChannelId}`;
    await page.waitForFunction(
      (hashPart) => window.location.hash.includes(hashPart),
      expectedHash,
      { timeout: TG_CHAT_OPEN_TIMEOUT_MS },
    );
  } else {
    await page.waitForFunction(
      () => {
        const hash = window.location.hash;
        return /^#-?\d/.test(hash) || /^#@/.test(hash);
      },
      null,
      { timeout: TG_CHAT_OPEN_TIMEOUT_MS },
    );
  }

  const hash = await page.evaluate(() => window.location.hash);
  log.info({ ...logCtx, hash }, "Чат открыт");
}

async function waitForAnyMessageContent(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const selectors = [
      ".Message", ".message", ".message-content", ".bubble", ".text-content",
      ".Message-content", ".media-container", ".message-text", ".text",
    ];
    const msg = selectors.map((s) => document.querySelector(s)).find((el) => el !== null) as HTMLElement | null;
    if (!msg) return false;

    const text = msg.innerText || "";
    const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
    const hasPreview = msg.querySelector(
      'img[src]:not([src=""]), .media-preview, .thumbnail, .video-preview, .message-media img, .album-item',
    ) !== null;
    const hasOtherMedia = msg.querySelector(".poll, .album, .media-container") !== null;
    return (hasText || hasPreview || hasOtherMedia) && msg.offsetHeight > 20;
  }, null, { timeout: TG_CONTENT_TIMEOUT_MS });
}

export async function handleTelegramLink(page: Page, link: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
  const logCtx = { id: reqId, type: ResourceType.TELEGRAM, url: link };
  let activePage = page;
  const abortNavigation = () => { activePage.goto("about:blank").catch(() => { }); };
  signal?.addEventListener("abort", abortNavigation, { once: true });

  try {
    await blockVideoStreaming(page);

    let target = tryResolvePrivatePostLink(link);

    if (target) {
      log.info(logCtx, `[PrivatePath] Приватный пост: ${target}`);
    } else {
      target = tryResolveDirectTelegramKLink(link);
      if (target) {
        log.info(logCtx, `[FastPath] Прямая ссылка: ${target}`);
      } else {
        log.info(logCtx, `[SlowPath] Открываю: ${link}`);
        await page.goto(link, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);

        const btn = await page.$("a.tgme_action_web_button, a.tgme_action_button_new, a.tgme_action_button");
        if (!btn) {
          log.warn(logCtx, "Кнопка 'Open in Web' не найдена.");
          await page.waitForTimeout(2000);
          return await page.screenshot({ fullPage: true });
        }

        const hrefAttr = await btn.getAttribute("href");
        if (hrefAttr) {
          if (hrefAttr.includes("web.telegram.org")) target = hrefAttr;
          else if (hrefAttr.includes("tgaddr") || hrefAttr.startsWith("tg://") || hrefAttr.includes("privatepost"))
            target = buildWebHrefFromTgaddr(hrefAttr);
          else if (hrefAttr.startsWith("/")) target = "https://t.me" + hrefAttr;
        }

        if (!target) {
          const html = await page.content();
          const m = html.match(/(tg(?:%3A|:)\/\/privatepost[^\"]+)/i) || html.match(/tgaddr=([^\"&']+)/i);
          if (m) target = buildWebHrefFromTgaddr(m[1] ?? m[0]);
        }
      }
    }

    if (!target) throw new Error("Не удалось определить целевой URL.");

    target = toTelegramA(target);
    const postId = extractPostId(link);
    const flowStart = Date.now();
    log.info(logCtx, `Перехожу на: ${target}`);
    activePage = await gotoTelegramTarget(page, target, link, logCtx, postId);
    log.info({ ...logCtx, stage: "goto", durationMs: Date.now() - flowStart }, "Этап goto завершён");

    await waitForChatOpened(activePage, logCtx, link);
    log.info({ ...logCtx, stage: "chat", durationMs: Date.now() - flowStart }, "Этап chat завершён");

    log.info(logCtx, `Ожидание превью/контента сообщения...`);
    try {
      if (postId) {
        log.info({ ...logCtx, postId }, `Ожидание сообщения #${postId}`);
        await waitForTargetMessage(activePage, postId, signal);
      } else {
        log.warn(logCtx, "postId не извлечён — fallback на первое сообщение");
        await waitForAnyMessageContent(activePage);
        await activePage.waitForTimeout(TG_SETTLE_MS);
      }
      await dismissTelegramModals(activePage, logCtx);
      log.info({ ...logCtx, stage: "message", durationMs: Date.now() - flowStart }, `✅ Контент готов`);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const pageUrl = activePage.url();
      const hash = await activePage.evaluate(() => window.location.hash).catch(() => "");
      log.error({ ...logCtx, err: errMsg, pageUrl, hash }, `⚠️ Тайм-аут или ошибка ожидания контента`);
      throw new Error(`TIMEOUT_OR_ERROR: Ошибка ожидания контента`);
    }

    const screenshotOptions: { fullPage: boolean; path?: string } = { fullPage: false };
    if (SETTINGS.TEST_SCREENSHOTS) {
      const timestamp = getCISDateString();
      const safeUrl = link.replace(/https?:\/\//, '').replace(/[\/:?=&]/g, '_').substring(0, 50);
      screenshotOptions.path = path.join(TEST_SCREENS_DIR, `tg_${timestamp}_${safeUrl}.png`);
    }

    await dismissTelegramModals(activePage, logCtx);
    const buffer = await activePage.screenshot(screenshotOptions);
    log.info({ ...logCtx, stage: "screenshot", durationMs: Date.now() - flowStart }, `✅ Скриншот сделан`);

    return buffer;
  } finally {
    signal?.removeEventListener('abort', abortNavigation);
  }
}
