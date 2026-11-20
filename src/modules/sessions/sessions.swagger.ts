import { z } from "zod";
import {
  CheckAllQuerySchema,
  DeleteSessionQuerySchema,
  DeleteSessionResponseSchema,
  ImportSessionsResponseSchema,
  ImportSessionsSchema,
  ListSessionsQuerySchema,
  LoginCodeSchema,
  LoginParamsSchema,
  LoginPasswordSchema,
  LoginResponseSchema,
  LoginStartSchema,
  ReloginSchema,
  SessionEventResponseSchema,
  SessionEventsQuerySchema,
  SessionParamsSchema,
  SessionResponseSchema,
  SessionSummaryResponseSchema,
  TestScreenshotSchema,
  UpdateSessionSchema,
  UpsertSessionSchema,
} from "./dto";
import { ROUTES_SESSIONS } from "./sessions.routes";

const TAGS = ['Сессии'];
/** Почта админа для истории (C4): бэк передаёт её во всех изменяющих запросах */
const ADMIN_HEADER = z.object({ 'x-admin-email': z.string().optional().openapi({ description: 'Кто действует — попадает в историю сессии' }) });
const ITEM_PATH = `${ROUTES_SESSIONS.BASE}/{platform}/{accountId}`;

const jsonContent = (schema: unknown) => ({ content: { 'application/json': { schema } } });

const SessionErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    code: { type: 'number', enum: [1008, 1009, 1010, 1011, 1012, 1013], example: 1008 },
    message: {
      type: 'string',
      enum: ['SESSION_NOT_FOUND', 'SESSION_EXPIRED', 'SESSION_INVALID_STATE', 'SESSION_NOT_LOGGED_IN', 'SESSION_INTERNAL_ERROR', 'SESSION_ALREADY_EXISTS'],
      example: 'SESSION_NOT_FOUND',
    },
    detail: { type: 'string', nullable: true },
  },
  required: ['success', 'code', 'message'],
};

const LoginErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    code: { type: 'number', enum: [1008, 1014, 1015, 1016, 1017, 1018], example: 1016 },
    message: { type: 'string', enum: ['SESSION_NOT_FOUND', 'LOGIN_NOT_FOUND', 'LOGIN_WRONG_STEP', 'LOGIN_REJECTED', 'LOGIN_FAILED', 'LOGIN_ACCOUNT_MISMATCH'] },
    detail: { type: 'string', nullable: true, example: 'Invalid code' },
    detail_image: { type: 'string', description: 'Скриншот страницы входа, jpeg base64' },
  },
  required: ['success', 'code', 'message'],
};

const ValidationErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    code: { type: 'number', example: 1001 },
    message: { type: 'string', example: 'VALIDATION_ERROR' },
    errors: { type: 'object' },
  },
};

const SessionDataResponse = jsonContent(z.object({ success: z.literal(true), data: SessionResponseSchema }));

const NOT_FOUND = { 404: { description: 'Сессия не найдена (1008)', ...jsonContent(SessionErrorSchema) } };
const VALIDATION = { 422: { description: 'Ошибка валидации (1001) или сессии (1010, 1011)', ...jsonContent(ValidationErrorSchema) } };

export const ListSessionsSwagger = {
  method: 'get',
  path: ROUTES_SESSIONS.BASE,
  summary: 'Список сессий',
  description: 'Метаданные сессий; storage_state никогда не отдаётся',
  tags: TAGS,
  request: { query: ListSessionsQuerySchema },
  responses: {
    200: {
      description: 'Список сессий',
      ...jsonContent(z.object({ success: z.literal(true), data: z.array(SessionResponseSchema) })),
    },
  },
};

export const UpsertSessionSwagger = {
  method: 'put',
  path: ITEM_PATH,
  summary: 'Загрузить или заменить сессию',
  description: 'Статическая проверка, затем (verify=true) проверка входа в headless-браузере, затем сохранение. Пулы подхватывают новую сессию без рестарта',
  tags: TAGS,
  request: { params: SessionParamsSchema, body: jsonContent(UpsertSessionSchema) },
  responses: { 200: { description: 'Сессия сохранена', ...SessionDataResponse }, ...VALIDATION },
};

export const UpdateSessionSwagger = {
  method: 'patch',
  path: ITEM_PATH,
  summary: 'Точечно изменить аккаунт без перезаливки сессии',
  description: 'account_id, подпись, телефон, @username, статус, сессия по умолчанию. Поле без значения не меняется, null — очищается. 409 (1013) — у платформы уже есть сессия с новым account_id',
  tags: TAGS,
  request: { params: SessionParamsSchema, body: jsonContent(UpdateSessionSchema) },
  responses: {
    200: { description: 'Сессия обновлена', ...SessionDataResponse },
    409: { description: 'account_id уже занят (1013)', ...jsonContent(SessionErrorSchema) },
    ...NOT_FOUND,
    ...VALIDATION,
  },
};

export const CheckSessionSwagger = {
  method: 'post',
  path: `${ITEM_PATH}/check`,
  summary: 'Проверить сессию',
  description: 'Живая проверка входа; результат — в status (active/expired) и last_error',
  tags: TAGS,
  request: { params: SessionParamsSchema },
  responses: { 200: { description: 'Результат проверки', ...SessionDataResponse }, ...NOT_FOUND },
};

export const DeleteSessionSwagger = {
  method: 'delete',
  path: ITEM_PATH,
  summary: 'Удалить сессию',
  description: 'Пул сессии утилизируется, активные вкладки дорабатывают. logout=true — сначала выйти из аккаунта; при ошибке выхода сессия всё равно удаляется, причина — в data.logout.error',
  tags: TAGS,
  request: { params: SessionParamsSchema, query: DeleteSessionQuerySchema, headers: ADMIN_HEADER },
  responses: {
    200: { description: 'Сессия удалена', ...jsonContent(z.object({ success: z.literal(true), data: DeleteSessionResponseSchema })) },
    ...NOT_FOUND,
  },
};

const LOGIN_PATH = `${ROUTES_SESSIONS.BASE}/login/{loginId}`;
const LoginDataResponse = jsonContent(z.object({ success: z.literal(true), data: LoginResponseSchema }));
const LOGIN_ERRORS = {
  404: { description: 'Вход не найден или истёк (1014)', ...jsonContent(LoginErrorSchema) },
  409: { description: 'Вход на другом шаге или занят (1015)', ...jsonContent(LoginErrorSchema) },
  422: { description: 'Платформа отклонила ввод (1016, вход открыт) или вход завершился в чужом аккаунте (1018, вход закрыт): detail — текст, detail_image — скриншот страницы', ...jsonContent(LoginErrorSchema) },
  502: { description: 'Страница входа не ответила или повела себя неожиданно (1017), detail_image — скриншот', ...jsonContent(LoginErrorSchema) },
};

export const SessionsSummarySwagger = {
  method: 'get',
  path: `${ROUTES_SESSIONS.BASE}/summary`,
  summary: 'Сводка по сессиям',
  description: 'Статусы по платформам, сессия по умолчанию, время последней плановой проверки, сколько входов открыто',
  tags: TAGS,
  responses: {
    200: { description: 'Сводка', ...jsonContent(z.object({ success: z.literal(true), data: SessionSummaryResponseSchema })) },
  },
};

export const CheckAllSessionsSwagger = {
  method: 'post',
  path: `${ROUTES_SESSIONS.BASE}/check-all`,
  summary: 'Проверить все активные сессии',
  description: 'Живая проверка по очереди (до ~30 с на сессию). Протухшие становятся expired, сессия по умолчанию переезжает. Повторный вызов во время проверки ждёт текущую',
  tags: TAGS,
  request: { query: CheckAllQuerySchema },
  responses: {
    200: {
      description: 'Итог проверки',
      ...jsonContent(z.object({
        success: z.literal(true),
        data: z.object({
          checked: z.number(), active: z.number(), expired: z.number(),
          items: z.array(z.object({ platform: z.string(), account_id: z.string(), ok: z.boolean(), error: z.string().nullable() })),
        }),
      })),
    },
  },
};

export const TestScreenshotSwagger = {
  method: 'post',
  path: `${ITEM_PATH}/test-screenshot`,
  summary: 'Тестовый скриншот под сессией',
  description: 'Скриншот поста под этой сессией без загрузки в Blogix и без счётчиков; работает и для выключенной сессии',
  tags: TAGS,
  request: { params: SessionParamsSchema, body: jsonContent(TestScreenshotSchema) },
  responses: {
    200: { description: 'jpeg base64', ...jsonContent(z.object({ success: z.literal(true), data: z.object({ image: z.string() }) })) },
    502: { description: 'Скриншот не получился (1004), detail — причина', ...jsonContent(SessionErrorSchema) },
    ...NOT_FOUND,
    ...VALIDATION,
  },
};

export const StartLoginSwagger = {
  method: 'post',
  path: `${ROUTES_SESSIONS.BASE}/{platform}/login`,
  summary: 'Войти в аккаунт в headless-браузере',
  description: 'Telegram: phone → код (→ пароль 2FA) или method=qr → опрос GET /login/{loginId}, пока QR не отсканируют. Instagram: username + password (→ код). YouTube не поддерживается — только загрузка файла. После step=done сессия сохранена, телефон записан в неё',
  tags: TAGS,
  request: { params: z.object({ platform: SessionParamsSchema.shape.platform }), body: jsonContent(LoginStartSchema) },
  responses: { 200: { description: 'Шаг входа', ...LoginDataResponse }, ...LOGIN_ERRORS },
};

export const ReloginSwagger = {
  method: 'post',
  path: `${ITEM_PATH}/relogin`,
  summary: 'Перелогинить сессию',
  description: 'Вход с телефоном или логином этой сессии; войти нужно в тот же аккаунт, иначе сессия не заменится. Instagram — нужен пароль',
  tags: TAGS,
  request: { params: SessionParamsSchema, body: jsonContent(ReloginSchema) },
  responses: { 200: { description: 'Шаг входа', ...LoginDataResponse }, ...NOT_FOUND, ...LOGIN_ERRORS },
};

export const LoginCodeSwagger = {
  method: 'post',
  path: `${LOGIN_PATH}/code`,
  summary: 'Ввести код входа',
  description: 'Неверный код (1016) оставляет вход открытым — можно ввести снова',
  tags: TAGS,
  request: { params: LoginParamsSchema, body: jsonContent(LoginCodeSchema) },
  responses: { 200: { description: 'Шаг входа', ...LoginDataResponse }, ...LOGIN_ERRORS },
};

export const LoginPasswordSwagger = {
  method: 'post',
  path: `${LOGIN_PATH}/password`,
  summary: 'Ввести пароль 2FA (Telegram)',
  tags: TAGS,
  request: { params: LoginParamsSchema, body: jsonContent(LoginPasswordSchema) },
  responses: { 200: { description: 'Шаг входа', ...LoginDataResponse }, ...LOGIN_ERRORS },
};

export const LoginResendSwagger = {
  method: 'post',
  path: `${LOGIN_PATH}/resend`,
  summary: 'Отправить код ещё раз',
  description: 'Доступно, когда платформа показывает такую возможность (у Telegram — после таймера)',
  tags: TAGS,
  request: { params: LoginParamsSchema },
  responses: { 200: { description: 'Шаг остаётся code', ...LoginDataResponse }, ...LOGIN_ERRORS },
};

export const CancelLoginSwagger = {
  method: 'delete',
  path: LOGIN_PATH,
  summary: 'Отменить вход',
  description: 'Закрывает браузер входа. Брошенный вход закрывается сам через 10 минут',
  tags: TAGS,
  request: { params: LoginParamsSchema },
  responses: { 200: { description: 'Отменён', ...jsonContent(z.object({ success: z.literal(true) })) }, ...LOGIN_ERRORS },
};

export const PollLoginSwagger = {
  method: 'get',
  path: LOGIN_PATH,
  summary: 'Опросить вход по QR',
  description: 'Шаг qr: QR ещё не отсканирован, в qr_image — свежий (Telegram обновляет его ~раз в 30 с). Дальше — password (2FA) или done',
  tags: TAGS,
  request: { params: LoginParamsSchema },
  responses: { 200: { description: 'Шаг входа', ...LoginDataResponse }, ...LOGIN_ERRORS },
};

export const SessionEventsSwagger = {
  method: 'get',
  path: `${ITEM_PATH}/events`,
  summary: 'История сессии',
  description: 'Загрузки, входы, правки, протухание, смена сессии по умолчанию, удаление. Свежие сверху; история удалённой сессии сохраняется',
  tags: TAGS,
  request: { params: SessionParamsSchema, query: SessionEventsQuerySchema },
  responses: {
    200: { description: 'События', ...jsonContent(z.object({ success: z.literal(true), data: z.array(SessionEventResponseSchema) })) },
  },
};

export const ImportSessionsSwagger = {
  method: 'post',
  path: `${ROUTES_SESSIONS.BASE}/{platform}/import`,
  summary: 'Загрузить несколько файлов сессий',
  description: 'До 10 файлов одной платформы. account_id: Telegram — из user_auth в файле, Instagram/YouTube — из имени <platform>_<account>.json. Итог по каждому файлу, ошибка одного не мешает остальным',
  tags: TAGS,
  request: {
    params: z.object({ platform: SessionParamsSchema.shape.platform }),
    headers: ADMIN_HEADER,
    body: jsonContent(ImportSessionsSchema),
  },
  responses: {
    200: { description: 'Итоги по файлам', ...jsonContent(z.object({ success: z.literal(true), data: ImportSessionsResponseSchema })) },
    ...VALIDATION,
  },
};

export const SESSIONS_SWAGGER_ROUTES = [
  PollLoginSwagger,
  SessionEventsSwagger,
  ImportSessionsSwagger,
  SessionsSummarySwagger,
  ListSessionsSwagger,
  UpsertSessionSwagger,
  UpdateSessionSwagger,
  CheckSessionSwagger,
  CheckAllSessionsSwagger,
  TestScreenshotSwagger,
  DeleteSessionSwagger,
  StartLoginSwagger,
  ReloginSwagger,
  LoginCodeSwagger,
  LoginPasswordSwagger,
  LoginResendSwagger,
  CancelLoginSwagger,
];
