import type { Browser } from "playwright";
import type { SessionsService } from "../src/sessions/sessions.service";
import type { TStorageState } from "../src/type";

/** Минимальные storageState, которые проходят статическую проверку платформы */
export const telegramState = (userId: number | string): TStorageState => ({
  cookies: [],
  origins: [
    {
      origin: "https://web.telegram.org",
      localStorage: [{ name: "user_auth", value: JSON.stringify({ dcID: 2, id: userId }) }],
    },
  ],
});

export const instagramState = (): TStorageState => ({
  cookies: [
    {
      name: "sessionid", value: "x", domain: ".instagram.com", path: "/", expires: -1,
      httpOnly: true, secure: true, sameSite: "Lax",
    },
  ],
  origins: [],
});

export const youtubeState = (): TStorageState => ({
  cookies: [
    {
      name: "SID", value: "x", domain: ".youtube.com", path: "/", expires: -1,
      httpOnly: true, secure: true, sameSite: "Lax",
    },
  ],
  origins: [],
});

/** Чистая база между тестами: сервис — синглтон на процесс */
export function resetSessions(service: SessionsService): void {
  const internal = service as unknown as {
    repository: { database: { exec(sql: string): void } };
    stateCache: Map<string, unknown>;
    rotation: Map<string, number>;
  };
  internal.repository.database.exec("DELETE FROM sessions; DELETE FROM session_events; DELETE FROM meta;");
  internal.stateCache.clear();
  internal.rotation.clear();
}

/** Браузер без сети: любой контекст падает, как при недоступной платформе */
export const offlineBrowser = (): Browser =>
  ({
    newContext: async () => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    },
  }) as unknown as Browser;
