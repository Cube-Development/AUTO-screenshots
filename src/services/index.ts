import { ScreenshotService } from '../actions/post-screenshot';
/**
 * Сервис-регистр: единая точка доступа к глобальным синглтонам.
 * Контроллеры/модули импортируют отсюда, а не из entry point (index.ts).
 */
export const screenshotService = ScreenshotService.getInstance();

/** Обёртка для контроллера скриншотов */
export const postScreenshot = (url: string, user_bot_id?: string) =>
  screenshotService.capture(url, user_bot_id);
