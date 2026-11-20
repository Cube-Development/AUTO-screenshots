import { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ENUM_SESSION_PLATFORM_TYPE, ENUM_SESSION_STATUS, ENUM_SESSION_STATUS_TYPE, ISessionEvent } from "../type";
import { runInTransaction } from "./sessions.db";

export interface ISessionRow {
  platform: ENUM_SESSION_PLATFORM_TYPE;
  account_id: string;
  label: string | null;
  phone: string | null;
  username: string | null;
  storage_state: Uint8Array;
  status: ENUM_SESSION_STATUS_TYPE;
  is_default: number;
  last_check_at: string | null;
  last_error: string | null;
  last_used_at: string | null;
  success_count: number;
  fail_count: number;
  last_fail_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IUpsertSessionRow {
  platform: ENUM_SESSION_PLATFORM_TYPE;
  accountId: string;
  label: string | null;
  phone: string | null;
  username: string | null;
  storageState: Buffer;
  checkedAt: string | null;
}

/** undefined — не менять, null — очистить */
export interface IUpdateSessionRow {
  accountId?: string;
  label?: string | null;
  phone?: string | null;
  username?: string | null;
  status?: ENUM_SESSION_STATUS_TYPE;
}

/** Колонки, которые update() меняет напрямую: ключ — поле IUpdateSessionRow */
const UPDATE_COLUMNS = {
  accountId: "account_id",
  label: "label",
  phone: "phone",
  username: "username",
  status: "status",
} as const satisfies Record<keyof IUpdateSessionRow, string>;

const now = () => new Date().toISOString();

/** Доступ к таблице sessions. Только SQL, без шифрования и бизнес-правил */
export class SessionsRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Для транзакций сервиса поверх нескольких методов репозитория */
  get database(): DatabaseSync {
    return this.db;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  list(platform?: ENUM_SESSION_PLATFORM_TYPE): ISessionRow[] {
    const sql = `SELECT * FROM sessions ${platform ? "WHERE platform = ?" : ""}
      ORDER BY platform, is_default DESC, created_at`;
    const params: SQLInputValue[] = platform ? [platform] : [];
    return this.db.prepare(sql).all(...params) as unknown as ISessionRow[];
  }

  get(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string): ISessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE platform = ? AND account_id = ?")
      .get(platform, accountId);
    return (row as unknown as ISessionRow | undefined) ?? null;
  }

  /** Активная сессия по умолчанию, иначе самая старая активная */
  findFallback(platform: ENUM_SESSION_PLATFORM_TYPE): ISessionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE platform = ? AND status = ?
         ORDER BY is_default DESC, created_at LIMIT 1`,
      )
      .get(platform, ENUM_SESSION_STATUS.ACTIVE);
    return (row as unknown as ISessionRow | undefined) ?? null;
  }

  hasDefault(platform: ENUM_SESSION_PLATFORM_TYPE): boolean {
    return !!this.db.prepare("SELECT 1 FROM sessions WHERE platform = ? AND is_default = 1").get(platform);
  }

  /** Новая запись или замена storage_state: сессия снова active, ошибка сбрасывается */
  upsert(data: IUpsertSessionRow): void {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO sessions (platform, account_id, label, phone, username, storage_state, status, is_default,
                               last_check_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
         ON CONFLICT (platform, account_id) DO UPDATE SET
           storage_state = excluded.storage_state,
           label         = COALESCE(excluded.label, sessions.label),
           phone         = COALESCE(excluded.phone, sessions.phone),
           username      = COALESCE(excluded.username, sessions.username),
           status        = 'active',
           last_error    = NULL,
           last_check_at = excluded.last_check_at,
           updated_at    = excluded.updated_at`,
      )
      .run(
        data.platform, data.accountId, data.label, data.phone, data.username, data.storageState,
        data.checkedAt, timestamp, timestamp,
      );
  }

  /** Для импорта из старых папок: существующие записи не трогаем */
  insertIfAbsent(data: IUpsertSessionRow): boolean {
    const timestamp = now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (platform, account_id, label, storage_state, status, is_default,
                                         created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, ?)`,
      )
      .run(data.platform, data.accountId, data.label, data.storageState, timestamp, timestamp);
    return Number(result.changes) > 0;
  }

  update(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, data: IUpdateSessionRow): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [field, column] of Object.entries(UPDATE_COLUMNS) as [keyof IUpdateSessionRow, string][]) {
      const value = data[field];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    params.push(now(), platform, accountId);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE platform = ? AND account_id = ?`).run(...params);
  }

  /** Сессия по умолчанию одна на платформу */
  setDefault(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, isDefault: boolean): void {
    runInTransaction(this.db, () => {
      if (isDefault) {
        this.db.prepare("UPDATE sessions SET is_default = 0 WHERE platform = ?").run(platform);
      }
      this.db
        .prepare("UPDATE sessions SET is_default = ?, updated_at = ? WHERE platform = ? AND account_id = ?")
        .run(isDefault ? 1 : 0, now(), platform, accountId);
    });
  }

  markStatus(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    status: ENUM_SESSION_STATUS_TYPE,
    error: string | null,
  ): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, last_error = ?, last_check_at = ?, updated_at = ?
         WHERE platform = ? AND account_id = ?`,
      )
      .run(status, error, timestamp, timestamp, platform, accountId);
  }

  /** Итог скриншота под сессией: ошибки сессии (expired/not found) сюда не идут — у них свой статус */
  recordResult(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, ok: boolean): void {
    const sql = ok
      ? "UPDATE sessions SET success_count = success_count + 1 WHERE platform = ? AND account_id = ?"
      : "UPDATE sessions SET fail_count = fail_count + 1, last_fail_at = ? WHERE platform = ? AND account_id = ?";
    const params: SQLInputValue[] = ok ? [platform, accountId] : [now(), platform, accountId];
    this.db.prepare(sql).run(...params);
  }

  /** Активная сессия по умолчанию платформы, если она есть */
  findActiveDefault(platform: ENUM_SESSION_PLATFORM_TYPE): ISessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE platform = ? AND is_default = 1 AND status = ?")
      .get(platform, ENUM_SESSION_STATUS.ACTIVE);
    return (row as unknown as ISessionRow | undefined) ?? null;
  }

  touchUsed(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string): void {
    this.db
      .prepare("UPDATE sessions SET last_used_at = ? WHERE platform = ? AND account_id = ?")
      .run(now(), platform, accountId);
  }

  delete(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE platform = ? AND account_id = ?").run(platform, accountId);
    return Number(result.changes) > 0;
  }

  /** Активные сессии платформы в порядке ротации: по умолчанию первой, дальше по дате */
  listActive(platform: ENUM_SESSION_PLATFORM_TYPE): ISessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE platform = ? AND status = ? ORDER BY is_default DESC, created_at")
      .all(platform, ENUM_SESSION_STATUS.ACTIVE) as unknown as ISessionRow[];
  }

  addEvent(event: Omit<ISessionEvent, "id" | "created_at">): void {
    this.db
      .prepare(
        `INSERT INTO session_events (platform, account_id, action, actor, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.platform, event.account_id, event.action, event.actor, event.detail, now());
  }

  /** Свежие сверху */
  listEvents(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string, limit: number): ISessionEvent[] {
    return this.db
      .prepare("SELECT * FROM session_events WHERE platform = ? AND account_id = ? ORDER BY id DESC LIMIT ?")
      .all(platform, accountId, limit) as unknown as ISessionEvent[];
  }

  /** Смена account_id: история переезжает вместе с сессией */
  renameEvents(platform: ENUM_SESSION_PLATFORM_TYPE, from: string, to: string): void {
    this.db.prepare("UPDATE session_events SET account_id = ? WHERE platform = ? AND account_id = ?").run(to, platform, from);
  }

  /** Целостная копия базы даже при открытом WAL и идущей записи */
  backupTo(filePath: string): void {
    this.db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
  }
}
