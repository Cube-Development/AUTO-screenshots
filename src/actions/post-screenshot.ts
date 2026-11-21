import { Browser, chromium, Page } from "playwright";
import { getUploadLink } from "../api";
import { SETTINGS } from "../config";
import {
    captureInstagramPostScreenshot,
    captureYoutubeSingle,
    captureYoutubeTimelapse,
    handleTelegramLink,
    uploadScreenshot
} from "../screenshot";
import { checkStorageState, importLegacySessions, SessionsService } from "../sessions";
import { notifyTelegramText } from "../services/telegram-notify";
import {
    ENUM_SESSION_PLATFORM,
    ENUM_SESSION_PLATFORM_TYPE,
    ENUM_SESSION_STATUS,
    IErrorCallback,
    IPostScreenshotResponse,
    IResolvedSession,
    ISessionCheckResult,
    IYoutubeDebugResponse,
    ResourceType,
    SessionError,
    TStorageState
} from "../type";
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

/** Viewport и метка пула для каждой платформы */
const POOL_CONFIG: Record<ENUM_SESSION_PLATFORM_TYPE, { viewport: { width: number; height: number }; label: string }> = {
    [ENUM_SESSION_PLATFORM.TELEGRAM]: { viewport: { width: 1280, height: 1600 }, label: "TG" },
    [ENUM_SESSION_PLATFORM.INSTAGRAM]: { viewport: { width: 1280, height: 1200 }, label: "IG" },
    [ENUM_SESSION_PLATFORM.YOUTUBE]: { viewport: { width: 1920, height: 1080 }, label: "YT" },
};

const RESOURCE_PLATFORM: Partial<Record<ResourceType, ENUM_SESSION_PLATFORM_TYPE>> = {
    [ResourceType.TELEGRAM]: ENUM_SESSION_PLATFORM.TELEGRAM,
    [ResourceType.INSTAGRAM]: ENUM_SESSION_PLATFORM.INSTAGRAM,
    [ResourceType.YOUTUBE]: ENUM_SESSION_PLATFORM.YOUTUBE,
};

const poolKey = (platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string) => `${platform}:${accountId}`;

export class ScreenshotService {
    private static instance: ScreenshotService;
    private readonly MAX_CONCURRENT = SETTINGS.MAX_SCREENSHOT_LIMIT;
    private readonly sessions = SessionsService.getInstance();

    private sharedBrowser: Browser | null = null;
    private browserPromise: Promise<Browser> | null = null;

    // Пулы вкладок по ключу `${platform}:${accountId}`: каждый пул = N изолированных контекстов (PagePool)
    private pagePools = new Map<string, PagePool>();

    constructor() {
        // Сессию заменили — новые вкладки берут новую; удалили или протухла — пул утилизируем
        this.sessions.onChange((event) => {
            const key = poolKey(event.platform, event.accountId);
            const pool = this.pagePools.get(key);
            if (!pool) return;

            if (event.type === "upsert") {
                pool.updateState(event.state);
                return;
            }
            pool.dispose(new SessionError("SESSION_NOT_FOUND", `Сессия ${key} удалена или выключена`));
            this.pagePools.delete(key);
        });
    }

    public static getInstance(): ScreenshotService {
        if (!ScreenshotService.instance) {
            ScreenshotService.instance = new ScreenshotService();
        }
        return ScreenshotService.instance;
    }

    /** Импорт старых папок и прогрев браузера и пулов по активным сессиям из БД */
    public async init(): Promise<void> {
        if (SETTINGS.LEGACY_AUTH_DIR) importLegacySessions(this.sessions, SETTINGS.LEGACY_AUTH_DIR);

        log.info("🚀 Прогрев браузера и контекстов...");
        const browser = await this.getBrowser();

        const active = this.sessions.list().filter((session) => session.status === ENUM_SESSION_STATUS.ACTIVE);
        for (const session of active) {
            const state = this.sessions.getState(session.platform, session.account_id);
            if (state) this.getPool(browser, { platform: session.platform, accountId: session.account_id, state });
        }

        log.success(`✅ Браузер и контексты прогреты (сессий: ${active.length})`);
    }

    public async getBrowser(): Promise<Browser> {
        if (this.sharedBrowser?.isConnected()) return this.sharedBrowser;
        if (this.browserPromise) return this.browserPromise;

        const launchOptions = { headless: true, args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'] };
        // Google Chrome: в Chromium из Playwright нет H.264, видео рилсов/сторис/YouTube не играет.
        // Chrome не установлен — работаем на Chromium: всё, кроме видео, снимается так же
        let launchedChannel: string | undefined = "chrome";
        const launch = chromium.launch({ ...launchOptions, channel: "chrome" }).catch((err) => {
            log.warn(`⚠️ Google Chrome не запустился, откат на Chromium (видео будет обложкой/чёрным): ${String(err).split("\n")[0]}`);
            launchedChannel = undefined;
            return chromium.launch(launchOptions);
        });

        this.browserPromise = launch.then(b => {
            this.sharedBrowser = b;
            this.browserPromise = null;
            log.info(`🌐 Браузер запущен (shared instance, ${launchedChannel ?? "chromium"} ${b.version()})`);

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

    /** Живая проверка сессии (для API управления сессиями) */
    public async checkSession(platform: ENUM_SESSION_PLATFORM_TYPE, state: TStorageState): Promise<ISessionCheckResult> {
        const browser = await this.getBrowser();
        return checkStorageState(browser, platform, state);
    }

    /** Сброс состояния при падении браузера */
    private resetBrowserState(): void {
        this.sharedBrowser = null;
        this.browserPromise = null;
        // Сбрасываем пулы (освобождаем ожидающих)
        for (const pool of this.pagePools.values()) {
            pool.reset();
        }
        this.pagePools.clear();
        log.warn("🔄 Состояние браузера сброшено, следующий запрос создаст новый инстанс");
    }

    public async close(): Promise<void> {
        // Сбрасываем пулы
        for (const [key, pool] of this.pagePools) {
            pool.reset();
            log.info(`🗂️ Пул ${key} сброшен`);
        }
        this.pagePools.clear();

        if (this.sharedBrowser && this.sharedBrowser.isConnected()) {
            await this.sharedBrowser.close();
            this.sharedBrowser = null;
            log.info("🌐 Chromium закрыт");
        }
    }

    /** Получить или создать пул для сессии (изолированные контексты) */
    private getPool(browser: Browser, session: IResolvedSession): PagePool {
        const key = poolKey(session.platform, session.accountId);
        let pool = this.pagePools.get(key);
        if (!pool) {
            const { viewport, label } = POOL_CONFIG[session.platform];
            pool = new PagePool(browser, session.state, viewport, this.MAX_CONCURRENT, `${label}:${session.accountId}`);
            this.pagePools.set(key, pool);
            log.info(`🗂️ Пул ${key} создан (макс: ${this.MAX_CONCURRENT}, ${viewport.width}×${viewport.height})`);
        }
        return pool;
    }

    /** Общий паттерн: acquire → work → release */
    private async executeInPool<T>(
        pool: PagePool,
        workFn: (page: Page) => Promise<T>,
        signal?: AbortSignal,
        reqId?: string
    ): Promise<T> {
        const page = await pool.acquire(signal, reqId);

        try {
            return await workFn(page);
        } finally {
            pool.release(page);
        }
    }

    /** Захват скриншота в пуле сессии: YouTube — либо timelapse (тест), либо одиночный (прод) */
    private async captureWithSession(
        browser: Browser,
        session: IResolvedSession,
        url: string,
        signal?: AbortSignal,
        reqId?: string
    ): Promise<Buffer | Buffer[]> {
        const logCtx = { id: reqId, type: session.platform, url, accountId: session.accountId };
        log.info(logCtx, `Обработка URL`);
        const pool = this.getPool(browser, session);

        switch (session.platform) {
            case ENUM_SESSION_PLATFORM.TELEGRAM:
                return this.executeInPool(pool, (page) => handleTelegramLink(page, url, signal, reqId), signal, reqId);
            case ENUM_SESSION_PLATFORM.INSTAGRAM:
                return this.executeInPool(pool, (page) => captureInstagramPostScreenshot(page, url, signal, reqId), signal, reqId);
            case ENUM_SESSION_PLATFORM.YOUTUBE:
                return this.executeInPool<Buffer | Buffer[]>(
                    pool,
                    (page) => SETTINGS.TEST_SCREENSHOTS
                        ? captureYoutubeTimelapse(page, url, signal, reqId)
                        : captureYoutubeSingle(page, url, signal, reqId),
                    signal,
                    reqId
                );
        }
    }

    /** Сессия протухла во время скриншота: помечаем и сообщаем в TG-чат */
    private handleExpiredSession(session: IResolvedSession, error: SessionError): void {
        this.sessions.markExpired(session.platform, session.accountId, error.detail);
        notifyTelegramText(
            `<u>‼️ Сессия скриншотера протухла</u>\nПлатформа: ${session.platform}\nАккаунт: <code>${session.accountId}</code>\nПричина: ${error.detail ?? error.message}\n\nПерелогиньте или загрузите сессию в админке.`
        );
    }

    /**
     * Тестовый скриншот поста под конкретной сессией (из админки): без загрузки в Blogix и без счётчиков.
     * Работает и для выключенной сессии — так её можно проверить перед включением
     */
    public async testScreenshot(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, url: string): Promise<Buffer> {
        const state = this.sessions.getState(platform, accountId);
        if (!state) throw new SessionError("SESSION_NOT_FOUND");

        const session: IResolvedSession = { platform, accountId, state };
        try {
            const result = await this.captureWithSession(await this.getBrowser(), session, url);
            return Array.isArray(result) ? result[result.length - 1] : result;
        } catch (error) {
            if (error instanceof SessionError && error.message === "SESSION_EXPIRED") this.handleExpiredSession(session, error);
            throw error;
        }
    }

    /** Платформа ссылки на пост; null — ссылка не поддерживается */
    public platformOf(url: string): ENUM_SESSION_PLATFORM_TYPE | null {
        return RESOURCE_PLATFORM[determineResourceType(url)] ?? null;
    }

    public async capture(url: string, user_bot_id?: string, signal?: AbortSignal, reqId?: string): Promise<IPostScreenshotResponse | IYoutubeDebugResponse | IErrorCallback> {
        // Глобальный Promise.race для всего флоу (Playwright + S3)
        const { abortPromise, cleanupAbort } = createAbortRace(signal);
        // Объект, а не let: TS не видит присваивание из замыкания и сужает тип до null
        const resolved: { session: IResolvedSession | null; captured: boolean } = { session: null, captured: false };

        const workPromise = async (): Promise<IPostScreenshotResponse | IYoutubeDebugResponse | IErrorCallback> => {
            const resourceType = determineResourceType(url);
            const platform = RESOURCE_PLATFORM[resourceType];
            if (!platform) {
                return { success: false, code: 1003, message: "UNSUPPORTED_URL" };
            }

            // user_bot_id есть только у Telegram; нет сессии — быстрая ошибка вместо ожидания ручного входа
            const session = this.sessions.resolve(platform, platform === ENUM_SESSION_PLATFORM.TELEGRAM ? user_bot_id : undefined);
            resolved.session = session;
            const browser = await this.getBrowser();

            // 1. Получаем скриншот (внутри executeInPool нет своей гонки, все полагается на внешнюю)
            const result = await this.captureWithSession(browser, session, url, signal, reqId);
            // Счётчик сессии: скриншот снят, дальнейшая загрузка в Blogix к сессии не относится
            resolved.captured = true;
            this.sessions.recordResult(session.platform, session.accountId, true);

            // Если мы в режиме теста — возвращаем результат дебага и выходим (как раньше)
            if (Array.isArray(result)) {
                return { success: true, type: "youtube_debug", total: result.length };
            }
            const screenshot = result;

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

            log.error({ ...logCtx, err: errorMsg, detail: error?.detail }, `Ошибка во время выполнения capture`);

            if (error instanceof SessionError) {
                if (error.message === "SESSION_EXPIRED" && resolved.session) {
                    this.handleExpiredSession(resolved.session, error);
                }
                return error.toCallback();
            }

            // Упал сам скриншот под живой сессией (отмена клиентом не считается) — счётчик ошибок
            if (resolved.session && !resolved.captured && errorMsg !== "ABORTED_BY_CLIENT") {
                this.sessions.recordResult(resolved.session.platform, resolved.session.accountId, false);
            }

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
