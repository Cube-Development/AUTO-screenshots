export const ROUTES_SESSIONS = {
    BASE: '/sessions',
    LIST: '/',
    SUMMARY: '/summary',
    CHECK_ALL: '/check-all',
    ITEM: '/:platform/:accountId',
    CHECK: '/:platform/:accountId/check',
    TEST_SCREENSHOT: '/:platform/:accountId/test-screenshot',
    RELOGIN: '/:platform/:accountId/relogin',
    EVENTS: '/:platform/:accountId/events',
    /** Пакетная загрузка файлов: свой лимит тела (до 10 файлов) */
    IMPORT: '/:platform/import',
    /** Вход в headless-браузере: объявляются раньше ITEM, иначе DELETE /login/:id попадёт в удаление сессии */
    LOGIN_START: '/:platform/login',
    LOGIN_CODE: '/login/:loginId/code',
    LOGIN_PASSWORD: '/login/:loginId/password',
    LOGIN_RESEND: '/login/:loginId/resend',
    LOGIN_CANCEL: '/login/:loginId',
    /** Опрос входа по QR */
    LOGIN_POLL: '/login/:loginId',
} as const

/** Лимит тела: storageState YouTube весит ~25 КБ, глобальный express.json — 100 КБ */
export const SESSIONS_BODY_LIMIT = '2mb';
/** До 10 файлов по ~1 МБ */
export const SESSIONS_IMPORT_BODY_LIMIT = '12mb';
