import type { Page } from "playwright";
import type { ENUM_SESSION_PLATFORM_TYPE, ISession, TSessionActor } from "../../type";

/** Шаг входа: что админ должен прислать дальше; done — сессия сохранена */
export const ENUM_LOGIN_STEP = {
  CODE: "code",
  PASSWORD: "password",
  /** Telegram: ждём, пока QR отсканируют телефоном с аккаунтом; админ опрашивает вход */
  QR: "qr",
  DONE: "done",
} as const;

/** Как входим: по номеру и коду или по QR (только Telegram) */
export const ENUM_LOGIN_METHOD = {
  PHONE: "phone",
  QR: "qr",
} as const;

export type ENUM_LOGIN_METHOD_TYPE = (typeof ENUM_LOGIN_METHOD)[keyof typeof ENUM_LOGIN_METHOD];

export type ENUM_LOGIN_STEP_TYPE = (typeof ENUM_LOGIN_STEP)[keyof typeof ENUM_LOGIN_STEP];

/** Данные старта: Telegram — phone, Instagram — username и password */
export interface ILoginStartInput {
  /** По умолчанию — по номеру/логину */
  method?: ENUM_LOGIN_METHOD_TYPE;
  phone?: string;
  username?: string;
  password?: string;
  label?: string;
  /** Перелогин или вход из строки юзербота: вошли не в этот аккаунт — сессия не сохраняется */
  expectedAccountId?: string;
  /** Почта админа — в историю сессии */
  actor?: TSessionActor;
}

export interface ILoginAccount {
  accountId: string;
  username: string | null;
}

/** Сценарий входа одной платформы поверх открытой страницы */
export interface ILoginDriver {
  start(page: Page, input: ILoginStartInput): Promise<ENUM_LOGIN_STEP_TYPE>;
  submitCode(page: Page, code: string): Promise<ENUM_LOGIN_STEP_TYPE>;
  submitPassword(page: Page, password: string): Promise<ENUM_LOGIN_STEP_TYPE>;
  /** Запросить код ещё раз (SMS вместо сообщения в Telegram и т.п.); шаг остаётся code */
  resendCode(page: Page): Promise<void>;
  /** Аккаунт, под которым вошли: Telegram — id из localStorage, Instagram — логин */
  finish(page: Page, input: ILoginStartInput): Promise<ILoginAccount>;
  /** Вход по QR: открыть страницу с QR — есть только у Telegram */
  startQr?(page: Page): Promise<ENUM_LOGIN_STEP_TYPE>;
  /** Один опрос без ожидания: вошли, нужен пароль или null — QR ещё не отсканирован */
  pollQr?(page: Page): Promise<ENUM_LOGIN_STEP_TYPE | null>;
  /** Текущий QR картинкой (png base64): Telegram обновляет его примерно раз в 30 с */
  qrImage?(page: Page): Promise<string | null>;
}

export interface ILoginResult {
  login_id: string;
  platform: ENUM_SESSION_PLATFORM_TYPE;
  step: ENUM_LOGIN_STEP_TYPE;
  /** Только на шаге done */
  session: ISession | null;
  /** Только на шаге qr: png base64 */
  qr_image: string | null;
}
