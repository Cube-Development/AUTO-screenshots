import { Request, Response } from "express";
import { z } from "zod";
import { screenshotService, sessionLoginManager, sessionsBackup, sessionsHealth, sessionsService } from "../../services";
import { StorageStateSchema, deriveAccountId, findStorageStateProblem, isValidAccountId, logoutStorageState } from "../../sessions";
import { SessionLoginManager } from "../../sessions/login";
import {
    ENUM_SESSION_EVENT,
    ENUM_SESSION_PLATFORM,
    ENUM_SESSION_PLATFORM_TYPE,
    ENUM_SESSION_STATUS,
    ISessionCheckResult,
    ISessionImportItem,
    ISessionLogoutResult,
    SessionError,
    TSessionActor,
    TStorageState,
} from "../../type";
import { log } from "../../utils";
import {
    CheckAllQuerySchema,
    DeleteSessionQuerySchema,
    ImportSessionsSchema,
    ListSessionsQuerySchema,
    LoginCodeSchema,
    LoginParamsSchema,
    LoginPasswordSchema,
    LoginStartSchema,
    ReloginSchema,
    SessionEventsQuerySchema,
    SessionParamsSchema,
    SessionPlatformSchema,
    TestScreenshotSchema,
    UpdateSessionSchema,
    UpsertSessionSchema,
} from "./dto";

interface ISessionParams {
    platform: ENUM_SESSION_PLATFORM_TYPE;
    accountId: string;
}

const HTTP_STATUS_BY_SESSION_ERROR: Record<number, number> = {
    1008: 404,
    1010: 422,
    1011: 422,
    1013: 409,
    1014: 404,
    1015: 409,
    1016: 422,
    1017: 502,
    1018: 422,
};

const ACTOR_MAX_LENGTH = 256;

/** Кто действует: бэк передаёт почту админа в X-Admin-Email; без заголовка — null (сервис или скрипт) */
function actorOf(req: Request): TSessionActor {
    const value = req.get("x-admin-email")?.trim();
    return value ? value.slice(0, ACTOR_MAX_LENGTH) : null;
}

function sendValidationError(res: Response, error: z.ZodError) {
    return res.status(422).json({
        success: false,
        code: 1001,
        message: "VALIDATION_ERROR",
        errors: (z.treeifyError(error) as { properties?: unknown }).properties,
    });
}

function sendSessionError(res: Response, error: SessionError) {
    return res.status(HTTP_STATUS_BY_SESSION_ERROR[error.code] ?? 400).json({
        ...error.toCallback(),
        detail: error.detail,
        // Скриншот страницы входа (jpeg base64), если шаг упал
        ...(error.image ? { detail_image: error.image } : {}),
    });
}

/** Ошибки вне контракта: тело запроса (storage_state) в лог не попадает */
function sendInternalError(res: Response, error: unknown, logCtx: Record<string, unknown>) {
    if (error instanceof SessionError) return sendSessionError(res, error);
    log.error({ ...logCtx, err: (error as Error)?.message || String(error) }, `Ошибка API сессий`);
    return sendSessionError(res, new SessionError("SESSION_INTERNAL_ERROR"));
}

/** Причина отказа при загрузке: «нет входа» и «не удалось проверить» — разные советы админу */
function checkFailure(check: ISessionCheckResult): string {
    return check.inconclusive
        ? `Не удалось проверить вход (${check.error ?? "нет ответа"}) — повторите или загрузите без проверки`
        : (check.error ?? "Вход не подтвердился");
}

/** Валидирует platform/accountId; null — ответ с ошибкой уже отправлен */
function parseParams(req: Request, res: Response): ISessionParams | null {
    const parsed = SessionParamsSchema.safeParse(req.params);
    if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return null;
    }
    if (!isValidAccountId(parsed.data.platform, parsed.data.accountId)) {
        sendSessionError(res, new SessionError("SESSION_INVALID_STATE", "Некорректный accountId для платформы"));
        return null;
    }
    return parsed.data;
}

export const listSessions = (req: Request, res: Response) => {
    const parsed = ListSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    try {
        res.json({ success: true, data: sessionsService.list(parsed.data.platform) });
    } catch (error) {
        sendInternalError(res, error, { action: "list" });
    }
};

/** Загрузка или замена: статическая проверка → живая проверка (verify) → сохранение */
export const upsertSession = async (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;
    const parsed = UpsertSessionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const { platform, accountId } = params;
    const state = parsed.data.storage_state as TStorageState;
    const logCtx = { action: "upsert", platform, accountId };

    try {
        const problem = findStorageStateProblem(platform, state);
        if (problem) return sendSessionError(res, new SessionError("SESSION_INVALID_STATE", problem));

        if (parsed.data.verify) {
            const check = await screenshotService.checkSession(platform, state);
            if (!check.ok) {
                log.warn({ ...logCtx, err: check.error }, `Загружаемая сессия не прошла проверку`);
                return sendSessionError(res, new SessionError("SESSION_NOT_LOGGED_IN", checkFailure(check)));
            }
        }

        const session = sessionsService.upsert(platform, accountId, state, {
            label: parsed.data.label,
            phone: parsed.data.phone,
            username: parsed.data.username,
            verified: parsed.data.verify,
            source: ENUM_SESSION_EVENT.UPLOAD,
            actor: actorOf(req),
        });
        res.json({ success: true, data: session });
    } catch (error) {
        sendInternalError(res, error, logCtx);
    }
};

export const updateSession = (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;
    const parsed = UpdateSessionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const newAccountId = parsed.data.account_id;
    if (newAccountId !== undefined && !isValidAccountId(params.platform, newAccountId)) {
        return sendSessionError(res, new SessionError("SESSION_INVALID_STATE", "Некорректный account_id для платформы"));
    }

    try {
        const session = sessionsService.update(params.platform, params.accountId, {
            accountId: newAccountId,
            label: parsed.data.label,
            phone: parsed.data.phone,
            username: parsed.data.username,
            status: parsed.data.status,
            isDefault: parsed.data.is_default,
        }, actorOf(req));
        if (!session) return sendSessionError(res, new SessionError("SESSION_NOT_FOUND"));
        res.json({ success: true, data: session });
    } catch (error) {
        sendInternalError(res, error, { action: "update", ...params });
    }
};

/** Живая проверка сохранённой сессии; результат — в status/last_error */
export const checkSession = async (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;

    try {
        const state = sessionsService.getState(params.platform, params.accountId);
        if (!state) return sendSessionError(res, new SessionError("SESSION_NOT_FOUND"));

        const check = await screenshotService.checkSession(params.platform, state);
        const session = sessionsService.markChecked(params.platform, params.accountId, check, actorOf(req));
        if (!session) return sendSessionError(res, new SessionError("SESSION_NOT_FOUND"));
        res.json({ success: true, data: session });
    } catch (error) {
        sendInternalError(res, error, { action: "check", ...params });
    }
};

/** logout=true — сначала выйти из аккаунта (лучшее усилие: сессия удаляется и при ошибке выхода) */
export const deleteSession = async (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;
    const query = DeleteSessionQuerySchema.safeParse(req.query);
    if (!query.success) return sendValidationError(res, query.error);

    try {
        const state = sessionsService.getState(params.platform, params.accountId);
        if (!state) return sendSessionError(res, new SessionError("SESSION_NOT_FOUND"));

        // Разлогиненная сессия: выходить не из чего, а «ок» выхода был бы неправдой
        const alreadyExpired = sessionsService.get(params.platform, params.accountId)?.status === ENUM_SESSION_STATUS.EXPIRED;
        let logout: ISessionLogoutResult | null = null;
        if (query.data.logout && !alreadyExpired) {
            logout = await logoutStorageState(await screenshotService.getBrowser(), params.platform, state);
            if (!logout.ok) log.warn({ action: "delete", ...params, err: logout.error }, `Выход из аккаунта перед удалением не удался`);
        }

        const detail = logout
            ? (logout.ok ? "с выходом из аккаунта" : `выход не удался: ${logout.error}`)
            : query.data.logout ? "выход пропущен: сессия уже разлогинена" : null;
        if (!sessionsService.delete(params.platform, params.accountId, actorOf(req), detail)) {
            return sendSessionError(res, new SessionError("SESSION_NOT_FOUND"));
        }
        res.json({ success: true, data: { logout } });
    } catch (error) {
        sendInternalError(res, error, { action: "delete", ...params });
    }
};

/** Сводка для админки: статусы по платформам, сессия по умолчанию, последняя плановая проверка */
export const sessionsSummary = (_req: Request, res: Response) => {
    try {
        res.json({
            success: true,
            data: {
                platforms: sessionsService.summary(),
                last_check_all_at: sessionsHealth.lastCheckAllAt,
                last_backup_at: sessionsBackup.lastBackupAt,
                active_logins: sessionLoginManager.activeCount,
            },
        });
    } catch (error) {
        sendInternalError(res, error, { action: "summary" });
    }
};

/** Живая проверка всех активных сессий (или одной платформы) по очереди */
export const checkAllSessions = async (req: Request, res: Response) => {
    const parsed = CheckAllQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    try {
        res.json({ success: true, data: await sessionsHealth.checkAll(parsed.data.platform, actorOf(req)) });
    } catch (error) {
        sendInternalError(res, error, { action: "check-all" });
    }
};

/** Скриншот поста под этой сессией без загрузки в Blogix: jpeg base64 */
export const testScreenshot = async (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;
    const parsed = TestScreenshotSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    if (screenshotService.platformOf(parsed.data.post_url) !== params.platform) {
        return res.status(422).json({
            success: false,
            code: 1001,
            message: "VALIDATION_ERROR",
            errors: { post_url: { errors: [`Нужна ссылка на пост ${params.platform}`] } },
        });
    }

    try {
        const image = await screenshotService.testScreenshot(params.platform, params.accountId, parsed.data.post_url);
        res.json({ success: true, data: { image: image.toString("base64") } });
    } catch (error) {
        if (error instanceof SessionError) return sendSessionError(res, error);
        // Скриншот не получился (таймаут, пост не найден) — это ответ проверки, а не сбой API
        log.warn({ action: "test-screenshot", ...params, err: (error as Error)?.message }, `Тестовый скриншот не получился`);
        res.status(502).json({ success: false, code: 1004, message: "SCREENSHOT_FAILED", detail: (error as Error)?.message ?? null });
    }
};

/** Старт входа в headless-браузере: Telegram — phone, Instagram — username и password */
export const startLogin = async (req: Request, res: Response) => {
    const platform = SessionPlatformSchema.safeParse(req.params.platform);
    if (!platform.success) return sendValidationError(res, platform.error);
    const parsed = LoginStartSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    if (!SessionLoginManager.isSupported(platform.data)) {
        return sendSessionError(res, new SessionError("LOGIN_REJECTED", `Вход в ${platform.data} через браузер не поддерживается — загрузите файл сессии`));
    }
    const isQr = parsed.data.method === "qr";
    if (isQr && platform.data !== ENUM_SESSION_PLATFORM.TELEGRAM) {
        return sendSessionError(res, new SessionError("LOGIN_REJECTED", "Вход по QR есть только у Telegram"));
    }
    if (platform.data === ENUM_SESSION_PLATFORM.TELEGRAM && !isQr && !parsed.data.phone) {
        return sendSessionError(res, new SessionError("LOGIN_REJECTED", "Нужен телефон"));
    }
    if (platform.data === ENUM_SESSION_PLATFORM.INSTAGRAM && (!parsed.data.username || !parsed.data.password)) {
        return sendSessionError(res, new SessionError("LOGIN_REJECTED", "Нужны логин и пароль"));
    }

    try {
        const result = await sessionLoginManager.start(platform.data, {
            method: parsed.data.method,
            actor: actorOf(req),
            phone: parsed.data.phone,
            username: parsed.data.username,
            password: parsed.data.password,
            label: parsed.data.label,
            expectedAccountId: parsed.data.expected_account_id,
        });
        res.json({ success: true, data: result });
    } catch (error) {
        sendInternalError(res, error, { action: "login-start", platform: platform.data });
    }
};

/** Перелогин существующей сессии: телефон или логин из неё, войти нужно в тот же аккаунт */
export const reloginSession = async (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;
    const parsed = ReloginSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error);

    try {
        const result = await sessionLoginManager.relogin(params.platform, params.accountId, { ...parsed.data, actor: actorOf(req) });
        res.json({ success: true, data: result });
    } catch (error) {
        sendInternalError(res, error, { action: "relogin", ...params });
    }
};

/** login_id из пути; null — ответ с ошибкой уже отправлен */
function parseLoginId(req: Request, res: Response): string | null {
    const parsed = LoginParamsSchema.safeParse(req.params);
    if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return null;
    }
    return parsed.data.loginId;
}

export const submitLoginCode = async (req: Request, res: Response) => {
    const loginId = parseLoginId(req, res);
    if (!loginId) return;
    const parsed = LoginCodeSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    try {
        res.json({ success: true, data: await sessionLoginManager.submitCode(loginId, parsed.data.code) });
    } catch (error) {
        sendInternalError(res, error, { action: "login-code", loginId });
    }
};

export const submitLoginPassword = async (req: Request, res: Response) => {
    const loginId = parseLoginId(req, res);
    if (!loginId) return;
    const parsed = LoginPasswordSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    try {
        res.json({ success: true, data: await sessionLoginManager.submitPassword(loginId, parsed.data.password) });
    } catch (error) {
        sendInternalError(res, error, { action: "login-password", loginId });
    }
};

export const resendLoginCode = async (req: Request, res: Response) => {
    const loginId = parseLoginId(req, res);
    if (!loginId) return;

    try {
        res.json({ success: true, data: await sessionLoginManager.resendCode(loginId) });
    } catch (error) {
        sendInternalError(res, error, { action: "login-resend", loginId });
    }
};

export const cancelLogin = async (req: Request, res: Response) => {
    const loginId = parseLoginId(req, res);
    if (!loginId) return;

    try {
        if (!(await sessionLoginManager.cancel(loginId))) {
            return sendSessionError(res, new SessionError("LOGIN_NOT_FOUND"));
        }
        res.json({ success: true });
    } catch (error) {
        sendInternalError(res, error, { action: "login-cancel", loginId });
    }
};

/** Опрос входа по QR: отсканировали — done/password, иначе тот же шаг со свежим QR */
export const pollLogin = async (req: Request, res: Response) => {
    const loginId = parseLoginId(req, res);
    if (!loginId) return;

    try {
        res.json({ success: true, data: await sessionLoginManager.pollQr(loginId) });
    } catch (error) {
        sendInternalError(res, error, { action: "login-poll", loginId });
    }
};

/** История действий с сессией; работает и для уже удалённой */
export const sessionEvents = (req: Request, res: Response) => {
    const params = parseParams(req, res);
    if (!params) return;
    const query = SessionEventsQuerySchema.safeParse(req.query);
    if (!query.success) return sendValidationError(res, query.error);

    try {
        res.json({ success: true, data: sessionsService.events(params.platform, params.accountId, query.data.limit) });
    } catch (error) {
        sendInternalError(res, error, { action: "events", ...params });
    }
};

/**
 * Пакетная загрузка файлов одной платформы. Каждый файл — отдельный итог: ошибка одного не мешает остальным.
 * account_id: Telegram — из user_auth в файле, Instagram/YouTube — из имени файла
 */
export const importSessions = async (req: Request, res: Response) => {
    const platform = SessionPlatformSchema.safeParse(req.params.platform);
    if (!platform.success) return sendValidationError(res, platform.error);
    const parsed = ImportSessionsSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const actor = actorOf(req);
    const items: ISessionImportItem[] = [];
    try {
        // По одному: живая проверка открывает страницу платформы
        for (const file of parsed.data.files) {
            items.push(await importOne(platform.data, file.name, file.storage_state, parsed.data.verify, actor));
        }
        log.info({ platform: platform.data, total: items.length, saved: items.filter((item) => item.ok).length }, `🔑 Пакетная загрузка сессий`);
        res.json({ success: true, data: { items } });
    } catch (error) {
        sendInternalError(res, error, { action: "import", platform: platform.data });
    }
};

async function importOne(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    name: string,
    raw: unknown,
    verify: boolean,
    actor: TSessionActor,
): Promise<ISessionImportItem> {
    const fail = (error: string, accountId: string | null = null): ISessionImportItem => ({
        name, account_id: accountId, ok: false, error, session: null,
    });

    const parsedState = StorageStateSchema.safeParse(raw);
    if (!parsedState.success) return fail("Файл не похож на Playwright storageState (cookies и origins)");
    const state = parsedState.data as TStorageState;

    const problem = findStorageStateProblem(platform, state);
    if (problem) return fail(problem);

    const accountId = deriveAccountId(platform, name, state);
    if (!accountId) {
        return fail(platform === ENUM_SESSION_PLATFORM.TELEGRAM
            ? "Нет telegram_user_id в user_auth"
            : `Аккаунт не определить по имени: назовите файл ${platform}_<логин>.json`);
    }

    if (verify) {
        const check = await screenshotService.checkSession(platform, state);
        if (!check.ok) return fail(checkFailure(check), accountId);
    }

    const session = sessionsService.upsert(platform, accountId, state, {
        verified: verify,
        source: ENUM_SESSION_EVENT.UPLOAD,
        actor,
    });
    return { name, account_id: accountId, ok: true, error: null, session };
}
