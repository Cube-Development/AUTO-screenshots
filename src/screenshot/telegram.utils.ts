import fs from "fs";
import os from "os";
import path from "path";
import { chromium, Page } from "playwright";
import { log } from "../utils";
import { SETTINGS } from "../config";
import { ResourceType } from "../type";
import { TEST_SCREENS_DIR, getCISDateString } from "./utils";
import { extractPostId, waitForKTargetMessage } from "./telegram-message";

const TG_GOTO_TIMEOUT_MS = 60_000;
const TG_CHAT_OPEN_TIMEOUT_MS = 45_000;
const TG_CONTENT_TIMEOUT_MS = 60_000;
const TG_SETTLE_MS = 2_000;
const TG_AFTER_GOTO_MS = 800;
const TG_NAV_SETTLE_MS = 1_000;
const TG_MODAL_DISMISS_ATTEMPTS = 3;
const TG_MODAL_DISMISS_DELAY_MS = 300;
const TG_WARMUP_TIMEOUT_MS = 30_000;
const TG_AUTH_WAIT_MS = 15_000;
const TG_WS_SETTLE_MS = 1_000;
const TG_WS_STABLE_MS = 1_000;
const TG_APP_READY_TIMEOUT_MS = 15_000;

function extractPrivateChannelId(link: string): string | null {
  return link.match(/(?:t\.me|telegram\.me)\/c\/(\d+)/)?.[1] ?? null;
}

function isPrivatePostLink(link: string): boolean {
  return /(?:t\.me|telegram\.me)\/c\/\d+\/\d+/.test(link);
}

function toTelegramK(url: string): string {
  return url.replace(/web\.telegram\.org\/a\//, "web.telegram.org/k/");
}

export function buildWebHrefFromTgaddr(tgaddr: string) {
  if (!tgaddr) return null;
  if (/tg%3A|%3A/.test(tgaddr)) {
    if (tgaddr.startsWith("https://")) return toTelegramK(tgaddr);
    return "https://web.telegram.org/k/#?tgaddr=" + tgaddr.split("tgaddr=")[1];
  }
  const raw = tgaddr.startsWith("tg://") ? tgaddr : tgaddr;
  return "https://web.telegram.org/k/#?tgaddr=" + encodeURIComponent(raw);
}

export function tryResolvePrivatePostLink(link: string): string | null {
  const match = link.match(/(?:t\.me|telegram\.me)\/c\/(\d+)\/(\d+)/);
  if (!match) return null;
  const tgaddr = `tg://privatepost?channel=${match[1]}&post=${match[2]}`;
  return `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(tgaddr)}`;
}

export function tryResolveDirectTelegramKLink(link: string): string | null {
  const match = link.match(/(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)\/(\d+)/);
  if (!match || match[1] === "c") return null;
  const tgaddr = `tg://resolve?domain=${match[1]}&post=${match[2]}`;
  return `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(tgaddr)}`;
}

export async function ensureTelegramAuth(auth_path: string) {
  if (fs.existsSync(auth_path)) return;

  const tmpProfile = path.join(os.tmpdir(), `pw_profile_${Date.now()}`);
  fs.mkdirSync(tmpProfile, { recursive: true });

  const context = await chromium.launchPersistentContext(tmpProfile, { headless: false, viewport: { width: 1280, height: 800 } });
  const page = context.pages()[0] || await context.newPage();

  console.log("Открылся чистый профиль. Выполните вход в Telegram Web вручную.");
  await page.goto("https://web.telegram.org/k/");

  console.log("После успешного входа нажмите Enter в консоли.");
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: auth_path });
  await context.close();
  console.log("auth.json сохранён из чистого профиля.");
}

async function dismissKSuggestions(page: Page): Promise<void> {
  await page
    .locator(".chatlist-overlay .btn-icon.close, ._suggestionContainer_5ffcx_5 .close")
    .first()
    .click({ timeout: 1_000 })
    .catch(() => null);
}

async function dismissTelegramModals(page: Page, logCtx?: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < TG_MODAL_DISMISS_ATTEMPTS; i++) {
    try {
      const modal = await page.$(
        ".popup-container.active, .popup.active, .Modal.open, .Modal.shown, .Modal.error.shown.open, div.modal-dialog",
      );
      let btn = modal ? await modal.$("button, .btn-primary, .popup-close, div[role='button']") : null;

      if (!btn) {
        const okBtn = page.getByRole("button", { name: /^OK$/i });
        if (!(await okBtn.isVisible().catch(() => false))) break;
        btn = await okBtn.elementHandle();
      }

      if (!btn) break;

      const text = modal
        ? await modal.innerText().catch(() => "")
        : await page.locator(".Modal, .popup-container").first().innerText().catch(() => "");

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

async function warmupKSession(page: Page, logCtx: Record<string, unknown>): Promise<void> {
  log.info(logCtx, "Прогрев Telegram Web K...");
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded", timeout: TG_WARMUP_TIMEOUT_MS });
  await page
    .waitForFunction(() => {
      const auth = localStorage.getItem("user_auth");
      return auth !== null && auth !== "null" && auth.length > 0;
    }, null, { timeout: TG_AUTH_WAIT_MS })
    .catch(() => log.warn(logCtx, "user_auth не найден после прогрева, продолжаем"));
  await page.waitForTimeout(TG_WS_SETTLE_MS);
}

async function waitForKConnectionReady(page: Page, logCtx: Record<string, unknown>): Promise<void> {
  const wsResponse = page
    .waitForResponse((r) => /zws\d*[-.]?.*\.web\.telegram\.org/.test(r.url()) && r.status() < 400, {
      timeout: TG_APP_READY_TIMEOUT_MS,
    })
    .catch(() => null);

  await page
    .waitForFunction(
      () => {
        const auth = localStorage.getItem("user_auth");
        if (!auth || auth === "null" || auth.length === 0) return false;
        if (!document.getElementById("page-chats")) return false;
        return document.querySelector(".chatlist-chat, a[data-peer-id]") !== null;
      },
      null,
      { timeout: TG_APP_READY_TIMEOUT_MS },
    )
    .catch(() => log.warn(logCtx, "Минимальный UI gate timeout, продолжаем"));

  await wsResponse;
  await page.waitForTimeout(TG_WS_STABLE_MS);
  log.info(logCtx, "WS и sidebar готовы");
}

async function hasKChatContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (document.querySelectorAll("#column-center .bubble[data-mid]").length > 0) return true;
    const chat = document.querySelector("#column-center .chat.active");
    if (!chat) return false;
    return chat.querySelector(".bubbles, .bubbles-inner, .scrollable") !== null && chat.innerHTML.length > 800;
  });
}

async function setHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, hash);
}

async function navigatePrivatePost(page: Page, link: string, target: string, logCtx: Record<string, unknown>): Promise<void> {
  const channelId = extractPrivateChannelId(link);
  const postId = extractPostId(link);
  if (!channelId) return;

  const steps: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "assign-tgaddr",
      run: async () => {
        await page.evaluate((url) => location.assign(url), target);
      },
    },
    {
      name: `hash-#-${channelId}`,
      run: async () => setHash(page, `#-${channelId}`),
    },
    ...(postId
      ? [{ name: `hash-#-100${channelId}_${postId}`, run: async () => setHash(page, `#-100${channelId}_${postId}`) }]
      : []),
    {
      name: `hash-#-100${channelId}`,
      run: async () => setHash(page, `#-100${channelId}`),
    },
  ];

  for (const step of steps) {
    log.info({ ...logCtx, step: step.name }, "Private nav step");
    await step.run();
    await page.waitForTimeout(TG_NAV_SETTLE_MS);
    await dismissKSuggestions(page);
    await dismissTelegramModals(page, logCtx);
    if (await hasKChatContent(page)) return;
  }
}

async function waitForKChatOpen(page: Page, logCtx: Record<string, unknown>, link: string): Promise<void> {
  const channelId = extractPrivateChannelId(link);
  log.info(logCtx, "Ожидание открытия чата K...");

  await page
    .waitForFunction(
      (cid) => {
        if (document.querySelectorAll("#column-center .bubble[data-mid]").length > 0) return true;
        const hash = window.location.hash;
        if (cid && (hash.includes(`-${cid}`) || hash.includes(`-100${cid}`))) {
          return !!document.querySelector("#column-center .chat.active .bubbles, #column-center .bubbles");
        }
        return /^#-?\d/.test(hash) || /^#@/.test(hash);
      },
      channelId,
      { timeout: TG_CHAT_OPEN_TIMEOUT_MS },
    )
    .catch(() => log.warn(logCtx, "Chat open timeout, продолжаем"));

  const hash = await page.evaluate(() => window.location.hash);
  log.info({ ...logCtx, hash }, "Чат открыт");
}

async function waitForAnyMessageContent(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const selectors = [
      "#column-center .bubble[data-mid]",
      ".bubble.channel-post",
      ".Message", ".message", ".message-content", ".text-content",
      ".Message-content", ".media-container", ".message-text",
    ];
    const msg = selectors.map((s) => document.querySelector(s)).find((el) => el !== null) as HTMLElement | null;
    if (!msg) return false;

    const text = msg.innerText || "";
    const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
    const hasPreview = msg.querySelector(
      'img[src]:not([src=""]), .media-preview, .thumbnail, .video-preview, .media-container, .album-item, .preloader-container',
    ) !== null;
    const hasOtherMedia = msg.querySelector(".poll, .album, .attachment, video") !== null;
    return (hasText || hasPreview || hasOtherMedia) && msg.offsetHeight > 20;
  }, null, { timeout: TG_CONTENT_TIMEOUT_MS });
}

export async function handleTelegramLink(page: Page, link: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
  const logCtx = { id: reqId, type: ResourceType.TELEGRAM, url: link };
  const abortNavigation = () => { page.goto("about:blank").catch(() => { }); };
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
          if (hrefAttr.includes("web.telegram.org")) target = toTelegramK(hrefAttr);
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

    target = toTelegramK(target);
    const postId = extractPostId(link);
    const flowStart = Date.now();
    log.info(logCtx, `Перехожу на: ${target}`);

    if (isPrivatePostLink(link)) {
      await warmupKSession(page, logCtx);
      await waitForKConnectionReady(page, logCtx);
      await navigatePrivatePost(page, link, target, logCtx);
      await waitForKChatOpen(page, logCtx, link);
    } else {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: TG_GOTO_TIMEOUT_MS }).catch(() => null);
      await page.waitForTimeout(TG_AFTER_GOTO_MS);
      await dismissTelegramModals(page, logCtx);
    }

    log.info({ ...logCtx, stage: "goto", durationMs: Date.now() - flowStart }, "Этап goto завершён");

    log.info(logCtx, "Ожидание превью/контента сообщения...");
    try {
      if (postId) {
        const resolvedMid = await waitForKTargetMessage(page, postId, signal);
        if (!resolvedMid) throw new Error("Пост не найден в viewport");
        log.info({ ...logCtx, postId, resolvedMid }, "Контент K готов");
      } else {
        log.warn(logCtx, "postId не извлечён — fallback на первое сообщение");
        await waitForAnyMessageContent(page);
        await page.waitForTimeout(TG_SETTLE_MS);
      }
      await dismissTelegramModals(page, logCtx);
      log.info({ ...logCtx, stage: "message", durationMs: Date.now() - flowStart }, "Контент готов");
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const pageUrl = page.url();
      const hash = await page.evaluate(() => window.location.hash).catch(() => "");
      log.error({ ...logCtx, err: errMsg, pageUrl, hash }, "Тайм-аут или ошибка ожидания контента");
      throw new Error("TIMEOUT_OR_ERROR: Ошибка ожидания контента");
    }

    const screenshotOptions: { fullPage: boolean; path?: string } = { fullPage: false };
    if (SETTINGS.TEST_SCREENSHOTS) {
      const timestamp = getCISDateString();
      const safeUrl = link.replace(/https?:\/\//, "").replace(/[\/:?=&]/g, "_").substring(0, 50);
      const fileName = `tg_${timestamp}_${safeUrl}`;
      screenshotOptions.path = path.join(TEST_SCREENS_DIR, `${fileName}.png`);

      try {
        const htmlDir = path.join(path.dirname(TEST_SCREENS_DIR), "html");
        if (!fs.existsSync(htmlDir)) fs.mkdirSync(htmlDir, { recursive: true });

        let bodyHtml = await page.$eval("body", (el) => el.outerHTML);
        bodyHtml = bodyHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

        const beautify = require("js-beautify").html;
        const formatted = beautify(bodyHtml, {
          indent_size: 2,
          preserve_newlines: false,
          content_unformatted: ["script", "style"],
        });

        fs.writeFileSync(path.join(htmlDir, `${fileName}.html`), formatted);
        log.info({ ...logCtx, fileName: `${fileName}.html` }, "HTML дамп сохранён");
      } catch (err) {
        log.error({ ...logCtx, err }, "Ошибка при сохранении HTML");
      }
    }

    await dismissTelegramModals(page, logCtx);
    const buffer = await page.screenshot(screenshotOptions);
    log.info({ ...logCtx, stage: "screenshot", durationMs: Date.now() - flowStart }, "Скриншот сделан");

    return buffer;
  } finally {
    signal?.removeEventListener("abort", abortNavigation);
  }
}
