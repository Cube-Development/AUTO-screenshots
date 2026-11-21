import { Browser, Page } from "playwright";
import type { TStorageState } from "../type";
import { log } from "./logger";

interface QueuedRequest {
    resolve: (page: Page) => void;
    reject: (err: Error) => void;
    abortListener?: () => void;
    signal?: AbortSignal;
    reqId?: string;
}

/**
 * Пул с ограничением параллельности и изолированными контекстами.
 * Каждый запрос получает свежую Page в отдельном BrowserContext
 * (собственные Service Worker, WebSocket, localStorage).
 * После использования контекст и страница закрываются.
 * Если все слоты заняты — запрос ждёт в очереди.
 * Сессия хранится объектом: её можно заменить на лету (updateState),
 * а при удалении или протухании пул утилизируется (dispose).
 */
export class PagePool {
    private waiting: Array<QueuedRequest> = [];
    private active = 0;
    private disposedError: Error | null = null;

    constructor(
        private readonly browser: Browser,
        private storageState: TStorageState,
        private readonly viewport: { width: number; height: number },
        private readonly maxSize: number,
        private readonly label: string
    ) {}

    get queueLength(): number {
        return this.waiting.length;
    }

    get activeCount(): number {
        return this.active;
    }

    /** Создать изолированный контекст + страницу */
    private async createPage(): Promise<Page> {
        const context = await this.browser.newContext({
            storageState: this.storageState,
            viewport: this.viewport,
            // Проверки страниц идут по английскому тексту; Chrome иначе берёт язык ОС
            locale: "en-US",
        });
        return context.newPage();
    }

    /** Новые контексты берут новую сессию, уже открытые вкладки дорабатывают со старой */
    updateState(storageState: TStorageState): void {
        this.storageState = storageState;
        log.info(`🗂️ [${this.label}] Сессия обновлена`);
    }

    /** Сессия удалена или протухла: очередь отклоняем, активные вкладки дорабатывают */
    dispose(error: Error): void {
        this.disposedError = error;
        const waiting = this.waiting;
        this.waiting = [];
        for (const req of waiting) {
            if (req.signal && req.abortListener) req.signal.removeEventListener('abort', req.abortListener);
            req.reject(error);
        }
        log.info(`🗂️ [${this.label}] Пул утилизирован (отклонено из очереди: ${waiting.length})`);
    }

    /** Взять вкладку (или подождать, если все слоты заняты) */
    async acquire(signal?: AbortSignal, reqId?: string): Promise<Page> {
        if (signal?.aborted) {
            throw new Error('ABORTED');
        }
        if (this.disposedError) {
            throw this.disposedError;
        }

        if (this.active < this.maxSize) {
            this.active++;
            try {
                const page = await this.createPage();
                log.info(`🗂️ [${this.label}] Вкладка открыта (${this.active}/${this.maxSize})`);
                return page;
            } catch (err) {
                this.active--;
                throw err;
            }
        }

        log.info(`🗂️ [${this.label}] Все ${this.maxSize} слотов заняты, запрос в очереди (ожидают: ${this.waiting.length + 1})`);
        
        return new Promise<Page>((resolve, reject) => {
            const req: QueuedRequest = { resolve, reject, signal, reqId };
            
            if (signal) {
                req.abortListener = () => {
                    this.waiting = this.waiting.filter(w => w !== req);
                    reject(new Error('ABORTED'));
                };
                signal.addEventListener('abort', req.abortListener);
            }
            
            this.waiting.push(req);
        });
    }

    /** Удалить запрос из очереди (если он ещё ждёт) по ID */
    removeById(reqId: string): void {
        const idx = this.waiting.findIndex(q => q.reqId === reqId);
        if (idx !== -1) {
            const req = this.waiting.splice(idx, 1)[0];
            req.reject(new Error('ABORTED'));
            log.info(`🗂️ [${this.label}] Запрос [ID:${reqId}] принудительно удалён из очереди`);
        }
    }

    /** Освободить слот: закрыть контекст и отдать слот ожидающему */
    release(page: Page): void {
        // Закрываем контекст целиком (page закроется вместе с ним)
        page.context().close().catch(() => null);

        // Пропускаем уже отменённых ожидающих — нет смысла создавать для них страницу
        let waiter: QueuedRequest | undefined;
        while (this.waiting.length > 0) {
            const candidate = this.waiting.shift()!;
            if (candidate.signal && candidate.abortListener) {
                candidate.signal.removeEventListener('abort', candidate.abortListener);
            }
            if (candidate.signal?.aborted) {
                log.info(`🗂️ [${this.label}] Пропущен отменённый запрос из очереди${candidate.reqId ? ` [ID:${candidate.reqId}]` : ''}`);
                candidate.reject(new Error('ABORTED'));
                continue;
            }
            waiter = candidate;
            break;
        }

        if (waiter) {
            const liveWaiter = waiter;
            // Создаём свежий изолированный контекст для ожидающего
            this.createPage().then(newPage => {
                if (liveWaiter.signal?.aborted) {
                    log.warn(`🗂️ [${this.label}] Вкладка создалась, но клиент [ID:${liveWaiter.reqId || 'unknown'}] уже отменил запрос. Освобождаем слот.`);
                    // Закрываем эту страницу и передаём слот следующему в очереди
                    this.release(newPage);
                    return;
                }
                log.info(`🗂️ [${this.label}] Вкладка передана из очереди (${this.active}/${this.maxSize}, ожидают: ${this.waiting.length})`);
                liveWaiter.resolve(newPage);
            }).catch(err => {
                this.active--;
                log.error(`🗂️ [${this.label}] Не удалось создать вкладку: ${err.message}`);
                liveWaiter.reject(err);
            });
        } else {
            if (this.active > 0) this.active--;
            log.info(`🗂️ [${this.label}] Слот освобождён (${this.active}/${this.maxSize})`);
        }
    }

    /** Сброс пула (при падении браузера) */
    reset(): void {
        this.waiting = [];
        this.active = 0;
    }
}
