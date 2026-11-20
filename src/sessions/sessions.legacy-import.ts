import fs from "fs";
import path from "path";
import { ENUM_SESSION_PLATFORM, ENUM_SESSION_PLATFORM_TYPE, TStorageState } from "../type";
import { log } from "../utils";
import { SessionsService } from "./sessions.service";
import { StorageStateSchema } from "./sessions.validator";

const AUTH_FILE = "auth.json";
const TG_DIR_PREFIX = "user_bot_";
/** IG/YT раньше хранили одну сессию без имени аккаунта */
const LEGACY_ACCOUNT_ID = "legacy";
/** Раньше бэк без user_bot_id получал бота "1" — он остаётся сессией по умолчанию */
const LEGACY_DEFAULT_TG_ID = "1";
/** Флаг в таблице meta: импорт делается один раз за жизнь БД */
const LEGACY_IMPORT_META_KEY = "legacy_import_done_at";

interface ILegacyFile {
  platform: ENUM_SESSION_PLATFORM_TYPE;
  accountId: string;
  filePath: string;
}

function collectLegacyFiles(dir: string): ILegacyFile[] {
  const files: ILegacyFile[] = [];

  const tgDir = path.join(dir, "telegram");
  if (fs.existsSync(tgDir)) {
    // user_bot_1 первым, чтобы он стал сессией по умолчанию
    const botDirs = fs
      .readdirSync(tgDir)
      .filter((name) => name.startsWith(TG_DIR_PREFIX))
      .sort((a, b) => Number(a !== `${TG_DIR_PREFIX}${LEGACY_DEFAULT_TG_ID}`) - Number(b !== `${TG_DIR_PREFIX}${LEGACY_DEFAULT_TG_ID}`));
    for (const name of botDirs) {
      files.push({
        platform: ENUM_SESSION_PLATFORM.TELEGRAM,
        accountId: name.slice(TG_DIR_PREFIX.length),
        filePath: path.join(tgDir, name, AUTH_FILE),
      });
    }
  }

  for (const platform of [ENUM_SESSION_PLATFORM.INSTAGRAM, ENUM_SESSION_PLATFORM.YOUTUBE]) {
    files.push({ platform, accountId: LEGACY_ACCOUNT_ID, filePath: path.join(dir, platform, AUTH_FILE) });
  }

  return files.filter((file) => fs.existsSync(file.filePath));
}

function readState(filePath: string): TStorageState | null {
  try {
    const parsed = StorageStateSchema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf8")));
    return parsed.success ? (parsed.data as TStorageState) : null;
  } catch {
    return null;
  }
}

/**
 * Разовый импорт старых src/auth/** в SQLite: добавляет только отсутствующие записи.
 * После выката папку удаляем — в рантайме источник только SQLite.
 */
export function importLegacySessions(sessions: SessionsService, dir: string): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return;

  // Иначе удалённая в админке сессия возвращалась бы из папки на каждом старте
  const importedAt = sessions.getMeta(LEGACY_IMPORT_META_KEY);
  if (importedAt) {
    log.info(`🗄️ Импорт из ${resolved} уже был ${importedAt}, папку можно удалить`);
    return;
  }

  let imported = 0;
  let skipped = 0;

  for (const file of collectLegacyFiles(resolved)) {
    const state = readState(file.filePath);
    if (!state) {
      log.warn({ platform: file.platform, accountId: file.accountId }, `Импорт: невалидный ${AUTH_FILE}, пропускаем`);
      skipped++;
      continue;
    }

    if (sessions.importIfAbsent(file.platform, file.accountId, state)) imported++;
    else skipped++;
  }

  sessions.setMeta(LEGACY_IMPORT_META_KEY, new Date().toISOString());
  log.info(`🗄️ Импорт сессий из ${resolved}: добавлено ${imported}, пропущено ${skipped}`);
}
