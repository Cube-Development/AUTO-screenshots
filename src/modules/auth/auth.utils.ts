import fs from "fs";
import path from "path";
import { BrowserContext } from "playwright";

/** Сюда CLI-скрипты кладут auth.json для загрузки через админку (папка в .gitignore) */
export const EXPORT_DIR = path.resolve("sessions-export");

export function waitForEnter(message: string): Promise<void> {
  console.log(message);
  return new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
}

/** Сохраняет storageState в sessions-export/<platform>_<accountId>.json */
export async function exportStorageState(context: BrowserContext, platform: string, accountId: string): Promise<string> {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filePath = path.join(EXPORT_DIR, `${platform}_${accountId}.json`);
  await context.storageState({ path: filePath });
  console.log(`\n[+] Сессия сохранена: ${filePath}`);
  console.log(`    Загрузите файл в админке: Сессии скриншотов → ${platform} → Загрузить сессию (accountId: ${accountId}).`);
  console.log("    Файл даёт полный доступ к аккаунту — удалите его после загрузки.");
  return filePath;
}

/** Обязательный аргумент CLI: npm run auth:<platform> -- <accountId> */
export function readAccountIdArg(usage: string): string {
  const accountId = process.argv[2]?.trim();
  if (!accountId || !/^[A-Za-z0-9_.@-]{1,128}$/.test(accountId)) {
    console.error(`Использование: ${usage}`);
    process.exit(1);
  }
  return accountId;
}
