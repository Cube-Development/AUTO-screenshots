import express from "express";
import { validateApiKey } from "../../middleware/auth";
import {
    cancelLogin,
    checkAllSessions,
    checkSession,
    deleteSession,
    importSessions,
    listSessions,
    pollLogin,
    reloginSession,
    resendLoginCode,
    sessionEvents,
    sessionsSummary,
    startLogin,
    submitLoginCode,
    submitLoginPassword,
    testScreenshot,
    updateSession,
    upsertSession,
} from "./sessions.controller";
import { ROUTES_SESSIONS, SESSIONS_BODY_LIMIT, SESSIONS_IMPORT_BODY_LIMIT } from "./sessions.routes";

const router = express.Router();
router.use(validateApiKey);
// Пакетная загрузка — до общего парсера: express.json не разбирает тело второй раз
router.post(ROUTES_SESSIONS.IMPORT, express.json({ limit: SESSIONS_IMPORT_BODY_LIMIT }), importSessions);
router.use(express.json({ limit: SESSIONS_BODY_LIMIT }));

// Сводка и массовая проверка
router.get(ROUTES_SESSIONS.SUMMARY, sessionsSummary);
router.post(ROUTES_SESSIONS.CHECK_ALL, checkAllSessions);

// Вход в headless-браузере — до ITEM: пути /login/:id иначе совпадут с /:platform/:accountId
router.post(ROUTES_SESSIONS.LOGIN_START, startLogin);
router.post(ROUTES_SESSIONS.LOGIN_CODE, submitLoginCode);
router.post(ROUTES_SESSIONS.LOGIN_PASSWORD, submitLoginPassword);
router.post(ROUTES_SESSIONS.LOGIN_RESEND, resendLoginCode);
router.get(ROUTES_SESSIONS.LOGIN_POLL, pollLogin);
router.delete(ROUTES_SESSIONS.LOGIN_CANCEL, cancelLogin);

// Сессия: загрузка файла, правка, проверка, перелогин, тестовый скриншот
router.get(ROUTES_SESSIONS.LIST, listSessions);
router.put(ROUTES_SESSIONS.ITEM, upsertSession);
router.patch(ROUTES_SESSIONS.ITEM, updateSession);
router.delete(ROUTES_SESSIONS.ITEM, deleteSession);
router.post(ROUTES_SESSIONS.CHECK, checkSession);
router.post(ROUTES_SESSIONS.RELOGIN, reloginSession);
router.post(ROUTES_SESSIONS.TEST_SCREENSHOT, testScreenshot);
router.get(ROUTES_SESSIONS.EVENTS, sessionEvents);

export const sessionsRouter = router;
