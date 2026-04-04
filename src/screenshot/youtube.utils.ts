import fs from "fs";
import os from "os";
import path from "path";
import { chromium, Page } from "playwright";
import { log } from "../utils";
import { TEST_SCREENS_DIR, getCISDateString } from "./utils";

const YT_SCREENS_DIR = path.join(TEST_SCREENS_DIR, "youtube");

if (!fs.existsSync(YT_SCREENS_DIR)) {
  fs.mkdirSync(YT_SCREENS_DIR, { recursive: true });
}

const INTERVAL_MS = 5_000;
const DURATION_MS = 20_000;
const TOTAL_SCREENSHOTS = Math.floor(DURATION_MS / INTERVAL_MS); // 4

/** Извлекает videoId из YouTube URL */
function extractVideoId(url: string): string {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? "unknown";
}

/** Ручная авторизация Google для YouTube — аналогично Telegram/Instagram */
export async function ensureYoutubeAuth(auth_path: string) {
  if (fs.existsSync(auth_path)) return;

  const dir = path.dirname(auth_path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpProfile = path.join(os.tmpdir(), `pw_yt_profile_${Date.now()}`);
  fs.mkdirSync(tmpProfile, { recursive: true });

  const context = await chromium.launchPersistentContext(tmpProfile, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] || await context.newPage();

  console.log("Открылся браузер. Выполните вход в Google аккаунт на YouTube.");
  await page.goto("https://accounts.google.com");

  console.log("После успешного входа нажмите Enter в консоли.");
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: auth_path });
  await context.close();
  console.log(`YouTube auth.json сохранён: ${auth_path}`);
}

/** Закрывает consent-баннер YouTube (GDPR), если он появился */
async function dismissConsentBanner(page: Page): Promise<void> {
  try {
    // Кнопки: "Accept all" (EN), "Accetta tutto" (IT), "Принять все" (RU)
    const selectors = [
      'button[aria-label*="Accept all"]',
      'button[aria-label*="Accetta tutto"]',
      'button[aria-label*="Принять"]',
      'form[action*="consent"] button[aria-label*="Accept"]',
      'tp-yt-paper-button.ytd-consent-bump-v2-lightbox',
      '[class*="consent"] button:has-text("Accept")',
      '[class*="consent"] button:has-text("Accetta")',
    ];

    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        log.info(`🍪 YouTube consent-баннер закрыт (селектор: ${sel})`);
        await page.waitForTimeout(1500);
        return;
      }
    }
  } catch { /* ignore */ }
}

/** 
 * Пропускает рекламу YouTube простым способом.
 * Проверяем, есть ли реклама в плеере. Если да — ждём до 15 секунд пока кнопка не станет видимой и кликаем её.
 */
export async function handleYoutubeAds(page: Page): Promise<void> {
  try {
    // Проверяем, находится ли плеер в режиме рекламы (быстрая проверка)
    const isAdPlaying = await page.evaluate(() => {
      const player = document.querySelector('#movie_player');
      return player && player.classList.contains('ad-showing');
    });

    if (isAdPlaying) {
      log.info("📺 Обнаружена реклама! Ждем кнопку пропуска (до 15 сек)...");

      const skipBtnSelectorExtended = ".ytp-skip-ad-button, .ytp-ad-skip-button-container, .ytp-ad-skip-button-modern";
      
      // Ждём, пока кнопка станет полностью видимой в DOM (уйдет opacity: 0 / display: none)
      const skipBtn = await page.waitForSelector(skipBtnSelectorExtended, { 
        state: 'visible', 
        timeout: 15_000 
      }).catch(() => null);

      if (skipBtn) {
        log.info("🎯 Кнопка 'Пропустить' найдена и видима. Нажимаем!");
        await skipBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000); // Даем время плееру переключиться на видео
      } else {
        log.warn("⚠️ Реклама идёт, но кнопка пропуска не стала видимой за 15 секунд");
      }
    }
  } catch (err) {
    log.debug(`ℹ️ Ошибка при проверке/пропуске рекламы: ${err}`);
  }
}

/**
 * Открывает YouTube-видео и делает серию скриншотов каждые 5 секунд в течение 2 минут.
 * Скриншоты сохраняются на диск.
 * 
 * @returns массив Buffer'ов всех сделанных скриншотов
 */
export async function captureYoutubeTimelapse(
  page: Page,
  url: string,
  signal?: AbortSignal
): Promise<Buffer[]> {
  const videoId = extractVideoId(url);
  const sessionTimestamp = getCISDateString();
  const sessionDir = path.join(YT_SCREENS_DIR, `${sessionTimestamp}_${videoId}`);
  
  fs.mkdirSync(sessionDir, { recursive: true });

  log.info(`▶️ YouTube timelapse | URL: ${url} | Video ID: ${videoId} | Скриншотов: ${TOTAL_SCREENSHOTS}`);

  // Загрузка страницы
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000);
  
  await dismissConsentBanner(page);

  // Сохраняем HTML страницы
  try {
    const htmlContent = await page.content();
    fs.writeFileSync(path.join(sessionDir, "page.html"), htmlContent, "utf-8");
    log.info(`📄 HTML страницы сохранён: page.html`);
  } catch (err) {
    log.warn(`⚠️ Не удалось сохранить HTML: ${err}`);
  }

  // Ждём появления плеера и запускаем воспроизведение, если нужно
  try {
    await page.waitForSelector("video, #movie_player", { timeout: 15_000 });
    log.info("🎬 YouTube плеер найден");

    // Пытаемся нажать Play, если видео на паузе
    const playButton = await page.$(".ytp-play-button");
    if (playButton) {
      const title = await playButton.getAttribute("data-title-no-tooltip") || "";
      const label = await playButton.getAttribute("aria-label") || "";
      
      // Проверяем на русском и английском
      const isPaused = /Смотреть|Play|Watch/i.test(title) || /Смотреть|Play|Watch/i.test(label);
      
      if (isPaused) {
        log.info("▶️ Видео на паузе, нажимаю Play...");
        await playButton.click();
        await page.waitForTimeout(1000); // Даем время на запуск
      }
    }
  } catch (err) {
    log.warn(`⚠️ Ошибка при подготовке плеера: ${err}`);
  }

  // Пропуск встроенной рекламы
  await handleYoutubeAds(page);

  // Ждем, чтобы кадр точно отрисовался
  await page.waitForTimeout(2000);

  const buffers: Buffer[] = [];

  for (let i = 0; i < TOTAL_SCREENSHOTS; i++) {
    if (signal?.aborted) {
      log.warn(`🛑 YouTube timelapse прерван по сигналу на кадре ${i}/${TOTAL_SCREENSHOTS}`);
      break;
    }

    const fileName = `yt_${videoId}_${String(i).padStart(2, "0")}.png`;
    const filePath = path.join(sessionDir, fileName);

    const buffer = await page.screenshot({ path: filePath });
    buffers.push(buffer);

    log.info(`📸 [${i + 1}/${TOTAL_SCREENSHOTS}] Скриншот сохранён: ${fileName}`);

    // Не ждём после последнего скриншота
    if (i < TOTAL_SCREENSHOTS - 1) {
      await page.waitForTimeout(INTERVAL_MS);
    }
  }

  log.success(`✅ YouTube timelapse завершён | ${buffers.length} скриншотов → ${sessionDir}`);
  return buffers;
}

/**
 * Одиночный скриншот YouTube (Продакшн)
 * Делает только 1 скриншот и возвращает Buffer.
 */
export async function captureYoutubeSingle(
  page: Page,
  url: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const videoId = extractVideoId(url);
  log.info(`📸 YouTube Single Shot | URL: ${url} | Video ID: ${videoId}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000);
  
  await dismissConsentBanner(page);

  // Подготовка плеера
  try {
    await page.waitForSelector("video, #movie_player", { timeout: 15_000 });
    const playButton = await page.$(".ytp-play-button");
    if (playButton) {
      const title = await playButton.getAttribute("data-title-no-tooltip") || "";
      const label = await playButton.getAttribute("aria-label") || "";
      if (/Смотреть|Play|Watch/i.test(title) || /Смотреть|Play|Watch/i.test(label)) {
        await playButton.click();
        await page.waitForTimeout(1000);
      }
    }
  } catch (err) {
    log.warn(`⚠️ Ошибка при подготовке плеера: ${err}`);
  }

  // Обработка возможной рекламы
  await handleYoutubeAds(page);

  // Ждем, чтобы кадр точно отрисовался
  await page.waitForTimeout(2000);

  if (signal?.aborted) throw new Error("Aborted");

  const buffer = await page.screenshot();
  log.success(`✅ YouTube Single Shot готов`);
  return buffer;
}
