import fs from "fs";
import path from "path";
import { Browser, chromium, Page } from "playwright";
import { getUploadLink } from "../api";
import { SETTINGS } from "../config";
import {
    captureInstagramPostScreenshot,
    captureYoutubeSingle,
    captureYoutubeTimelapse,
    ensureInstagramAuth,
    ensureTelegramAuth,
    ensureYoutubeAuth,
    handleTelegramLink,
    uploadScreenshot
} from "../screenshot";
import { IErrorCallback, IPostScreenshotResponse, IYoutubeDebugResponse, ResourceType } from "../type";
import { log, PagePool, determineResourceType } from "../utils";

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
    
    // Пулы вкладок: каждый пул = N изолированных контекстов (PagePool)
    private telegramPagePools = new Map<string, PagePool>();
    private instagramPagePool: PagePool | null = null;
    private youtubePagePool: PagePool | null = null;

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
        
        await this.initInstagram(browser);
        await this.initTelegram(browser);
        await this.initYoutube(browser);

        log.success("✅ Браузер и все контексты (IG + TG + YT) прогреты");
    }

    private async initInstagram(browser: Browser): Promise<void> {
        const ig_auth = `src/auth/instagram/auth.json`;
        log.info(`🤖 Прогрев Instagram...`);
        await ensureInstagramAuth(ig_auth);
        this.getInstagramPagePool(browser, ig_auth);
        log.info("📸 Instagram пул готов");
    }

    private async initTelegram(browser: Browser): Promise<void> {
        const tg_base_path = `src/auth/telegram`;
        if (fs.existsSync(tg_base_path)) {
            const files = fs.readdirSync(tg_base_path);
            for (const file of files) {
                if (file.startsWith('user_bot_')) {
                    const botId = file.replace('user_bot_', '');
                    const tg_auth = path.join(tg_base_path, file, 'auth.json');
                    
                    log.info(`🤖 Прогрев Telegram для бота ${botId}...`);
                    await ensureTelegramAuth(tg_auth);
                    this.getTelegramPagePool(browser, botId, tg_auth);
                }
            }
        }
    }

    private async initYoutube(browser: Browser): Promise<void> {
        const yt_auth = `src/auth/youtube/auth.json`;
        log.info(`🤖 Прогрев YouTube...`);
        await ensureYoutubeAuth(yt_auth);
        this.getYoutubePagePool(browser, yt_auth);
        log.info("📸 YouTube пул готов");
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

    /** Сброс состояния при падении браузера */
    private resetBrowserState(): void {
        this.sharedBrowser = null;
        this.browserPromise = null;
        // Сбрасываем пулы (освобождаем ожидающих)
        if (this.instagramPagePool) {
            this.instagramPagePool.reset();
            this.instagramPagePool = null;
        }
        if (this.youtubePagePool) {
            this.youtubePagePool.reset();
            this.youtubePagePool = null;
        }
        for (const pool of this.telegramPagePools.values()) {
            pool.reset();
        }
        this.telegramPagePools.clear();
        log.warn("🔄 Состояние браузера сброшено, следующий запрос создаст новый инстанс");
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
        if (this.youtubePagePool) {
            this.youtubePagePool.reset();
            this.youtubePagePool = null;
            log.info("🗂️ Пул YT сброшен");
        }

        if (this.sharedBrowser && this.sharedBrowser.isConnected()) {
            await this.sharedBrowser.close();
            this.sharedBrowser = null;
            log.info("🌐 Chromium закрыт");
        }
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

    /** Получить или создать пул для YouTube (с Google авторизацией) */
    private getYoutubePagePool(browser: Browser, authPath: string): PagePool {
        if (!this.youtubePagePool) {
            this.youtubePagePool = new PagePool(browser, authPath, { width: 1920, height: 1080 }, this.MAX_CONCURRENT, "YT");
            log.info(`🗂️ Пул YT создан (макс: ${this.MAX_CONCURRENT}, 1920×1080)`);
        }
        return this.youtubePagePool;
    }

    /** Общий паттерн: acquire → Promise.race(work, abort) → release */
    private async executeInPool(
        pool: PagePool,
        workFn: (page: Page) => Promise<Buffer>,
        url: string,
        signal?: AbortSignal,
        reqId?: string
    ): Promise<Buffer> {
        const logCtx = { url, id: reqId };
        const page = await pool.acquire(signal, reqId);
        // log.info(logCtx, `🗂️ Вкладка получена для обработки`);

        try {
            return await workFn(page);
        } finally {
            pool.release(page);
            // log.info(logCtx, `🗂️ Слот освобождён`);
        }
    }

    /** Подготовка и захват скриншота Telegram */
    private async captureTelegram(browser: Browser, url: string, botId: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
        const logCtx = { id: reqId, type: ResourceType.TELEGRAM, url, botId };
        log.info(logCtx, `Обработка Telegram URL`);
        const auth_path = `src/auth/telegram/user_bot_${botId}/auth.json`;
        await ensureTelegramAuth(auth_path);

        const pool = this.getTelegramPagePool(browser, botId, auth_path);
        return this.executeInPool(pool, (page) => handleTelegramLink(page, url, signal, reqId), url, signal, reqId);
    }

    /** Подготовка и захват скриншота Instagram */
    private async captureInstagram(browser: Browser, url: string, signal?: AbortSignal, reqId?: string): Promise<Buffer> {
        const logCtx = { id: reqId, type: ResourceType.INSTAGRAM, url };
        log.info(logCtx, `Обработка Instagram URL`);
        const auth_path = `src/auth/instagram/auth.json`;
        await ensureInstagramAuth(auth_path);

        const pool = this.getInstagramPagePool(browser, auth_path);
        return this.executeInPool(pool, (page) => captureInstagramPostScreenshot(page, url, signal, reqId), url, signal, reqId);
    }

    /** YouTube скриншот: либо timelapse (тест), либо одиночный (прод) */
    private async captureYoutube(browser: Browser, url: string, signal?: AbortSignal, reqId?: string): Promise<Buffer | Buffer[]> {
        const logCtx = { id: reqId, type: ResourceType.YOUTUBE, url };
        log.info(logCtx, `Обработка YouTube URL`);
        const auth_path = `src/auth/youtube/auth.json`;
        await ensureYoutubeAuth(auth_path);

        const pool = this.getYoutubePagePool(browser, auth_path);
        const page = await pool.acquire(signal, reqId);
        // log.info(logCtx, `🗂️ Вкладка получена для обработки`);

        try {
            if (SETTINGS.TEST_SCREENSHOTS) {
                return await captureYoutubeTimelapse(page, url, signal, reqId);
            } else {
                return await captureYoutubeSingle(page, url, signal, reqId);
            }
        } finally {
            pool.release(page);
            // log.info(logCtx, `🗂️ Слот освобождён`);
        }
    }

    public async capture(url: string, user_bot_id?: string, signal?: AbortSignal, reqId?: string): Promise<IPostScreenshotResponse | IYoutubeDebugResponse | IErrorCallback> {
        // Глобальный Promise.race для всего флоу (Playwright + S3)
        const { abortPromise, cleanupAbort } = createAbortRace(signal);

        const workPromise = async (): Promise<IPostScreenshotResponse | IYoutubeDebugResponse | IErrorCallback> => {
            const browser = await this.getBrowser();

            let screenshot: Buffer;
            const resourceType = determineResourceType(url);

            // 1. Получаем скриншот (внутри executeInPool нет своей гонки, все полагается на внешнюю)
            if (resourceType === ResourceType.YOUTUBE) {
                const result = await this.captureYoutube(browser, url, signal, reqId);
                
                // Если мы в режиме теста — возвращаем результат дебага и выходим (как раньше)
                if (SETTINGS.TEST_SCREENSHOTS && Array.isArray(result)) {
                    return { success: true, type: "youtube_debug", total: result.length };
                }
                
                // Иначе (продакшн) — продолжаем общий флоу загрузки с одним скриншотом
                screenshot = result as Buffer;
            } else if (resourceType === ResourceType.TELEGRAM) {
                screenshot = await this.captureTelegram(browser, url, user_bot_id || "1", signal, reqId);
            } else if (resourceType === ResourceType.INSTAGRAM) {
                screenshot = await this.captureInstagram(browser, url, signal, reqId);
            } else {
                return { success: false, code: 1003, message: "UNSUPPORTED_URL" };
            }

            // ЖЕСТКИЙ СТОП для фонового промиса: 
            if (signal?.aborted) throw new Error("ABORTED_BY_CLIENT");

            const uploadData = await getUploadLink(signal);
            
            // ЖЕСТКИЙ СТОП перед долгой загрузкой
            if (signal?.aborted) throw new Error("ABORTED_BY_CLIENT");

            const type = resourceType;
            const logCtx = { id: reqId, type, url };

            log.info({ ...logCtx, fileName: uploadData.file_name }, `Загружаем скриншот в хранилище...`);
            await uploadScreenshot(uploadData.url, screenshot, signal);
            log.success(logCtx, `Скриншот готов и загружен`);

            return { success: true, file_name: uploadData.file_name, buffer: screenshot };
        };

        try {
            return await Promise.race([workPromise(), abortPromise]);
        } catch (error: any) {
            const errorMsg = error.message || String(error);
            const type = determineResourceType(url);
            const logCtx = { id: reqId, type, url };
            
            log.error({ ...logCtx, err: errorMsg }, `Ошибка во время выполнения capture`);
            
            let code = 1004; // Default: SCREENSHOT_FAILED
            
            if (errorMsg.includes("UPLOAD_LINK") || errorMsg.includes("BLOGIX")) {
                code = 1005; // Storage/Upload error
            } else if (errorMsg.includes("TIMEOUT_OR_ERROR")) {
                code = 1006; // Content wait timeout
            } else if (errorMsg.includes("Timeout 30000ms exceeded") || errorMsg.includes("page.goto")) {
                code = 1007; // Navigation timeout (e.g. YouTube heavy load)
            }

            return { 
                success: false, 
                code, 
                message: `SCREENSHOT_FAILED: ${errorMsg}`
            };
        } finally {
            cleanupAbort();
        }
    }
}
