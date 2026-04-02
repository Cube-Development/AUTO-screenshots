import fs from "fs";
import path from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { 
    captureInstagramPostScreenshot, 
    ensureInstagramAuth, 
    ensureTelegramAuth, 
    handleTelegramLink, 
    uploadScreenshot 
} from "../screenshot";
import { log, PagePool } from "../utils";
import { getUploadLink } from "../api";
import { IErrorCallback, IPostCapture, IPostScreenshotResponse } from "../type";
import { SETTINGS } from "../config";

/** Утилита для создания прерывающего промиса (гонки) */
function createAbortRace(signal?: AbortSignal) {
    if (!signal) return { abortPromise: new Promise<never>(() => {}), cleanupAbort: () => {} };
    
    let cleanupAbort: () => void = () => {};
    const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(new Error('ABORTED_BY_CLIENT'));
        const handler = () => reject(new Error('ABORTED_BY_CLIENT'));
        signal.addEventListener('abort', handler, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', handler);
    });
    
    return { abortPromise, cleanupAbort };
}

export class ScreenshotService {
    private static instance: ScreenshotService;
    private readonly MAX_CONCURRENT = SETTINGS.MAX_SCREENSHOT_LIMIT;

    private sharedBrowser: Browser | null = null;
    private browserPromise: Promise<Browser> | null = null;
    
    private instagramContext: BrowserContext | null = null;
    private igContextPromise: Promise<BrowserContext> | null = null;

    private telegramContexts = new Map<string, BrowserContext>();
    private tgContextPromises = new Map<string, Promise<BrowserContext>>();

    // Пулы вкладок: каждый пул = N переиспользуемых Page
    private telegramPagePools = new Map<string, PagePool>();
    private instagramPagePool: PagePool | null = null;

    constructor() {}

    public static getInstance(): ScreenshotService {
        if (!ScreenshotService.instance) {
            ScreenshotService.instance = new ScreenshotService();
        }
        return ScreenshotService.instance;
    }

    /** Прогрев браузера и контекстов при старте сервера */
    public async init(): Promise<void> {
        log.info("🚀 Прогрев браузера и контекстов...");
        const browser = await this.getBrowser();
        
        // Instagram
        const ig_auth = `src/auth/instagram/auth.json`;

        log.info(`🤖 Прогрев Instagram...`);
        await ensureInstagramAuth(ig_auth);
        await this.getInstagramContext(browser, ig_auth);

        // Telegram: сканируем все папки ботов
        const tg_base_path = `src/auth/telegram`;
        if (fs.existsSync(tg_base_path)) {
            const files = fs.readdirSync(tg_base_path);
            for (const file of files) {
                if (file.startsWith('user_bot_')) {
                    const botId = file.replace('user_bot_', '');
                    const tg_auth = path.join(tg_base_path, file, 'auth.json');
                    
                    log.info(`🤖 Прогрев Telegram для бота ${botId}...`);
                    await ensureTelegramAuth(tg_auth);
                    await this.getTelegramContext(browser, botId, tg_auth);
                }
            }
        }

        log.success("✅ Браузер и все контексты (IG + все TG боты) прогреты");
    }

    private async getBrowser(): Promise<Browser> {
        if (this.sharedBrowser?.isConnected()) return this.sharedBrowser;
        if (this.browserPromise) return this.browserPromise;

        this.browserPromise = chromium.launch({ 
            headless: true,
            args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox']
        }).then(b => {
            this.sharedBrowser = b;
            this.browserPromise = null;
            log.info("🌐 Chromium запущен (shared instance)");

            // Изоляция: при падении Chromium сбрасываем состояние без краша процесса
            b.on('disconnected', () => {
                log.warn("⚠️ Chromium отключился неожиданно, сбрасываем состояние...");
                this.resetBrowserState();
            });

            return b;
        }).catch(err => {
            this.browserPromise = null;
            log.error(`❌ Не удалось запустить Chromium: ${err}`);
            throw err;
        });
        return this.browserPromise;
    }

    /** Сброс состояния при падении браузера — контексты и пулы становятся невалидными */
    private resetBrowserState(): void {
        this.sharedBrowser = null;
        this.browserPromise = null;
        this.instagramContext = null;
        this.igContextPromise = null;
        // Сбрасываем пулы (освобождаем ожидающих)
        if (this.instagramPagePool) {
            this.instagramPagePool.reset();
            this.instagramPagePool = null;
        }
        for (const pool of this.telegramPagePools.values()) {
            pool.reset();
        }
        this.telegramContexts.clear();
        this.tgContextPromises.clear();
        this.telegramPagePools.clear();
        log.warn("🔄 Состояние браузера сброшено, следующий запрос создаст новый инстанс");
    }

    private async getInstagramContext(browser: Browser, authPath: string): Promise<BrowserContext> {
        if (this.instagramContext) return this.instagramContext;
        
        if (this.igContextPromise) {
            log.info("⏳ Ожидание инициализации Instagram context...");
            return this.igContextPromise;
        }

        this.igContextPromise = browser.newContext({
            storageState: authPath,
            viewport: { width: 1280, height: 1200 }
        }).then(ctx => {
            this.instagramContext = ctx;
            this.igContextPromise = null;
            log.info("📸 Instagram shared context создан (кеширование включено)");
            return ctx;
        });
        
        return this.igContextPromise;
    }

    private async getTelegramContext(browser: Browser, botId: string, authPath: string): Promise<BrowserContext> {
        const existing = this.telegramContexts.get(botId);
        if (existing) return existing;

        const existingPromise = this.tgContextPromises.get(botId);
        if (existingPromise) return existingPromise;

        const promise = browser.newContext({
            storageState: authPath,
            viewport: { width: 1280, height: 1600 },
        }).then(ctx => {
            this.telegramContexts.set(botId, ctx);
            this.tgContextPromises.delete(botId);
            log.info(`📸 Telegram context для бота ${botId} создан (кеширование включено)`);
            return ctx;
        });

        this.tgContextPromises.set(botId, promise);
        return promise;
    }

    public async close(): Promise<void> {
        // Сбрасываем пулы
        for (const [botId, pool] of this.telegramPagePools) {
            pool.reset();
            log.info(`🗂️ Пул TG:${botId} сброшен`);
        }
        this.telegramPagePools.clear();

        if (this.instagramPagePool) {
            this.instagramPagePool.reset();
            this.instagramPagePool = null;
            log.info("🗂️ Пул IG сброшен");
        }

        // Закрываем контексты
        for (const [botId, context] of this.telegramContexts) {
            await context.close().catch(() => null);
            log.info(`📸 Telegram context для бота ${botId} закрыт`);
        }
        this.telegramContexts.clear();
        this.tgContextPromises.clear();

        if (this.instagramContext) {
            await this.instagramContext.close().catch(() => null);
            this.instagramContext = null;
            log.info("📸 Instagram context закрыт");
        }
        if (this.sharedBrowser && this.sharedBrowser.isConnected()) {
            await this.sharedBrowser.close();
            this.sharedBrowser = null;
            log.info("🌐 Chromium закрыт");
        }
    }

    private isTelegramUrl(url: string): boolean {
        return /^https:\/\/t\.me\//.test(url);
    }

    private isInstagramUrl(url: string): boolean {
        return /^https:\/\/www\.instagram\.com\//.test(url);
    }

    /** Получить или создать пул для Telegram бота (изолированные контексты) */
    private getTelegramPagePool(browser: Browser, botId: string, authPath: string): PagePool {
        let pool = this.telegramPagePools.get(botId);
        if (!pool) {
            pool = new PagePool(browser, authPath, { width: 1280, height: 1600 }, this.MAX_CONCURRENT, `TG:${botId}`);
            this.telegramPagePools.set(botId, pool);
            log.info(`🗂️ Пул TG:${botId} создан (макс: ${this.MAX_CONCURRENT}, изолированные контексты)`);
        }
        return pool;
    }

    /** Получить или создать пул для Instagram (изолированные контексты) */
    private getInstagramPagePool(browser: Browser, authPath: string): PagePool {
        if (!this.instagramPagePool) {
            this.instagramPagePool = new PagePool(browser, authPath, { width: 1280, height: 1200 }, this.MAX_CONCURRENT, "IG");
            log.info(`🗂️ Пул IG создан (макс: ${this.MAX_CONCURRENT}, изолированные контексты)`);
        }
        return this.instagramPagePool;
    }
    /** Общий паттерн: acquire → Promise.race(work, abort) → release */
    private async executeInPool(
        pool: PagePool,
        workFn: (page: Page) => Promise<Buffer>,
        url: string,
        signal?: AbortSignal,
        reqId?: string
    ): Promise<Buffer> {
        const page = await pool.acquire(signal, reqId);
        log.info(`🗂️ Вкладка получена для ${url}${reqId ? ` [ID:${reqId}]` : ''}`);

        try {
            return await workFn(page);
        } finally {
            pool.release(page);
            log.info(`🗂️ Слот освобождён (${url})${reqId ? ` [ID:${reqId}]` : ''}`);
        }
    }

    /** Подготовка и захват скриншота Telegram */
    private async captureTelegram(browser: Browser, url: string, botId: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
        log.info(`Обработка Telegram URL | Post Url = ${url} | User Bot ID = ${botId}${reqId ? ` [ID:${reqId}]` : ''}`);
        const auth_path = `src/auth/telegram/user_bot_${botId}/auth.json`;
        await ensureTelegramAuth(auth_path);

        const pool = this.getTelegramPagePool(browser, botId, auth_path);
        return this.executeInPool(pool, (page) => handleTelegramLink(page, url, signal), url, signal, reqId);
    }

    /** Подготовка и захват скриншота Instagram */
    private async captureInstagram(browser: Browser, url: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
        log.info(`Обработка Instagram URL | Post Url = ${url}`);
        const auth_path = `src/auth/instagram/auth.json`;
        await ensureInstagramAuth(auth_path);

        const pool = this.getInstagramPagePool(browser, auth_path);
        return this.executeInPool(pool, (page) => captureInstagramPostScreenshot(page, url, signal), url, signal, reqId);
    }

    public async capture(url: string, user_bot_id?: string, signal?: AbortSignal, reqId?: string): Promise<IPostScreenshotResponse | IErrorCallback> {
        // Глобальный Promise.race для всего флоу (Playwright + S3)
        const { abortPromise, cleanupAbort } = createAbortRace(signal);

        const workPromise = async (): Promise<IPostScreenshotResponse | IErrorCallback> => {
            const browser = await this.getBrowser();
            let screenshot: Buffer;

            // 1. Получаем скриншот (внутри executeInPool нет своей гонки, все полагается на внешнюю)
            if (this.isTelegramUrl(url)) {
                screenshot = await this.captureTelegram(browser, url, user_bot_id || "1", signal, reqId);
            } else if (this.isInstagramUrl(url)) {
                screenshot = await this.captureInstagram(browser, url, signal, reqId);
            } else {
                return { success: false, code: 1003, message: "UNSUPPORTED_URL" };
            }

            // ЖЕСТКИЙ СТОП для фонового промиса: 
            // Это нужно, потому что Promise.race не отменяет сам фоновый промис (JS не умеет).
            if (signal?.aborted) throw new Error("ABORTED_BY_CLIENT");

            const uploadData = await getUploadLink(signal);
            
            // ЖЕСТКИЙ СТОП перед долгой загрузкой
            if (signal?.aborted) throw new Error("ABORTED_BY_CLIENT");

            log.info(`Загружаем скриншот в хранилище... | Post Url = ${url} | File name = ${uploadData.file_name}`);
            await uploadScreenshot(uploadData.url, screenshot, signal);
            log.success(`✅ Скриншот готов и загружен | Post Url = ${url}`);

            return { success: true, file_name: uploadData.file_name, buffer: screenshot };
        };

        try {
            return await Promise.race([workPromise(), abortPromise]);
        } catch (error: any) {
            const errorMsg = error.message || String(error);
            log.error(`💥 Ошибка во время выполнения capture | Post Url = ${url} | Error: ${errorMsg}`);
            return { 
                success: false, 
                code: 1004, 
                message: `SCREENSHOT_FAILED: ${errorMsg}`
            };
        } finally {
            cleanupAbort();
        }
    }
}
