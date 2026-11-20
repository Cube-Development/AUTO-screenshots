import type { BrowserContextOptions } from "playwright";

export const ENUM_SESSION_PLATFORM = {
  TELEGRAM: "telegram",
  INSTAGRAM: "instagram",
  YOUTUBE: "youtube",
} as const;

export type ENUM_SESSION_PLATFORM_TYPE = (typeof ENUM_SESSION_PLATFORM)[keyof typeof ENUM_SESSION_PLATFORM];

export const SESSION_PLATFORMS = Object.values(ENUM_SESSION_PLATFORM) as [
  ENUM_SESSION_PLATFORM_TYPE,
  ...ENUM_SESSION_PLATFORM_TYPE[],
];

/** expired выставляет только сервис (проверка или скриншот), админ переключает active/disabled */
export const ENUM_SESSION_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled",
  EXPIRED: "expired",
} as const;

export type ENUM_SESSION_STATUS_TYPE = (typeof ENUM_SESSION_STATUS)[keyof typeof ENUM_SESSION_STATUS];

/** Playwright storageState объектом (не путь к файлу) */
export type TStorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

/** Сессия наружу: storage_state никогда не отдаётся */
export interface ISession {
  platform: ENUM_SESSION_PLATFORM_TYPE;
  account_id: string;
  label: string | null;
  /** Телефон аккаунта в E.164 (+998901234567) — для админа, в скриншотах не участвует */
  phone: string | null;
  /** Опознаватель аккаунта на платформе, всегда с @ (@blogix_bot) */
  username: string | null;
  status: ENUM_SESSION_STATUS_TYPE;
  is_default: boolean;
  last_check_at: string | null;
  last_error: string | null;
  last_used_at: string | null;
  /** Успешные и упавшие скриншоты под сессией (ошибки самой сессии сюда не входят) */
  success_count: number;
  fail_count: number;
  last_fail_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ISessionPlatformSummary {
  total: number;
  active: number;
  disabled: number;
  expired: number;
  default_account_id: string | null;
  default_username: string | null;
}

/** Итог проверки одной сессии в массовой проверке */
export interface ISessionCheckItem {
  platform: ENUM_SESSION_PLATFORM_TYPE;
  account_id: string;
  ok: boolean;
  error: string | null;
  /** Проверить не удалось (сеть, таймаут) — статус сессии не менялся */
  inconclusive?: boolean;
}

export interface ISessionCheckAllResult {
  checked: number;
  active: number;
  expired: number;
  items: ISessionCheckItem[];
}

/** Данные аккаунта, которые меняются без перезаливки сессии; null — очистить поле */
export interface ISessionAccountFields {
  label?: string | null;
  phone?: string | null;
  username?: string | null;
}

/** Сессия для рантайма скриншотов */
export interface IResolvedSession {
  platform: ENUM_SESSION_PLATFORM_TYPE;
  accountId: string;
  state: TStorageState;
}

export interface ISessionCheckResult {
  ok: boolean;
  error: string | null;
  /**
   * true — проверить не удалось (таймаут, сеть, неожиданная страница). Это не доказательство выхода:
   * статус сессии не меняется, иначе сбой платформы в 04:00 «разлогинил» бы все сессии разом
   */
  inconclusive?: boolean;
}

/** Что случилось с сессией: история в админке */
export const ENUM_SESSION_EVENT = {
  /** Файл загружен (по одному или пачкой) */
  UPLOAD: "upload",
  /** Вход в браузере сервиса */
  LOGIN: "login",
  /** Разовый импорт из старых папок */
  IMPORT: "import",
  /** Точечная правка: данные аккаунта, статус, сессия по умолчанию, account_id */
  UPDATE: "update",
  /** Проверка или скриншот: входа больше нет */
  EXPIRE: "expire",
  /** Проверка снова нашла вход */
  REACTIVATE: "reactivate",
  /** Сервис сам сделал сессию сессией по умолчанию */
  DEFAULT_CHANGE: "default_change",
  DELETE: "delete",
} as const;

export type ENUM_SESSION_EVENT_TYPE = (typeof ENUM_SESSION_EVENT)[keyof typeof ENUM_SESSION_EVENT];

export interface ISessionEvent {
  id: number;
  platform: ENUM_SESSION_PLATFORM_TYPE;
  account_id: string;
  action: ENUM_SESSION_EVENT_TYPE;
  /** Почта админа из бэка; null — сам сервис (плановая проверка, скриншот) */
  actor: string | null;
  detail: string | null;
  created_at: string;
}

/** Кто инициировал изменение: почта админа (заголовок X-Admin-Email) или null — сервис */
export type TSessionActor = string | null;

/** Итог выхода из аккаунта перед удалением */
export interface ISessionLogoutResult {
  ok: boolean;
  error: string | null;
}

/** Итог одного файла в пакетной загрузке */
export interface ISessionImportItem {
  name: string;
  account_id: string | null;
  ok: boolean;
  error: string | null;
  session: ISession | null;
}

export type TSessionChangeEvent =
  | { type: "upsert"; platform: ENUM_SESSION_PLATFORM_TYPE; accountId: string; state: TStorageState }
  | { type: "remove"; platform: ENUM_SESSION_PLATFORM_TYPE; accountId: string };
