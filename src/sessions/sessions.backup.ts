import fs from "fs";
import path from "path";
import { log } from "../utils";
import { SessionsService } from "./sessions.service";

const LAST_BACKUP_META_KEY = "last_backup_at";
const FILE_PATTERN = /^sessions-\d{8}\.db$/;

/** sessions-YYYYMMDD.db по дате Ташкента: повторный бэкап в тот же день перезаписывает файл */
function backupName(date = new Date()): string {
  const tashkent = new Date(date.getTime() + 5 * 60 * 60_000);
  return `sessions-${tashkent.toISOString().slice(0, 10).replace(/-/g, "")}.db`;
}

/**
 * Ежедневная копия базы сессий рядом с ней (data/backups), хранятся последние `keep`.
 * Сессии в копии так же зашифрованы SESSIONS_ENC_KEY — без ключа бэкап бесполезен
 */
export class SessionsBackup {
  constructor(
    private readonly sessions: SessionsService,
    private readonly dir: string,
    private readonly keep: number,
  ) {}

  public get lastBackupAt(): string | null {
    return this.sessions.getMeta(LAST_BACKUP_META_KEY);
  }

  public async run(): Promise<string> {
    const dir = path.resolve(this.dir);
    fs.mkdirSync(dir, { recursive: true });

    const target = path.join(dir, backupName());
    const tmp = `${target}.tmp`;
    fs.rmSync(tmp, { force: true });
    this.sessions.backupTo(tmp);
    fs.renameSync(tmp, target);

    this.prune(dir);
    this.sessions.setMeta(LAST_BACKUP_META_KEY, new Date().toISOString());
    log.info({ file: target }, `💾 Бэкап БД сессий сохранён`);
    return target;
  }

  /** Имена сортируются как даты: старые сверх `keep` удаляются */
  private prune(dir: string): void {
    const files = fs
      .readdirSync(dir)
      .filter((name) => FILE_PATTERN.test(name))
      .sort()
      .reverse();
    for (const name of files.slice(this.keep)) {
      fs.rmSync(path.join(dir, name), { force: true });
      log.info({ file: name }, `💾 Старый бэкап удалён`);
    }
  }
}
