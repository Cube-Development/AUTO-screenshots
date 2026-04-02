import fs from "fs";
import path from "path";
import { Browser, BrowserContext, chromium } from "playwright";
import { Semaphore } from "async-mutex";
import { 
    captureInstagramPostScreenshot, 
    ensureInstagramAuth, 
    ensureTelegramAuth, 
    handleTelegramLink, 
    uploadScreenshot 
} from "../screenshot";
import { log } from "../utils";
import { notifyTelegram } from "../services/telegram-notify";
import { getUploadLink } from "../api";
import { IErrorCallback, IPostCapture, IPostScreenshotResponse } from "../type";
import { SETTINGS } from "../config";

export class ScreenshotService {
    private static instance: ScreenshotService;
    private readonly semaphore: Semaphore;
    private readonly MAX_CONCURRENT = SETTINGS.MAX_SCREENSHOT_LIMIT;

    private sharedBrowser: Browser | null = null;
    private browserPromise: Promise<Browser> | null = null;
    
    private instagramContext: BrowserContext | null = null;
    private igContextPromise: Promise<BrowserContext> | null = null;

    private telegramContexts = new Map<string, BrowserContext>();
    private tgContextPromises = new Map<string, Promise<BrowserContext>>();

    constructor() {
        this.semaphore = new Semaphore(this.MAX_CONCURRENT);
    }

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

    /** Сброс состояния при падении браузера — контексты становятся невалидными */
    private resetBrowserState(): void {
        this.sharedBrowser = null;
        this.browserPromise = null;
        this.instagramContext = null;
        this.igContextPromise = null;
        this.telegramContexts.clear();
        this.tgContextPromises.clear();
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

    public async capture(url: string, user_bot_id?: string): Promise<IPostScreenshotResponse | IErrorCallback> {
        // 1. Получаем ссылку для загрузки ДО семафора (не тратит системные ресурсы браузера)
        const uploadLinkPromise = getUploadLink();
        
        // 2. Устанавливаем общий таймаут на выполнение всей задачи
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("GLOBAL_CAPTURE_TIMEOUT")), 120000); // 120 секунд на всё
        });

        const executeCapture = async () => {
            const [, release] = await this.semaphore.acquire();
            log.info(`🚥 Семафор захвачен (${url})`);

            try {
                const browser = await this.getBrowser();
                let screenshot: Buffer;

                if (this.isTelegramUrl(url)) {
                    const botId = user_bot_id || "1";
                    log.info(`Обработка Telegram URL | Post Url = ${url} | User Bot ID = ${botId}`);
                    const auth_path = `src/auth/telegram/user_bot_${botId}/auth.json`;
                    await ensureTelegramAuth(auth_path);

                    const context = await this.getTelegramContext(browser, botId, auth_path);
                    const page = await context.newPage();

                    try {
                        screenshot = await handleTelegramLink(page, url);
                    } finally {
                        page.close().catch(() => null); // Закрываем без await, чтобы не висеть если браузер тупит
                    }

                } else if (this.isInstagramUrl(url)) {
                    log.info(`Обработка Instagram URL | Post Url = ${url}`);
                    const auth_path = `src/auth/instagram/auth.json`;
                    await ensureInstagramAuth(auth_path);

                    const context = await this.getInstagramContext(browser, auth_path);
                    const page = await context.newPage();

                    try {
                        const resp = await captureInstagramPostScreenshot(page, url);
                        if (!resp.success) return { ...resp as IErrorCallback };
                        screenshot = (resp as IPostCapture)?.buffer as Buffer;
                    } finally {
                        page.close().catch(() => null);
                        log.info(`📸 Instagram page закрыта`);
                    }

                } else {
                    return { success: false, code: 1003, message: "UNSUPPORTED_URL" };
                }

                // Ожидаем ссылку (если она ещё не готова)
                const uploadData = await uploadLinkPromise;

                log.info(`Загружаем скриншот в хранилище... | Post Url = ${url} | File name = ${uploadData.file_name}`);
                await uploadScreenshot(uploadData.url, screenshot as Buffer);
                log.success(`Успешно загружено! | Post Url = ${url} | File name = ${uploadData.file_name}`);

                // Fire-and-forget: дублируем скриншот в TG бот (не блокирует ответ)
                if (SETTINGS.SEND_TO_TELEGRAM) {
                    notifyTelegram(screenshot as Buffer, url, uploadData.file_name);
                }

                return { success: true, file_name: uploadData.file_name };

            } finally {
                release();
                log.info(`🚥 Семафор освобожден (${url})`);
            }
        };

        try {
            return await Promise.race([executeCapture(), timeoutPromise]);
        } catch (error: any) {
            const errorMsg = error.message || String(error);
            log.error(`💥 Ошибка во время выполнения capture: ${errorMsg}`);
            return { 
                success: false, 
                code: 1004, 
                message: error.message === "GLOBAL_CAPTURE_TIMEOUT" ? "TASK_TIMEOUT" : `SCREENSHOT_FAILED: ${errorMsg}`
            };
        }
    }
}
