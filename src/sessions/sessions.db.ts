import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { log } from "../utils";

/**
 * Миграции по PRAGMA user_version: индекс в массиве + 1 = версия схемы.
 * Новые миграции только дописываются в конец.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY,
    platform      TEXT    NOT NULL CHECK (platform IN ('telegram', 'instagram', 'youtube')),
    account_id    TEXT    NOT NULL,
    label         TEXT,
    storage_state BLOB    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired')),
    is_default    INTEGER NOT NULL DEFAULT 0,
    last_check_at TEXT,
    last_error    TEXT,
    last_used_at  TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    UNIQUE (platform, account_id)
  );
  `,
  // v2: данные аккаунта для админа — меняются без перезаливки сессии
  `
  ALTER TABLE sessions ADD COLUMN phone TEXT;
  ALTER TABLE sessions ADD COLUMN username TEXT;
  `,
  // v3: служебные флаги (разовый импорт старых папок не повторяется после удаления сессий)
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v4: счётчики скриншотов — «полуживая» сессия заметна раньше, чем протухнет
  `
  ALTER TABLE sessions ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN last_fail_at TEXT;
  `,
  // v5: история действий; без внешнего ключа — история удалённой сессии остаётся
  `
  CREATE TABLE session_events (
    id         INTEGER PRIMARY KEY,
    platform   TEXT NOT NULL,
    account_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    actor      TEXT,
    detail     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX session_events_account ON session_events (platform, account_id, id DESC);
  `,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;

  for (let version = current; version < MIGRATIONS.length; version++) {
    runInTransaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    log.info(`🗄️ Миграция БД сессий v${version + 1} применена`);
  }
}

/**
 * Открывает БД сессий, создаёт папку и применяет миграции.
 * Базы ещё нет — берётся стартовая копия из репо (seed); дальше сервис работает со своей и seed не читает
 */
export function openSessionsDb(dbPath: string, seedPath?: string): DatabaseSync {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  if (!fs.existsSync(resolved) && seedPath && fs.existsSync(path.resolve(seedPath))) {
    fs.copyFileSync(path.resolve(seedPath), resolved);
    log.info(`🗄️ БД сессий создана из стартовой копии ${path.resolve(seedPath)}`);
  }

  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  log.info(`🗄️ БД сессий открыта: ${resolved}`);
  return db;
}

const transactionDepth = new WeakMap<DatabaseSync, number>();

/**
 * node:sqlite не даёт db.transaction(), поэтому BEGIN/COMMIT вручную.
 * Вложенный вызов выполняется внутри внешней транзакции: SQLite не умеет BEGIN внутри BEGIN
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  transactionDepth.set(db, depth + 1);

  if (depth > 0) {
    try {
      return fn();
    } finally {
      transactionDepth.set(db, depth);
    }
  }

  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    transactionDepth.set(db, depth);
  }
}
