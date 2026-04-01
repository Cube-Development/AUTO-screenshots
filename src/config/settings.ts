import { env } from "./schema";

export class SETTINGS {
  // Внешние сервисы
  static get BLOGIX_API_URL()     { return env.BLOGIX_API_URL; }
  static get SERVER_API_KEY()     { return env.SERVER_API_KEY; }
  static get BLOGIX_API_KEY()     { return env.BLOGIX_API_KEY; }

  // Лимиты и порт
  static get TEST_SCREENSHOTS()   { return env.TEST_SCREENSHOTS === "true"; }
  static get MAX_SCREENSHOT_LIMIT(){ return env.MAX_SCREENSHOT_LIMIT; }
  static get PORT()               { return env.PORT; }
}