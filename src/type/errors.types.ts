export interface IErrorCallback {
  success: boolean;
  code: number;
  message: string;
}

/** Коды ошибок сессий: продолжают нумерацию 1001–1007 из post-screenshot */
export const ENUM_SESSION_ERROR = {
  SESSION_NOT_FOUND: 1008,
  SESSION_EXPIRED: 1009,
  SESSION_INVALID_STATE: 1010,
  SESSION_NOT_LOGGED_IN: 1011,
  SESSION_INTERNAL_ERROR: 1012,
  /** Смена account_id: у платформы уже есть сессия с таким аккаунтом */
  SESSION_ALREADY_EXISTS: 1013,
  /** Вход в headless-браузере: login_id не найден или истёк (10 минут без действий) */
  LOGIN_NOT_FOUND: 1014,
  /** Вход уже на другом шаге или занят предыдущим запросом */
  LOGIN_WRONG_STEP: 1015,
  /** Платформа отклонила ввод: неверный телефон, код, пароль; detail — текст платформы */
  LOGIN_REJECTED: 1016,
  /** Страница входа повела себя неожиданно или не ответила вовремя */
  LOGIN_FAILED: 1017,
  /** Вход выполнен, но не в ожидаемый аккаунт (перелогин, юзербот): сессия не сохранена, вход закрыт */
  LOGIN_ACCOUNT_MISMATCH: 1018,
} as const;

export type ENUM_SESSION_ERROR_TYPE = keyof typeof ENUM_SESSION_ERROR;

/** Ошибка сессии: message — ключ ENUM_SESSION_ERROR, detail — подробности для last_error и логов */
export class SessionError extends Error {
  readonly code: number;
  /** Скриншот страницы (jpeg base64), если шаг входа упал: админ видит, что показала платформа */
  image: string | null = null;

  constructor(
    message: ENUM_SESSION_ERROR_TYPE,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "SessionError";
    this.code = ENUM_SESSION_ERROR[message];
  }

  toCallback(): IErrorCallback {
    return { success: false, code: this.code, message: this.message };
  }
}
