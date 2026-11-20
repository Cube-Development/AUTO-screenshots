import { ScreenshotService } from '../actions/post-screenshot';
import { SETTINGS } from '../config';
import { SessionsBackup, SessionsHealth, SessionsService } from '../sessions';
import { SessionLoginManager } from '../sessions/login';
/**
 * Сервис-регистр: единая точка доступа к глобальным синглтонам.
 * Контроллеры/модули импортируют отсюда, а не из entry point (index.ts).
 */
export const screenshotService = ScreenshotService.getInstance();
export const sessionsService = SessionsService.getInstance();
/** Вход в аккаунт в headless-браузере: тот же shared Chromium, что и у скриншотов */
export const sessionLoginManager = new SessionLoginManager(() => screenshotService.getBrowser(), sessionsService);
/** Массовая и ежедневная живая проверка сессий */
export const sessionsHealth = new SessionsHealth(() => screenshotService.getBrowser(), sessionsService);
/** Ежедневная копия базы сессий в data/backups */
export const sessionsBackup = new SessionsBackup(sessionsService, SETTINGS.SESSIONS_BACKUP_DIR, SETTINGS.SESSIONS_BACKUP_KEEP);

/** Обёртка для контроллера скриншотов */
export const postScreenshot = (url: string, user_bot_id?: string, signal?: AbortSignal, reqId?: string) =>
  screenshotService.capture(url, user_bot_id, signal, reqId);
