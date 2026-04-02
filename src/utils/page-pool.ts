import { Browser, Page } from "playwright";
import { log } from "./logger";

/**
 * Пул с ограничением параллельности и изолированными контекстами.
 * Каждый запрос получает свежую Page в отдельном BrowserContext
 * (собственные Service Worker, WebSocket, localStorage).
 * После использования контекст и страница закрываются.
 * Если все слоты заняты — запрос ждёт в очереди.
 */
export class PagePool {
    private waiting: Array<(page: Page) => void> = [];
    private active = 0;

    constructor(
        private readonly browser: Browser,
        private readonly storageState: string,
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
        });
        return context.newPage();
    }

    /** Взять вкладку (или подождать, если все слоты заняты) */
    async acquire(): Promise<Page> {
        if (this.active < this.maxSize) {
            this.active++;
            const page = await this.createPage();
            log.info(`🗂️ [${this.label}] Вкладка открыта (${this.active}/${this.maxSize})`);
            return page;
        }

        log.info(`🗂️ [${this.label}] Все ${this.maxSize} слотов заняты, запрос в очереди (ожидают: ${this.waiting.length + 1})`);
        return new Promise<Page>(resolve => {
            this.waiting.push(resolve);
        });
    }

    /** Освободить слот: закрыть контекст и отдать слот ожидающему */
    release(page: Page): void {
        // Закрываем контекст целиком (page закроется вместе с ним)
        page.context().close().catch(() => null);

        const waiter = this.waiting.shift();
        if (waiter) {
            // Создаём свежий изолированный контекст для ожидающего
            this.createPage().then(newPage => {
                log.info(`🗂️ [${this.label}] Вкладка передана из очереди (${this.active}/${this.maxSize}, ожидают: ${this.waiting.length})`);
                waiter(newPage);
            }).catch(err => {
                this.active--;
                log.error(`🗂️ [${this.label}] Не удалось создать вкладку: ${err.message}`);
            });
        } else {
            this.active--;
            log.info(`🗂️ [${this.label}] Слот освобождён (${this.active}/${this.maxSize})`);
        }
    }

    /** Сброс пула (при падении браузера) */
    reset(): void {
        this.waiting = [];
        this.active = 0;
    }
}
