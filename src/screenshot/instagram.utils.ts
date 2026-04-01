import fs from "fs";
import os from "os";
import path from "path";
import { chromium, Page } from "playwright";
import { log } from "../utils";
import { SETTINGS } from "../config";
import { IErrorCallback, IPostCapture } from "../type";
import { TEST_SCREENS_DIR, getCISDateString } from "./utils";

export async function ensureInstagramAuth(auth_path: string) {
  if (fs.existsSync(auth_path)) return;

  const authDir = path.dirname(auth_path);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const tmpProfile = path.join(os.tmpdir(), `pw_ig_profile_${Date.now()}`);
  fs.mkdirSync(tmpProfile, { recursive: true });

  const context = await chromium.launchPersistentContext(tmpProfile, { 
    headless: false, 
    viewport: { width: 1280, height: 800 } 
  });
  const page = context.pages()[0] || await context.newPage();

  console.log("Открылся чистый профиль. Перехожу на страницу Instagram...");
  // Переходим на любой публичный пост, чтобы имитировать естественное поведение
  await page.goto("https://www.instagram.com/explore/", { waitUntil: "networkidle" });
  
  try {
    // Ищем кнопку "Log In" (может быть ссылкой или кнопкой)
    const loginButton = page.locator('span:has-text("Log in"), a[href*="/accounts/login"]', { hasText: /Log in/i }).first();
    if (await loginButton.isVisible()) {
      console.log("Найдена кнопка входа, нажимаю...");
      await loginButton.click();
    } else {
      console.log("Кнопка входа не найдена сразу, пробую перейти напрямую через безопасный редирект...");
      await page.goto("https://www.instagram.com/accounts/login/");
    }
  } catch (e) {
    console.log("Ошибка при поиске кнопки логина, пробую прямой переход.");
    await page.goto("https://www.instagram.com/accounts/login/");
  }

  console.log("Выполните вход в Instagram вручную в открывшемся окне.");
  console.log("После успешного входа нажмите Enter в консоли.");
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: auth_path });
  await context.close();
  console.log(`Instagram auth сохранён в: ${auth_path}`);
}

export async function captureInstagramPostScreenshot(page: Page, postUrl: string): Promise<IPostCapture | IErrorCallback> {
  // 1. Радикальная нормализация URL: Reels -> Post + удаление всех query params (igsh, etc)
  const urlObj = new URL(postUrl);
  urlObj.pathname = urlObj.pathname.replace(/\/reels\/|\/reel\//, '/p/');
  urlObj.search = ''; 
  const normalizedUrl = urlObj.toString();

  // Блокировка тяжелых/ненужных ресурсов для ускорения загрузки
  // ВАЖНО: НЕ блокировать facebook.com и fbcdn.net/rsrc.php — 
  // через них Instagram загружает JS-бандлы и CSS, без которых React не монтируется
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

  log.info(`Переход на URL: ${normalizedUrl}`);
  try {
    await page.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (navError: any) {
    if (navError.name === 'TimeoutError') {
      log.error(`❌ Страница не загрузилась за 30с: ${normalizedUrl}`);
      return { success: false, code: 1006, message: "PAGE_LOAD_TIMEOUT" };
    }
    throw navError;
  }

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
    log.info(`Аккаунт приватный | Post Url = ${normalizedUrl}`);
    return {
      success: false,
      code: 1002,
      message: "PRIVATE_ACCOUNT_INSTAGRAM",
    };
  }

  await closeInstagramDialogIfExists(page);

  log.info("Ожидание обложки (Video Cover)...");
  try {
    await page.waitForFunction(() => {
      const getImgInfo = (img: HTMLImageElement) => `src: ${img.src.substring(0, 50)}..., complete: ${img.complete}, naturalWidth: ${img.naturalWidth}`;

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
      const allImgs = Array.from(document.querySelectorAll('img')).filter(img => {
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
    log.info("✅ Обложка/Контент загружены");
  } catch (e: any) {
    log.warn(`⚠️ Тайм-аут ожидания обложки (10с): ${e.message}. Делаем скриншот как есть.`);
  }

  // Скрываем текст ошибки видео (версия V8)
  await page.evaluate(() => {
    const hide = (el: HTMLElement) => {
        if (el) {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
            el.style.setProperty('opacity', '0', 'important');
        }
    };

    const errorKeywords = [/Sorry, we're having trouble playing/i, /Learn more/i];
    
    // Ищем текст ошибки и скрываем родительский оверлей
    const spans = Array.from(document.querySelectorAll('article span'));
    spans.forEach(span => {
      if (errorKeywords[0].test(span.textContent || '')) {
        const overlay = (span as HTMLElement).closest('.x6s0dn4.xatbrnm') || (span as HTMLElement).closest('.x6s0dn4.x78zum5.xdt5ytf');
        if (overlay) hide(overlay as HTMLElement);
      }
    });

    // Скрываем Learn more
    const links = Array.from(document.querySelectorAll('article a'));
    links.forEach(link => {
       if (errorKeywords[1].test(link.textContent || '')) {
         const container = (link as HTMLElement).closest('.x6s0dn4');
         if (container) hide(container as HTMLElement);
         hide(link as HTMLElement);
       }
    });
  }).catch(() => null);

  const screenshotOptions: any = {
    type: 'png',
    clip: { x: 140, y: 0, width: 1000, height: 700 }
  };

  if (SETTINGS.TEST_SCREENSHOTS) {
    const timestamp = getCISDateString();
    const safeUrl = normalizedUrl.replace(/https?:\/\//, '').replace(/[\/:?=&]/g, '_').substring(0, 50);
    const fileName = `ig_${timestamp}_${safeUrl}`;
    
    screenshotOptions.path = path.join(TEST_SCREENS_DIR, `${fileName}.png`);

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
        log.info(`📄 HTML (Body + Beautify) дамп сохранен: ${fileName}.html`);
    } catch (err) {
        log.error(`Ошибка при сохранении HTML: ${err}`);
    }
  }

  const buffer = await page.screenshot(screenshotOptions);

  return { buffer, success: true };
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
