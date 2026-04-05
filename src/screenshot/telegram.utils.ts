import fs from "fs";
import os from "os";
import path from "path";
import { chromium, Page } from "playwright";
import { log } from "../utils";
import { SETTINGS } from "../config";
import { ResourceType } from "../type";
import { TEST_SCREENS_DIR, getCISDateString } from "./utils";

export function buildWebHrefFromTgaddr(tgaddr: string) {
  if (!tgaddr) return null;
  if (/tg%3A|%3A/.test(tgaddr)) {
    if (tgaddr.startsWith("https://")) return tgaddr;
    return "https://web.telegram.org/a/#?tgaddr=" + tgaddr.split("tgaddr=")[1];
  }
  const raw = tgaddr.startsWith("tg://") ? tgaddr : tgaddr;
  return "https://web.telegram.org/a/#?tgaddr=" + encodeURIComponent(raw);
}

/**
 * Пробует создать прямую ссылку на Telegram Web K минуя t.me
 * Работает для ссылок вида t.me/channel/id
 */
export function tryResolveDirectTelegramKLink(link: string): string | null {
  const match = link.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
  if (match) {
    const channel = match[1];
    const postId = match[2];
    const tgaddr = `tg://resolve?domain=${channel}&post=${postId}`;
    // Используем версию /k/ для FastPath, так как она обычно быстрее
    return `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(tgaddr)}`;
  }
  return null;
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

export async function closeModalIfExists(page: Page) {
  try {
    const modal = await page.$("div.Modal.error.shown.open, div.modal-dialog, .Modal.shown");
    if (modal) {
      const btn = await modal.$("button, div[role='button'], .btn-primary");
      if (btn) {
        log.info("Закрываю модальное окно...");
        await btn.click().catch(() => null);
        await page.waitForTimeout(500);
      }
    }
  } catch {}
}

export async function handleTelegramLink(page: Page, link: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
  const logCtx = { id: reqId, type: ResourceType.TELEGRAM, url: link };
  // Подписка на аборт: мгновенно убиваем все ожидания на странице
  const abortNavigation = () => { page.goto('about:blank').catch(() => {}); };
  signal?.addEventListener('abort', abortNavigation, { once: true });

  try {
    let target = tryResolveDirectTelegramKLink(link);
    
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

    if (!target) throw new Error("Не удалось определить целевой URL.");

    log.info(logCtx, `Перехожу на: ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
    
    await page.waitForTimeout(1000);
    await closeModalIfExists(page);

    log.info(logCtx, `Ожидание отрисовки контента сообщения...`);
    try {
      await page.waitForFunction(() => {
          const selectors = [
            '.Message', '.message', '.message-content', '.bubble', '.text-content', 
            '.Message-content', '.media-container', '.message-text', '.text'
          ];
          const msg = selectors.map(s => document.querySelector(s)).find(el => el !== null) as HTMLElement;
          if (!msg) return false;
          
          const text = msg.innerText || "";
          const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
          const hasMedia = msg.querySelector('img, video, canvas, .media-container, .poll, .album') !== null;
          const reflectsReality = msg.offsetHeight > 20;

          return (hasText || hasMedia) && reflectsReality;
      }, null, { timeout: 30000 });
      
      await page.waitForTimeout(3000);
      log.info(logCtx, `✅ Контент готов`);
    } catch (e: any) {
      log.error({ ...logCtx, err: e.message }, `⚠️ Тайм-аут или ошибка ожидания контента`);
      throw new Error(`TIMEOUT_OR_ERROR: Ошибка ожидания контента`);
    }

    const screenshotOptions: any = { fullPage: true };
    if (SETTINGS.TEST_SCREENSHOTS) {
      const timestamp = getCISDateString();
      const safeUrl = link.replace(/https?:\/\//, '').replace(/[\/:?=&]/g, '_').substring(0, 50);
      screenshotOptions.path = path.join(TEST_SCREENS_DIR, `tg_${timestamp}_${safeUrl}.png`);
    }

    const buffer = await page.screenshot(screenshotOptions);
    log.info(logCtx, `✅ Скриншот сделан`);
    
    return buffer;
  } finally {
    signal?.removeEventListener('abort', abortNavigation);
  }
}
