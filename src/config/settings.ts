import { env } from "./schema";

export class SETTINGS {
  // Внешние сервисы
  static get BLOGIX_API_URL()     { return env.BLOGIX_API_URL; }
  static get SERVER_API_KEY()     { return env.SERVER_API_KEY; }
  static get BLOGIX_API_KEY()     { return env.BLOGIX_API_KEY; }

  // Telegram-нотификация
  static get SEND_TO_TELEGRAM()   { return env.SEND_TO_TELEGRAM === "true"; }
  static get TG_BOT_TOKEN()       { return env.TG_BOT_TOKEN; }
  static get TG_CHAT_ID()         { return env.TG_CHAT_ID; }
  static get TG_TOPIC_ID()        { return env.TG_TOPIC_ID; }


  // Лимиты и порт
  static get TEST_SCREENSHOTS()   { return env.TEST_SCREENSHOTS === "true"; }
  static get MAX_SCREENSHOT_LIMIT(){ return env.MAX_SCREENSHOT_LIMIT; }
  static get PORT()               { return env.PORT; }
}