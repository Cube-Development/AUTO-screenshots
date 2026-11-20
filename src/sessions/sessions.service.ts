import { SETTINGS } from "../config";
import { notifyTelegramText } from "../services/telegram-notify";
import {
  ENUM_SESSION_EVENT,
  ENUM_SESSION_EVENT_TYPE,
  ENUM_SESSION_PLATFORM,
  ENUM_SESSION_PLATFORM_TYPE,
  ENUM_SESSION_STATUS,
  ENUM_SESSION_STATUS_TYPE,
  IResolvedSession,
  ISession,
  ISessionAccountFields,
  ISessionCheckResult,
  ISessionEvent,
  ISessionPlatformSummary,
  SESSION_PLATFORMS,
  SessionError,
  TSessionActor,
  TSessionChangeEvent,
  TStorageState,
} from "../type";
import { log } from "../utils";
import { decryptState, encryptState } from "./sessions.crypto";
import { openSessionsDb, runInTransaction } from "./sessions.db";
import { ISessionRow, SessionsRepository } from "./sessions.repository";

/** При замене сессии незаданные данные аккаунта остаются прежними */
export interface IUpsertSession extends ISessionAccountFields {
  /** true — сессия только что прошла живую проверку */
  verified: boolean;
  /** Откуда сессия: файл или вход в браузере — для истории */
  source?: typeof ENUM_SESSION_EVENT.UPLOAD | typeof ENUM_SESSION_EVENT.LOGIN;
  actor?: TSessionActor;
}

/** undefined — не менять; null в данных аккаунта — очистить */
export interface IUpdateSession extends ISessionAccountFields {
  /** Новый account_id: исправить опечатку или привязать сессию к другому юзерботу */
  accountId?: string;
  status?: ENUM_SESSION_STATUS_TYPE;
  isDefault?: boolean;
}

type TSessionChangeListener = (event: TSessionChangeEvent) => void;

/**
 * Без user_bot_id скриншоты Instagram и YouTube идут по кругу по всем активным сессиям:
 * нагрузка и риск лимитов делятся между аккаунтами. Telegram без user_bot_id — сессия по умолчанию
 */
const ROTATED_PLATFORMS: ENUM_SESSION_PLATFORM_TYPE[] = [ENUM_SESSION_PLATFORM.INSTAGRAM, ENUM_SESSION_PLATFORM.YOUTUBE];

const EVENTS_MAX_LIMIT = 200;

const cacheKey = (platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string) => `${platform}:${accountId}`;

function toSession(row: ISessionRow): ISession {
  return {
    platform: row.platform,
    account_id: row.account_id,
    label: row.label,
    phone: row.phone,
    username: row.username,
    status: row.status,
    is_default: row.is_default === 1,
    last_check_at: row.last_check_at,
    last_error: row.last_error,
    last_used_at: row.last_used_at,
    success_count: row.success_count,
    fail_count: row.fail_count,
    last_fail_at: row.last_fail_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Какие поля поменялись — в историю; значения телефона/username видны только админу, поэтому можно */
function describeUpdate(data: IUpdateSession, accountId: string): string | null {
  const parts: string[] = [];
  if (data.accountId && data.accountId !== accountId) parts.push(`account_id: ${accountId} → ${data.accountId}`);
  if (data.label !== undefined) parts.push(`заметка: ${data.label ?? "—"}`);
  if (data.phone !== undefined) parts.push(`телефон: ${data.phone ?? "—"}`);
  if (data.username !== undefined) parts.push(`username: ${data.username ?? "—"}`);
  if (data.status !== undefined) parts.push(`статус: ${data.status}`);
  if (data.isDefault !== undefined) parts.push(data.isDefault ? "сделана по умолчанию" : "снята с умолчания");
  return parts.length ? parts.join(", ") : null;
}

/**
 * Единственный источник сессий для скриншотов и для API управления.
 * SQLite + расшифрованный кэш в памяти; об изменениях сообщает пулам через onChange.
 */
export class SessionsService {
  private static instance: SessionsService;

  private readonly repository: SessionsRepository;
  private readonly key: Buffer;
  private readonly stateCache = new Map<string, TStorageState>();
  private readonly listeners = new Set<TSessionChangeListener>();
  /** Курсор ротации по платформе; в памяти — после рестарта круг начинается заново */
  private readonly rotation = new Map<ENUM_SESSION_PLATFORM_TYPE, number>();

  private constructor() {
    this.repository = new SessionsRepository(openSessionsDb(SETTINGS.SESSIONS_DB_PATH, SETTINGS.SESSIONS_SEED_PATH));
    this.key = SETTINGS.SESSIONS_ENC_KEY;
  }

  public static getInstance(): SessionsService {
    if (!SessionsService.instance) {
      SessionsService.instance = new SessionsService();
    }
    return SessionsService.instance;
  }

  public onChange(listener: TSessionChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public list(platform?: ENUM_SESSION_PLATFORM_TYPE): ISession[] {
    return this.repository.list(platform).map(toSession);
  }

  public get(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string): ISession | null {
    const row = this.repository.get(platform, accountId);
    return row ? toSession(row) : null;
  }

  public getState(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string): TStorageState | null {
    const row = this.repository.get(platform, accountId);
    return row ? this.decrypt(row) : null;
  }

  /**
   * Сессия для скриншота: запрошенная, если она активна; иначе для Instagram/YouTube — следующая по кругу,
   * для Telegram — по умолчанию. Подмена запрошенного аккаунта логируется: приватный канал другой может не видеть
   */
  public resolve(platform: ENUM_SESSION_PLATFORM_TYPE, accountId?: string): IResolvedSession {
    let row = accountId ? this.repository.get(platform, accountId) : null;

    if (!row || row.status !== ENUM_SESSION_STATUS.ACTIVE) {
      const fallback = this.pickFallback(platform);
      if (accountId && fallback) {
        log.warn(
          { platform, requested: accountId, fallback: fallback.account_id, status: row?.status ?? null },
          `Запрошенная сессия недоступна, используем другую`,
        );
      }
      row = fallback;
    }

    if (!row) throw new SessionError("SESSION_NOT_FOUND", `Нет активной сессии ${platform}`);

    this.repository.touchUsed(platform, row.account_id);
    return { platform, accountId: row.account_id, state: this.decrypt(row) };
  }

  private pickFallback(platform: ENUM_SESSION_PLATFORM_TYPE): ISessionRow | null {
    if (!ROTATED_PLATFORMS.includes(platform)) return this.repository.findFallback(platform);

    const active = this.repository.listActive(platform);
    if (active.length === 0) return null;
    const index = (this.rotation.get(platform) ?? 0) % active.length;
    this.rotation.set(platform, index + 1);
    return active[index];
  }

  /** Первая сессия платформы автоматически становится сессией по умолчанию */
  public upsert(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    state: TStorageState,
    options: IUpsertSession,
  ): ISession {
    const existed = Boolean(this.repository.get(platform, accountId));
    runInTransaction(this.repository.database, () => {
      this.repository.upsert({
        platform,
        accountId,
        label: options.label ?? null,
        phone: options.phone ?? null,
        username: options.username ?? null,
        storageState: encryptState(state, this.key),
        checkedAt: options.verified ? new Date().toISOString() : null,
      });
      if (!this.repository.hasDefault(platform)) this.repository.setDefault(platform, accountId, true);
      this.addEvent(
        platform,
        accountId,
        options.source ?? ENUM_SESSION_EVENT.UPLOAD,
        options.actor ?? null,
        `${existed ? "замена сессии" : "новая сессия"}${options.verified ? ", вход проверен" : ""}`,
      );
    });

    this.stateCache.set(cacheKey(platform, accountId), state);
    this.emit({ type: "upsert", platform, accountId, state });
    log.info({ platform, accountId }, `🔑 Сессия сохранена`);
    return this.get(platform, accountId)!;
  }

  /** Служебный флаг в БД (например, что разовый импорт уже был) */
  public getMeta(key: string): string | null {
    return this.repository.getMeta(key);
  }

  public setMeta(key: string, value: string): void {
    this.repository.setMeta(key, value);
  }

  /** Импорт из старых папок: существующие записи не перезаписываются */
  public importIfAbsent(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, state: TStorageState): boolean {
    const inserted = this.repository.insertIfAbsent({
      platform,
      accountId,
      label: "legacy",
      phone: null,
      username: null,
      storageState: encryptState(state, this.key),
      checkedAt: null,
    });
    if (!inserted) return false;
    if (!this.repository.hasDefault(platform)) this.repository.setDefault(platform, accountId, true);
    this.addEvent(platform, accountId, ENUM_SESSION_EVENT.IMPORT, null, "из старой папки src/auth");
    return true;
  }

  /**
   * Точечная правка без перезаливки сессии: данные аккаунта, статус, сессия по умолчанию, смена account_id.
   * Смена account_id утилизирует пул со старым ключом — новый создастся при следующем скриншоте
   */
  public update(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    data: IUpdateSession,
    actor: TSessionActor = null,
  ): ISession | null {
    const before = this.repository.get(platform, accountId);
    if (!before) return null;

    const newAccountId = data.accountId && data.accountId !== accountId ? data.accountId : undefined;
    if (newAccountId && this.repository.get(platform, newAccountId)) {
      throw new SessionError("SESSION_ALREADY_EXISTS", `У ${platform} уже есть сессия ${newAccountId}`);
    }
    const currentId = newAccountId ?? accountId;
    // Сессия по умолчанию берётся для скриншотов: выключенная или протухшая на этой роли бесполезна
    const statusAfter = data.status ?? before.status;
    if (data.isDefault === true && statusAfter !== ENUM_SESSION_STATUS.ACTIVE) {
      throw new SessionError("SESSION_INVALID_STATE", "Сессией по умолчанию может быть только активная сессия");
    }

    runInTransaction(this.repository.database, () => {
      this.repository.update(platform, accountId, {
        accountId: newAccountId,
        label: data.label,
        phone: data.phone,
        username: data.username,
        status: data.status,
      });
      if (data.isDefault !== undefined) this.repository.setDefault(platform, currentId, data.isDefault);
      if (newAccountId) this.repository.renameEvents(platform, accountId, newAccountId);
      this.addEvent(platform, currentId, ENUM_SESSION_EVENT.UPDATE, actor, describeUpdate(data, accountId));
    });

    const deactivated =
      data.status && data.status !== ENUM_SESSION_STATUS.ACTIVE && before.status === ENUM_SESSION_STATUS.ACTIVE;
    if (newAccountId) {
      this.stateCache.delete(cacheKey(platform, accountId));
    }
    if (newAccountId || deactivated) {
      this.emit({ type: "remove", platform, accountId });
    }
    if (deactivated && before.is_default === 1) this.ensureDefault(platform, currentId);
    log.info({ platform, accountId, newAccountId, ...data, actor }, `🔑 Сессия обновлена`);
    return this.get(platform, currentId);
  }

  /** Итог скриншота под сессией — счётчики в таблице админки */
  public recordResult(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, ok: boolean): void {
    this.repository.recordResult(platform, accountId, ok);
  }

  /** Сводка по платформам: статусы и сессия по умолчанию */
  public summary(): Record<ENUM_SESSION_PLATFORM_TYPE, ISessionPlatformSummary> {
    const result = Object.fromEntries(
      SESSION_PLATFORMS.map((platform) => [
        platform,
        { total: 0, active: 0, disabled: 0, expired: 0, default_account_id: null, default_username: null },
      ]),
    ) as Record<ENUM_SESSION_PLATFORM_TYPE, ISessionPlatformSummary>;

    for (const row of this.repository.list()) {
      const item = result[row.platform];
      item.total++;
      item[row.status]++;
      if (row.is_default === 1) {
        item.default_account_id = row.account_id;
        item.default_username = row.username;
      }
    }
    return result;
  }

  /** История действий с сессией, свежие сверху; остаётся и после удаления */
  public events(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, limit = 50): ISessionEvent[] {
    return this.repository.listEvents(platform, accountId, Math.min(Math.max(limit, 1), EVENTS_MAX_LIMIT));
  }

  /** Копия базы в файл (ежедневный бэкап) */
  public backupTo(filePath: string): void {
    this.repository.backupTo(filePath);
  }

  /**
   * Сессия по умолчанию стала непригодной (протухла, выключена, удалена) — флаг переходит
   * к самой старой активной сессии платформы, чтобы скриншоты без user_bot_id не падали
   */
  private ensureDefault(platform: ENUM_SESSION_PLATFORM_TYPE, previousAccountId: string): void {
    if (this.repository.findActiveDefault(platform)) return;
    const next = this.repository.findFallback(platform);
    if (!next) {
      notifyTelegramText(`<u>‼️ Нет активных сессий ${platform}</u>\nСессия по умолчанию ${previousAccountId} больше не работает, замены нет.`);
      return;
    }

    this.repository.setDefault(platform, next.account_id, true);
    this.addEvent(platform, next.account_id, ENUM_SESSION_EVENT.DEFAULT_CHANGE, null, `вместо ${previousAccountId}`);
    log.warn({ platform, previous: previousAccountId, next: next.account_id }, `🔑 Сессия по умолчанию сменена`);
    notifyTelegramText(
      `<u>🔁 Сессия по умолчанию ${platform} сменена</u>\nБыла: <code>${previousAccountId}</code>\nСтала: <code>${next.account_id}</code>${next.username ? ` (${next.username})` : ""}`,
    );
  }

  /**
   * Итог живой проверки: active или expired + время и причина. actor — админ, если проверку запустил он.
   * Неубедительная проверка (сеть, таймаут) статус не меняет — только время и причина
   */
  public markChecked(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    check: ISessionCheckResult,
    actor: TSessionActor = null,
  ): ISession | null {
    const before = this.repository.get(platform, accountId);
    if (!before) return null;

    const { ok, error } = check;
    if (!ok && check.inconclusive) {
      this.repository.markStatus(platform, accountId, before.status, error);
      log.warn({ platform, accountId, err: error }, `🔑 Проверка сессии не удалась, статус не меняем`);
      return this.get(platform, accountId);
    }

    // disabled выключил админ — проверка его не включает обратно
    const status =
      before.status === ENUM_SESSION_STATUS.DISABLED
        ? ENUM_SESSION_STATUS.DISABLED
        : ok
          ? ENUM_SESSION_STATUS.ACTIVE
          : ENUM_SESSION_STATUS.EXPIRED;
    this.repository.markStatus(platform, accountId, status, ok ? null : error);

    if (status === ENUM_SESSION_STATUS.EXPIRED && before.status !== ENUM_SESSION_STATUS.EXPIRED) {
      this.addEvent(platform, accountId, ENUM_SESSION_EVENT.EXPIRE, actor, error);
    }
    if (status === ENUM_SESSION_STATUS.ACTIVE && before.status === ENUM_SESSION_STATUS.EXPIRED) {
      this.addEvent(platform, accountId, ENUM_SESSION_EVENT.REACTIVATE, actor, null);
    }
    if (status !== ENUM_SESSION_STATUS.ACTIVE && before.status === ENUM_SESSION_STATUS.ACTIVE) {
      this.emit({ type: "remove", platform, accountId });
      if (before.is_default === 1) this.ensureDefault(platform, accountId);
    }
    return this.get(platform, accountId);
  }

  public markExpired(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, error: string | null): void {
    this.markChecked(platform, accountId, { ok: false, error });
    log.warn({ platform, accountId, err: error }, `🔑 Сессия помечена как expired`);
  }

  /** detail — например, итог выхода из аккаунта перед удалением */
  public delete(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    actor: TSessionActor = null,
    detail: string | null = null,
  ): boolean {
    const wasDefault = this.repository.get(platform, accountId)?.is_default === 1;
    const deleted = this.repository.delete(platform, accountId);
    if (!deleted) return false;

    this.addEvent(platform, accountId, ENUM_SESSION_EVENT.DELETE, actor, detail);
    this.stateCache.delete(cacheKey(platform, accountId));
    this.emit({ type: "remove", platform, accountId });
    if (wasDefault) this.ensureDefault(platform, accountId);
    log.info({ platform, accountId, actor }, `🔑 Сессия удалена`);
    return true;
  }

  /** История не должна ронять основное действие */
  private addEvent(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    action: ENUM_SESSION_EVENT_TYPE,
    actor: TSessionActor,
    detail: string | null,
  ): void {
    try {
      this.repository.addEvent({ platform, account_id: accountId, action, actor, detail });
    } catch (err: any) {
      log.error({ platform, accountId, action, err: err?.message || String(err) }, `Не удалось записать событие сессии`);
    }
  }

  private decrypt(row: ISessionRow): TStorageState {
    const key = cacheKey(row.platform, row.account_id);
    const cached = this.stateCache.get(key);
    if (cached) return cached;

    const state = decryptState(row.storage_state, this.key);
    this.stateCache.set(key, state);
    return state;
  }

  private emit(event: TSessionChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err: any) {
        log.error({ err: err?.message || String(err) }, `Ошибка обработчика изменения сессии`);
      }
    }
  }
}
