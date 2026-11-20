import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { ENUM_SESSION_PLATFORM, ENUM_SESSION_PLATFORM_TYPE, TStorageState } from "../type";

// zod v4 вешает методы на экземпляр при создании: StorageStateSchema должна родиться уже с .openapi,
// иначе dto.ts падает, если этот модуль загрузился раньше него (зависит от порядка импортов)
extendZodWithOpenApi(z);

const CookieSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});

const OriginSchema = z.looseObject({
  origin: z.string(),
  localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
});

/** Формат Playwright storageState. looseObject — чтобы не терять новые поля Playwright (indexedDB и т.п.) */
export const StorageStateSchema = z.looseObject({
  cookies: z.array(CookieSchema),
  origins: z.array(OriginSchema),
});

const TELEGRAM_ORIGIN = "web.telegram.org";
const INSTAGRAM_DOMAIN = "instagram.com";

/**
 * Дешёвая статическая проверка до запуска браузера.
 * null — сессия похожа на залогиненную, иначе текст причины.
 */
export function findStorageStateProblem(platform: ENUM_SESSION_PLATFORM_TYPE, state: TStorageState): string | null {
  if (platform === ENUM_SESSION_PLATFORM.TELEGRAM) {
    const origin = state.origins.find((item) => item.origin.includes(TELEGRAM_ORIGIN));
    const userAuth = origin?.localStorage.find((item) => item.name === "user_auth")?.value;
    if (!userAuth || userAuth === "null") return "Нет localStorage.user_auth для web.telegram.org";
  }

  if (platform === ENUM_SESSION_PLATFORM.INSTAGRAM) {
    const hasSession = state.cookies.some((cookie) => cookie.name === "sessionid" && cookie.domain.includes(INSTAGRAM_DOMAIN));
    if (!hasSession) return "Нет cookie sessionid для instagram.com";
  }

  if (platform === ENUM_SESSION_PLATFORM.YOUTUBE && state.cookies.length === 0) {
    return "Нет cookies";
  }

  return null;
}

/** telegram_user_id из localStorage.user_auth = {"dcID":2,"id":7697061334,...} */
function telegramUserId(state: TStorageState): string | null {
  const origin = state.origins.find((item) => item.origin.includes(TELEGRAM_ORIGIN));
  const raw = origin?.localStorage.find((item) => item.name === "user_auth")?.value;
  try {
    const id = raw ? JSON.parse(raw)?.id : null;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * account_id файла в пакетной загрузке: Telegram — из самой сессии (user_auth),
 * Instagram/YouTube — из имени файла `<platform>_<account>.json` (так их называют скрипты auth:*) или `<account>.json`
 */
export function deriveAccountId(platform: ENUM_SESSION_PLATFORM_TYPE, fileName: string, state: TStorageState): string | null {
  if (platform === ENUM_SESSION_PLATFORM.TELEGRAM) {
    // id из чужого файла не проверен схемой: без цифр сессию потом не открыть ни одной ручкой
    const id = telegramUserId(state);
    return id && isValidAccountId(platform, id) ? id : null;
  }

  const base = fileName.replace(/\\/g, "/").split("/").pop()!.replace(/\.json$/i, "");
  const account = base.startsWith(`${platform}_`) ? base.slice(platform.length + 1) : base;
  return account && account !== "auth" && isValidAccountId(platform, account) ? account : null;
}

/** account_id для Telegram — telegram_user_id, бэк передаёт его как user_bot_id */
export function isValidAccountId(platform: ENUM_SESSION_PLATFORM_TYPE, accountId: string): boolean {
  if (platform === ENUM_SESSION_PLATFORM.TELEGRAM) return /^\d+$/.test(accountId);
  // Только точки (".", "..") — это сегменты пути, а не аккаунт
  return /^[A-Za-z0-9_.@-]{1,128}$/.test(accountId) && !/^\.+$/.test(accountId);
}
