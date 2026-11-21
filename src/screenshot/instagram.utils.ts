import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { log } from "../utils";
import { SETTINGS } from "../config";
import { ResourceType, SessionError } from "../type";
import { SCREENSHOT_EXTENSION, TEST_SCREENS_DIR, compressScreenshot, getCISDateString } from "./utils";

type TLogCtx = { id?: string; type: ResourceType; url: string };
type TClip = { x: number; y: number; width: number; height: number };

const POST_CLIP: TClip = { x: 140, y: 0, width: 1000, height: 700 };
const POST_PAINT_SETTLE_MS = 500;

/** /stories/<user>/ или /stories/<user>/<id>/ (ссылка «Поделиться» на конкретную сторис) */
const STORY_PATH = /^\/stories\/([^/]+)(?:\/(\d+))?\/?$/;
const STORY_WAIT_MS = 20_000;
const STORY_MEDIA_WAIT_MS = 15_000;
const STORY_POLL_MS = 300;
/** Без H.264 (Chromium из Playwright) Instagram вместо видео пишет эту ошибку */
const VIDEO_ERROR_TEXT = "text=/having trouble playing this video/i";

export interface IInstagramStoryUrl {
  username: string;
  /** null — открыть текущую сторис аккаунта */
  storyId: string | null;
}

export function parseInstagramStoryUrl(url: string): IInstagramStoryUrl | null {
  try {
    const match = new URL(url).pathname.match(STORY_PATH);
    return match ? { username: match[1], storyId: match[2] ?? null } : null;
  } catch {
    return null;
  }
}

/** Вкладки пула переиспользуются: route вешаем один раз на страницу, иначе обработчики копятся */
const routedPages = new WeakSet<Page>();

/**
 * Блокировка тяжелых/ненужных ресурсов для ускорения загрузки.
 * ВАЖНО: НЕ блокировать facebook.com и fbcdn.net/rsrc.php —
 * через них Instagram загружает JS-бандлы и CSS, без которых React не монтируется
 */
async function blockHeavyResources(page: Page): Promise<void> {
  if (routedPages.has(page)) return;
  routedPages.add(page);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    const type = route.request().resourceType();

    if (
      ['font'].includes(type) ||
      url.includes('google-analytics') ||
      url.includes('/logging/') ||
      url.includes('/api/v1/ads/')
    ) {
      return route.abort();
    }
    return route.continue();
  });
}

async function gotoInstagram(page: Page, url: string, logCtx: TLogCtx): Promise<void> {
  log.info(logCtx, `Переход на URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (navError: any) {
    if (navError.name === 'TimeoutError') {
      log.error(logCtx, `❌ Страница не загрузилась за 30с: ${url}`);
      throw new Error("PAGE_LOAD_TIMEOUT");
    }
    throw navError;
  }
  assertLoggedIn(page);
}

/** Без входа Instagram редиректит на страницу логина — сессия протухла */
function assertLoggedIn(page: Page): void {
  if (page.url().includes("/accounts/login")) {
    throw new SessionError("SESSION_EXPIRED", "Редирект на /accounts/login");
  }
}

/** Снимок области + дебаг-дамп (TEST_SCREENSHOTS): PNG от Playwright → JPEG */
async function shoot(page: Page, clip: TClip, normalizedUrl: string, logCtx: TLogCtx): Promise<Buffer> {
  let debugFilePath: string | null = null;

  if (SETTINGS.TEST_SCREENSHOTS) {
    const timestamp = getCISDateString();
    const safeUrl = normalizedUrl.replace(/https?:\/\//, '').replace(/[\/:?=&]/g, '_').substring(0, 50);
    const fileName = `ig_${timestamp}_${safeUrl}`;

    debugFilePath = path.join(TEST_SCREENS_DIR, `${fileName}.${SCREENSHOT_EXTENSION}`);

    // Сохраняем только BODY HTML (без мусора из HEAD)
    try {
        const htmlDir = path.join(path.dirname(TEST_SCREENS_DIR), 'html');
        if (!fs.existsSync(htmlDir)) fs.mkdirSync(htmlDir, { recursive: true });

        let bodyHtml = await page.$eval('body', el => el.outerHTML);
        // Дополнительно вырезаем скрипты для чистоты
        bodyHtml = bodyHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

        // Используем библиотеку для профессионального форматирования
        const beautify = require('js-beautify').html;
        const formatted = beautify(bodyHtml, {
            indent_size: 2,
            preserve_newlines: false,
            content_unformatted: ['script', 'style']
        });

        fs.writeFileSync(path.join(htmlDir, `${fileName}.html`), formatted);
        log.info(logCtx, `📄 HTML (Body + Beautify) дамп сохранен: ${fileName}.html`);
    } catch (err) {
        log.error({ ...logCtx, err }, `Ошибка при сохранении HTML`);
    }
  }

  const png = await page.screenshot({ type: 'png', clip });
  const buffer = await compressScreenshot(png);
  if (debugFilePath) fs.writeFileSync(debugFilePath, buffer);
  log.info(logCtx, `✅ Скриншот сделан (${png.length >> 10}KB png → ${buffer.length >> 10}KB jpg)`);
  return buffer;
}

/** Пост, рилс или сторис — по виду ссылки */
export async function captureInstagramPostScreenshot(page: Page, postUrl: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
  const logCtx: TLogCtx = { id: reqId, type: ResourceType.INSTAGRAM, url: postUrl };
  // Подписка на аборт: мгновенно убиваем все ожидания на странице
  const abortNavigation = () => { page.goto('about:blank').catch(() => {}); };
  signal?.addEventListener('abort', abortNavigation, { once: true });

  try {
    await blockHeavyResources(page);
    const story = parseInstagramStoryUrl(postUrl);
    return story ? await captureStory(page, story, logCtx) : await capturePost(page, postUrl, logCtx);
  } finally {
    signal?.removeEventListener('abort', abortNavigation);
  }
}

async function capturePost(page: Page, postUrl: string, logCtx: TLogCtx): Promise<Buffer> {
    // 1. Радикальная нормализация URL: Reels -> Post + удаление всех query params (igsh, etc)
    const urlObj = new URL(postUrl);
    urlObj.pathname = urlObj.pathname.replace(/\/reels\/|\/reel\//, '/p/');
    urlObj.search = '';
    const normalizedUrl = urlObj.toString();

    await gotoInstagram(page, normalizedUrl, logCtx);

    // 2. Инъекция CSS для скрытия оверлея ошибки (надежнее, чем JS)
    await page.addStyleTag({
      content: `
        /* Скрываем оверлей ошибки по классам из дампа (строка 300) */
        div.x6s0dn4.xatbrnm.x9f619.x78zum5.x5yr21d.xl56j7k {
          display: none !important;
          opacity: 0 !important;
          visibility: hidden !important;
        }
        /* Скрываем текст ошибки и ссылку "Learn more" */
        span:has-text("Sorry, we're having trouble playing this video"),
        a[aria-label*="Learn more about video playback issues"] {
          display: none !important;
        }
      `
    }).catch(() => null);

    const privateH2 = await page.$('h2:has-text("This account is private")');

    if (privateH2) {
      log.info(logCtx, `Аккаунт приватный`);
      throw new Error("PRIVATE_ACCOUNT_INSTAGRAM");
    }

    await closeInstagramDialogIfExists(page);

    log.info(logCtx, "Ожидание обложки (Video Cover)...");
    try {
      await page.waitForFunction(() => {
        const getImgInfo = (img: HTMLImageElement) => `src: ${img.src.substring(0, 50)}..., complete: ${img.complete}, naturalWidth: ${img.naturalWidth}`;

        // Пока висит заставка (#splash-screen с логотипом 160px), main ещё нет — иначе логотип сойдёт за контент
        if (!document.querySelector('main')) return false;

        // 0. Видео рилса: ждём первый кадр. Без H.264 (Chromium из Playwright) <video> не появляется вовсе — идём к картинкам
        const video = Array.from(document.querySelectorAll('main video')).find((v) => v.getBoundingClientRect().width > 200) as HTMLVideoElement | undefined;
        const canPlayH264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
        if (video && canPlayH264) {
          if (video.readyState >= 2) console.log(`[Wait] ✅ Video frame ready (readyState=${video.readyState})`);
          return video.readyState >= 2;
        }

        // 1. Поиск через data-instancekey (Reels/Video контейнер)
        const videoContainer = document.querySelector('[data-instancekey^="id-vpuid"]');
        if (videoContainer) {
          const coverImg = videoContainer.querySelector('img');
          if (coverImg && coverImg.complete && coverImg.naturalWidth > 0) {
            console.log(`[Wait] ✅ Found cover via data-instancekey: ${getImgInfo(coverImg)}`);
            return true;
          }
        }

        // 2. Поиск через специальный aria-label (дизайн Video player)
        const videoPlayer = document.querySelector('div[role="group"][aria-label="Video player"]');
        if (videoPlayer) {
          const coverImg = videoPlayer.querySelector('img');
          if (coverImg && coverImg.complete && coverImg.naturalWidth > 0) {
            console.log(`[Wait] ✅ Found cover via aria-label: ${getImgInfo(coverImg)}`);
            return true;
          }
        }

        // 3. Фолбэк для постов и Reels без специфичных оберток
        // Ищем все крупные изображения (больше 100px), которые могут быть контентом
        const allImgs = Array.from(document.querySelectorAll('main img')).filter((img): img is HTMLImageElement => img instanceof HTMLImageElement).filter(img => {
          // Исключаем аватарки и мелкие иконки по размеру или классам (аватарки обычно скругленные или в специальных контейнерах)
          return img.naturalWidth > 100 && !img.closest('header');
        });

        if (allImgs.length > 0) {
          const allLoaded = allImgs.every(img => img.complete && img.naturalWidth > 0);
          if (allLoaded) {
             console.log(`[Wait] ✅ All content images loaded (${allImgs.length}): ${allImgs.map(getImgInfo).join(' | ')}`);
             return true;
          }
        }

        return false;
      }, null, { timeout: 10000, polling: 200 });
      log.info(logCtx, "✅ Обложка/Контент загружены");
      // complete ≠ отрисована: слайд карусели проявляется анимацией — без этого бывает серый прямоугольник
      await page.evaluate(() =>
        Promise.race([
          Promise.all(Array.from(document.querySelectorAll('main img')).map((img) => (img as HTMLImageElement).decode().catch(() => null))),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
      ).catch(() => null);
      await page.waitForTimeout(POST_PAINT_SETTLE_MS);
    } catch (e: any) {
      log.warn({ ...logCtx, err: e.message }, `⚠️ Тайм-аут ожидания обложки (10с). Делаем скриншот как есть.`);
    }

    const videoWithoutH264 = await page.evaluate(() =>
      Boolean(document.querySelector('main video, [data-instancekey^="id-vpuid"], div[role="group"][aria-label="Video player"]')) &&
      document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') === ''
    ).catch(() => false);
    if (videoWithoutH264) {
      log.warn(logCtx, `⚠️ Видео не воспроизводится (нет H.264) — в кадре обложка или чёрный экран. Установите Chrome: sudo npx playwright install --with-deps chrome`);
    }

    await hideVideoError(page, 'article');

    return shoot(page, POST_CLIP, normalizedUrl, logCtx);
}

/** Скрываем текст ошибки видео (версия V8) */
async function hideVideoError(page: Page, scope: string): Promise<void> {
    await page.evaluate((scope) => {
      const hide = (el: HTMLElement) => {
          if (el) {
              el.style.setProperty('display', 'none', 'important');
              el.style.setProperty('visibility', 'hidden', 'important');
              el.style.setProperty('opacity', '0', 'important');
          }
      };

      const errorKeywords = [/Sorry, we're having trouble playing/i, /Learn more/i];

      // Ищем текст ошибки и скрываем родительский оверлей
      const spans = Array.from(document.querySelectorAll(`${scope} span`));
      spans.forEach(span => {
        if (errorKeywords[0].test(span.textContent || '')) {
          const overlay = (span as HTMLElement).closest('.x6s0dn4.xatbrnm') || (span as HTMLElement).closest('.x6s0dn4.x78zum5.xdt5ytf');
          if (overlay) hide(overlay as HTMLElement);
        }
      });

      // Скрываем Learn more
      const links = Array.from(document.querySelectorAll(`${scope} a`));
      links.forEach(link => {
         if (errorKeywords[1].test(link.textContent || '')) {
           const container = (link as HTMLElement).closest('.x6s0dn4');
           if (container) hide(container as HTMLElement);
           hide(link as HTMLElement);
         }
      });
    }, scope).catch(() => null);
}

type TStoryState = "gate" | "media" | "video_error" | "unavailable" | "left";

/** Крупное медиа сторис загружено: у видео есть кадр, у картинки — пиксели */
const storyMediaReady = (page: Page) =>
  page.evaluate(() => {
    const video = Array.from(document.querySelectorAll("section video")).find((v) => v.getBoundingClientRect().width > 300) as HTMLVideoElement | undefined;
    if (video) return video.readyState >= 2;
    const img = Array.from(document.querySelectorAll("section img")).find((i) => i.getBoundingClientRect().width > 300) as HTMLImageElement | undefined;
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }).catch(() => false);

/** Что показал просмотрщик сторис: гейт «View as …?», саму сторис, ошибку или ушёл со /stories/ */
async function waitStoryState(page: Page, timeoutMs: number, withGate: boolean): Promise<TStoryState | null> {
  const deadline = Date.now() + timeoutMs;
  const gate = page.getByRole("button", { name: /^view story$/i }).first();
  while (Date.now() < deadline) {
    assertLoggedIn(page);
    // Нет активных сторис (или аккаунт закрыт) — Instagram уводит на профиль
    if (!new URL(page.url()).pathname.startsWith("/stories/")) return "left";
    if (await page.getByText(/sorry, this page isn't available/i).first().isVisible().catch(() => false)) return "unavailable";
    if (withGate && (await gate.isVisible().catch(() => false))) return "gate";
    if (await storyMediaReady(page)) return "media";
    if (await page.locator(VIDEO_ERROR_TEXT).first().isVisible().catch(() => false)) return "video_error";
    await page.waitForTimeout(STORY_POLL_MS);
  }
  return null;
}

/** Карточка сторис (с автором и временем): поднимаемся от медиа/кнопок до блока почти во всю высоту окна */
async function storyCardClip(page: Page): Promise<TClip> {
  const clip = await page.evaluate(() => {
    const big = (el: Element) => el.getBoundingClientRect().width > 300;
    const media = Array.from(document.querySelectorAll("section video, section img")).find(big);
    const control = document.querySelector('section svg[aria-label="Play"], section svg[aria-label="Pause"], section svg[aria-label="Menu"]');
    let card: Element | null = media ?? control;
    while (card && card.parentElement && card.getBoundingClientRect().height < window.innerHeight * 0.8) card = card.parentElement;
    if (media && card) {
      // Медиа на всю карточку: берём самый внешний блок той же ширины
      const width = card.getBoundingClientRect().width;
      while (card.parentElement && Math.abs(card.parentElement.getBoundingClientRect().width - width) < 2) card = card.parentElement;
    }
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return rect.width > 200 && rect.width < window.innerWidth ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  });
  if (clip) return clip;
  const viewport = page.viewportSize() ?? { width: 1280, height: 1200 };
  return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

/**
 * Сторис: просмотрщик /stories/<user>/<id>/. Instagram спрашивает «View as …?» — подтверждаем (аккаунт сессии
 * попадёт в зрители), ставим на паузу, чтобы сторис не перелистнулась, и снимаем карточку.
 * Протухшую сторис Instagram молча подменяет текущей — сверяем id в адресе, чтобы не снять чужую
 */
async function captureStory(page: Page, story: IInstagramStoryUrl, logCtx: TLogCtx): Promise<Buffer> {
  const normalizedUrl = `https://www.instagram.com/stories/${story.username}/${story.storyId ? `${story.storyId}/` : ""}`;
  await gotoInstagram(page, normalizedUrl, logCtx);

  let state = await waitStoryState(page, STORY_WAIT_MS, true);
  if (state === "gate") {
    // Подмену протухшей сторис видно уже до гейта
    assertStoryId(page, story);
    await page.getByRole("button", { name: /^view story$/i }).first().click({ timeout: 5_000 });
    state = await waitStoryState(page, STORY_MEDIA_WAIT_MS, false);
  }

  if (state === "left") {
    if (await page.locator('h2:has-text("This account is private")').first().isVisible().catch(() => false)) {
      log.info(logCtx, `Аккаунт приватный`);
      throw new Error("PRIVATE_ACCOUNT_INSTAGRAM");
    }
    log.info({ ...logCtx, finalUrl: page.url() }, `Активных сторис нет`);
    throw new Error("STORY_NOT_AVAILABLE");
  }
  if (state === "unavailable") throw new Error("STORY_NOT_FOUND");

  // Сразу на паузу: картинка висит ~5 с, потом просмотрщик листает дальше
  await page.locator('section svg[aria-label="Pause"]').first().click({ timeout: 2_000 }).catch(() => null);
  await page.evaluate(() => document.querySelectorAll("video").forEach((video) => video.pause())).catch(() => null);
  assertStoryId(page, story);

  if (state === "video_error") {
    log.warn(logCtx, `⚠️ Видео сторис не воспроизводится (нет H.264) — будет чёрный кадр. Установите Chrome: sudo npx playwright install --with-deps chrome`);
    await hideVideoError(page, 'section');
  } else if (state === null) {
    log.warn(logCtx, `⚠️ Медиа сторис не загрузилось за ${STORY_MEDIA_WAIT_MS / 1000}с. Делаем скриншот как есть.`);
  } else {
    log.info(logCtx, "✅ Сторис загружена");
  }

  return shoot(page, await storyCardClip(page), normalizedUrl, logCtx);
}

function assertStoryId(page: Page, story: IInstagramStoryUrl): void {
  if (story.storyId && !page.url().includes(`/${story.storyId}`)) {
    throw new Error("STORY_EXPIRED");
  }
}

export async function acceptInstagramCookiesIfExists(page: Page) {
  try {
    // Расширенный список селекторов для кнопок куки
    const selectors = [
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept all")',
      'button:has-text("Разрешить все куки")',
      'button:has-text("Принять все")',
      'button._a9--._a9_0', // Класс кнопки "Allow"
      '[role="dialog"] button:first-child'
    ];

    for (const selector of selectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible()) {
        await btn.click().catch(() => null);
        log.info(`Принял куки через: ${selector}`);
        await page.waitForTimeout(500);
        return;
      }
    }
    log.warn("Кнопка 'Allow all cookies' не найдена, продолжаем");
  } catch (e) {
    log.error(`Ошибка при попытке принять куки: ${JSON.stringify(e)}`);
  }
}

export async function closeInstagramDialogIfExists(page: Page) {
  const dialog = await page.$('div[role="dialog"]');
  if (dialog) {
    const btn = await dialog.$('div[role="button"] svg');
    if (btn) {
      const btnWrapper = await btn.evaluateHandle(node => node.parentElement);
      await btnWrapper.asElement()?.click().catch(() => null);
    }
  }
}
