/**
 * Кто вошёл в Telegram Web K. Старый Web K хранит localStorage.user_auth = {"dcID":2,"id":7697061334},
 * новый (несколько аккаунтов) — account1..N = {..., userId: "7697061334"}; сейчас пишет оба, но полагаться
 * на один ключ нельзя: сессии из старых файлов знают только user_auth, свежие входы могут знать только accountN
 */

/** Сколько слотов аккаунтов Web K перебирать (в интерфейсе их до 4) */
const MAX_ACCOUNTS = 4;

interface IStorageEntry {
  name: string;
  value: string;
}

const parse = (value: string | null | undefined): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** id вошедшего аккаунта из localStorage storageState (файл сессии); null — входа нет */
export function telegramAccountIdFromStorage(entries: IStorageEntry[]): string | null {
  const read = (name: string) => parse(entries.find((item) => item.name === name)?.value);
  const legacy = read("user_auth")?.id;
  if (legacy != null && legacy !== "") return String(legacy);
  for (let index = 1; index <= MAX_ACCOUNTS; index++) {
    const userId = read(`account${index}`)?.userId;
    if (userId != null && userId !== "") return String(userId);
  }
  return null;
}

/**
 * То же внутри страницы: выражение для page.evaluate / waitForFunction.
 * Строкой, а не функцией: tsx (esbuild keepNames) оборачивает вложенные функции в __name, которого нет в браузере
 */
export const TELEGRAM_ACCOUNT_ID_JS = `(() => {
  const read = (name) => { try { const v = JSON.parse(localStorage.getItem(name) || "null"); return v && typeof v === "object" ? v : null; } catch (e) { return null; } };
  const legacy = read("user_auth");
  if (legacy && legacy.id != null && legacy.id !== "") return String(legacy.id);
  for (let i = 1; i <= ${MAX_ACCOUNTS}; i++) {
    const account = read("account" + i);
    if (account && account.userId != null && account.userId !== "") return String(account.userId);
  }
  return null;
})()`;
