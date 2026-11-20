// npm run seed:update
// Снимок рабочей базы в seed/sessions.db (стартовая копия для нового сервера).
// VACUUM INTO даёт целостную копию даже при запущенном сервисе и непустом WAL
import "dotenv/config";
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

const dbPath = path.resolve(process.env.SESSIONS_DB_PATH || "./data/sessions.db");
const seedPath = path.resolve(process.env.SESSIONS_SEED_PATH || "./seed/sessions.db");

if (!fs.existsSync(dbPath)) {
  console.error(`[×] Нет базы ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(seedPath), { recursive: true });
const tmpPath = `${seedPath}.tmp`;
fs.rmSync(tmpPath, { force: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
const count = (db.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count;
db.close();

fs.renameSync(tmpPath, seedPath);
console.log(`[+] seed обновлён: ${seedPath} (сессий: ${count}). Сессии в нём зашифрованы SESSIONS_ENC_KEY`);
