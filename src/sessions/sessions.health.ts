import { Browser } from "playwright";
import { notifyTelegramText } from "../services/telegram-notify";
import {
  ENUM_SESSION_PLATFORM_TYPE,
  ENUM_SESSION_STATUS,
  ISessionCheckAllResult,
  ISessionCheckItem,
  TSessionActor,
} from "../type";
import { log } from "../utils";
import { checkStorageState } from "./sessions.checker";
import { SessionsService } from "./sessions.service";

const LAST_CHECK_META_KEY = "last_check_all_at";

/** Неубедительные проверки (сеть, таймаут) не считаются ни активными, ни разлогиненными */
function summarize(items: ISessionCheckItem[]): ISessionCheckAllResult {
  return {
    checked: items.length,
    active: items.filter((item) => item.ok).length,
    expired: items.filter((item) => !item.ok && !item.inconclusive).length,
    items,
  };
}

/** Итог общей проверки, урезанный до одной платформы: вызвавший её не ждёт чужих сессий */
function onlyPlatform(result: ISessionCheckAllResult, platform?: ENUM_SESSION_PLATFORM_TYPE): ISessionCheckAllResult {
  if (!platform) return result;
  return summarize(result.items.filter((item) => item.platform === platform));
}

/**
 * Живая проверка всех активных сессий: по кнопке из админки и раз в сутки по расписанию.
 * Протухшие помечаются expired (и сессия по умолчанию переезжает), в TG — один список
 */
export class SessionsHealth {
  /** platform undefined — идёт проверка всех платформ */
  private running: { platform?: ENUM_SESSION_PLATFORM_TYPE; promise: Promise<ISessionCheckAllResult> } | null = null;

  constructor(
    private readonly getBrowser: () => Promise<Browser>,
    private readonly sessions: SessionsService,
  ) {}

  public get lastCheckAllAt(): string | null {
    return this.sessions.getMeta(LAST_CHECK_META_KEY);
  }

  /**
   * Повторный вызов во время проверки ждёт текущую, а не запускает вторую. Если текущая не покрывает
   * запрошенную платформу (идёт проверка одной вкладки, а нужны все), после неё запускается своя
   */
  public async checkAll(platform?: ENUM_SESSION_PLATFORM_TYPE, actor: TSessionActor = null): Promise<ISessionCheckAllResult> {
    while (this.running) {
      const current = this.running;
      if (current.platform === undefined || current.platform === platform) {
        return onlyPlatform(await current.promise, platform);
      }
      await current.promise.catch(() => null);
    }

    const promise = this.run(platform, actor).finally(() => {
      this.running = null;
    });
    this.running = { platform, promise };
    return promise;
  }

  /** Плановая проверка: в TG — список разлогиненных */
  public async checkAllScheduled(): Promise<void> {
    await this.notify(await this.checkAll());
  }

  private async run(platform: ENUM_SESSION_PLATFORM_TYPE | undefined, actor: TSessionActor): Promise<ISessionCheckAllResult> {
    const active = this.sessions.list(platform).filter((session) => session.status === ENUM_SESSION_STATUS.ACTIVE);
    const browser = await this.getBrowser();
    const items: ISessionCheckItem[] = [];

    // По одной: каждая проверка открывает страницу платформы, параллельно — лишняя нагрузка и риск лимитов
    for (const session of active) {
      const state = this.sessions.getState(session.platform, session.account_id);
      if (!state) continue;
      const check = await checkStorageState(browser, session.platform, state);
      this.sessions.markChecked(session.platform, session.account_id, check, actor);
      items.push({
        platform: session.platform,
        account_id: session.account_id,
        ok: check.ok,
        error: check.error,
        ...(check.inconclusive ? { inconclusive: true } : {}),
      });
    }

    // «Проверка всех» в сводке — только полная: проверка одной вкладки её не подменяет
    if (!platform) this.sessions.setMeta(LAST_CHECK_META_KEY, new Date().toISOString());
    const result = summarize(items);
    log.info({ platform, checked: result.checked, expired: result.expired }, `🩺 Проверка сессий завершена`);
    return result;
  }

  private async notify(result: ISessionCheckAllResult): Promise<void> {
    const line = (item: ISessionCheckItem) => `• ${item.platform} <code>${item.account_id}</code>: ${item.error ?? "нет входа"}`;
    const expired = result.items.filter((item) => !item.ok && !item.inconclusive);
    const failed = result.items.filter((item) => item.inconclusive);
    if (expired.length === 0 && failed.length === 0) return;

    const parts = [`<u>🩺 Плановая проверка: разлогинено ${expired.length} из ${result.checked}</u>`];
    if (expired.length) parts.push(expired.map(line).join("\n"), "Перелогиньте их в админке.");
    if (failed.length) {
      parts.push(`Не удалось проверить (${failed.length}), статус не меняли:`, failed.map(line).join("\n"));
    }
    await notifyTelegramText(parts.join("\n"));
  }
}
