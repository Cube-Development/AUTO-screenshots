import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from "zod";
import { StorageStateSchema } from '../../sessions/sessions.validator';
import { ENUM_SESSION_EVENT, ENUM_SESSION_STATUS, SESSION_PLATFORMS } from '../../type';
import { ENUM_REGISTER_ROUTE } from '../../utils/swagger/register.enum';

extendZodWithOpenApi(z);

export const SessionPlatformSchema = z.enum(SESSION_PLATFORMS).openapi({
  description: "Платформа сессии",
  example: "telegram",
});

export const SessionParamsSchema = z.object({
  platform: SessionPlatformSchema,
  accountId: z.string().min(1).max(128).openapi({
    description: "Telegram: telegram_user_id юзербота (= user_bot_id). Instagram/YouTube: логин или метка",
    example: "7697061334",
  }),
});

export const ListSessionsQuerySchema = z.object({
  platform: SessionPlatformSchema.optional(),
});

const LabelSchema = z.string().trim().min(1).max(128);

/** Как у юзерботов в tg-manager: `+` и 7–15 цифр */
const PhoneSchema = z.string().trim().regex(/^\+\d{7,15}$/, "Телефон в формате +998901234567");

/** Опознаватель на платформе всегда хранится с @: «blogix_bot» превращается в «@blogix_bot» */
const UsernameSchema = z
  .string()
  .trim()
  .transform((value) => (value.startsWith("@") ? value : `@${value}`))
  .pipe(z.string().regex(/^@[A-Za-z0-9_.]{1,64}$/, "Username: латиница, цифры, _ и ., до 64 символов"));

export const UpsertSessionSchema = z.object({
  storage_state: StorageStateSchema.openapi({
    description: "Playwright storageState (содержимое auth.json)",
  }),
  label: LabelSchema.optional().openapi({
    description: "Подпись для админки",
    example: "Юзербот #3",
  }),
  phone: PhoneSchema.optional().openapi({
    description: "Телефон аккаунта; при замене сессии без поля остаётся прежний",
    example: "+998901234567",
  }),
  username: UsernameSchema.optional().openapi({
    description: "Опознаватель на платформе с @; без @ он добавится",
    example: "@blogix_bot",
  }),
  verify: z.boolean().default(true).openapi({
    description: "Проверить вход в headless-браузере перед сохранением",
  }),
}).openapi(ENUM_REGISTER_ROUTE.UPSERT_SESSION);

/** Точечная правка без перезаливки сессии: поле без значения не меняется, null — очищается */
export const UpdateSessionSchema = z.object({
  account_id: z.string().trim().min(1).max(128).optional().openapi({
    description: "Новый account_id: исправить ошибку или привязать сессию к другому юзерботу (Telegram — только цифры)",
    example: "7697061334",
  }),
  label: LabelSchema.nullable().optional().openapi({
    description: "Подпись; null — убрать",
  }),
  phone: PhoneSchema.nullable().optional().openapi({
    description: "Телефон; null — убрать",
    example: "+998901234567",
  }),
  username: UsernameSchema.nullable().optional().openapi({
    description: "Опознаватель с @; null — убрать",
    example: "@blogix_bot",
  }),
  status: z.enum([ENUM_SESSION_STATUS.ACTIVE, ENUM_SESSION_STATUS.DISABLED]).optional().openapi({
    description: "expired выставляет только сервис",
  }),
  is_default: z.boolean().optional().openapi({
    description: "Сессия по умолчанию для платформы (одна на платформу)",
  }),
})
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Нужно передать хотя бы одно поле",
  })
  .openapi(ENUM_REGISTER_ROUTE.UPDATE_SESSION);

export const SessionResponseSchema = z.object({
  platform: SessionPlatformSchema,
  account_id: z.string(),
  label: z.string().nullable(),
  phone: z.string().nullable(),
  username: z.string().nullable(),
  status: z.enum([ENUM_SESSION_STATUS.ACTIVE, ENUM_SESSION_STATUS.DISABLED, ENUM_SESSION_STATUS.EXPIRED]),
  is_default: z.boolean(),
  last_check_at: z.string().nullable(),
  last_error: z.string().nullable(),
  last_used_at: z.string().nullable(),
  success_count: z.number(),
  fail_count: z.number(),
  last_fail_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi(ENUM_REGISTER_ROUTE.SESSION);

export const SessionSummaryResponseSchema = z.object({
  platforms: z.record(z.string(), z.object({
    total: z.number(),
    active: z.number(),
    disabled: z.number(),
    expired: z.number(),
    default_account_id: z.string().nullable(),
    default_username: z.string().nullable(),
  })),
  last_check_all_at: z.string().nullable(),
  last_backup_at: z.string().nullable(),
  active_logins: z.number(),
});

export const CheckAllQuerySchema = z.object({
  platform: SessionPlatformSchema.optional(),
});

export const TestScreenshotSchema = z.object({
  post_url: z.url().openapi({
    description: "Пост той же платформы, что и сессия",
    example: "https://t.me/durov/1",
  }),
}).openapi(ENUM_REGISTER_ROUTE.TEST_SCREENSHOT);

const LoginMethodSchema = z.enum(["phone", "qr"]).default("phone").openapi({
  description: "Telegram: phone — по номеру и коду, qr — сканом QR телефоном с аккаунтом (номер не нужен)",
});

/** Telegram — phone (или method=qr); Instagram — username и password. Платформа проверяется в контроллере */
export const LoginStartSchema = z.object({
  method: LoginMethodSchema,
  phone: PhoneSchema.optional().openapi({ description: "Telegram: номер аккаунта", example: "+998901234567" }),
  username: z.string().trim().transform((value) => value.replace(/^@/, "")).pipe(z.string().regex(/^[A-Za-z0-9_.]{1,30}$/, "Логин Instagram: латиница, цифры, _ и ., до 30 символов")).optional().openapi({
    description: "Instagram: логин (с @ или без)",
    example: "blogix.ig",
  }),
  password: z.string().min(1).max(256).optional().openapi({ description: "Instagram: пароль, нигде не сохраняется" }),
  label: LabelSchema.optional(),
  expected_account_id: z.string().trim().min(1).max(128).optional().openapi({
    description: "Вход из строки юзербота: вошли не в этот аккаунт — сессия не сохраняется",
    example: "7697061334",
  }),
}).openapi(ENUM_REGISTER_ROUTE.LOGIN_START);

/** Перелогин: телефон и логин берутся из сессии; Instagram — нужен пароль */
export const ReloginSchema = z.object({
  method: LoginMethodSchema,
  phone: PhoneSchema.optional().openapi({ description: "Telegram: если у сессии нет телефона или он сменился" }),
  password: z.string().min(1).max(256).optional().openapi({ description: "Instagram: пароль" }),
}).openapi(ENUM_REGISTER_ROUTE.RELOGIN);

export const LoginParamsSchema = z.object({
  loginId: z.uuid(),
});

export const LoginCodeSchema = z.object({
  code: z.string().trim().min(1).max(64).openapi({ example: "12345" }),
}).openapi(ENUM_REGISTER_ROUTE.LOGIN_CODE);

export const LoginPasswordSchema = z.object({
  password: z.string().min(1).max(256),
}).openapi(ENUM_REGISTER_ROUTE.LOGIN_PASSWORD);

export const LoginResponseSchema = z.object({
  login_id: z.string(),
  platform: SessionPlatformSchema,
  step: z.enum(["code", "password", "qr", "done"]).openapi({
    description: "Что прислать дальше; qr — опрашивать GET /login/:loginId, пока не отсканируют; done — сессия сохранена",
  }),
  session: SessionResponseSchema.nullable(),
  qr_image: z.string().nullable().openapi({ description: "Шаг qr: текущий QR, png base64" }),
}).openapi(ENUM_REGISTER_ROUTE.LOGIN);

export const DeleteSessionQuerySchema = z.object({
  logout: z.stringbool().default(false).openapi({
    description: "Сначала выйти из аккаунта (Telegram: Настройки → Выйти), чтобы web-сессия не висела в «Устройствах»",
  }),
});

export const DeleteSessionResponseSchema = z.object({
  logout: z.object({ ok: z.boolean(), error: z.string().nullable() }).nullable().openapi({
    description: "Итог выхода; null — выход не запрашивали. При ошибке выхода сессия всё равно удалена",
  }),
});

export const SessionEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const SessionEventResponseSchema = z.object({
  id: z.number(),
  platform: SessionPlatformSchema,
  account_id: z.string(),
  action: z.enum(Object.values(ENUM_SESSION_EVENT) as [string, ...string[]]),
  actor: z.string().nullable().openapi({ description: "Почта админа (X-Admin-Email); null — сам сервис" }),
  detail: z.string().nullable(),
  created_at: z.string(),
}).openapi(ENUM_REGISTER_ROUTE.SESSION_EVENT);

/** Не больше 10 файлов: с проверкой входа каждый — до 30 секунд */
export const IMPORT_MAX_FILES = 10;

export const ImportSessionsSchema = z.object({
  files: z.array(z.object({
    name: z.string().trim().min(1).max(256).openapi({
      description: "Имя файла: для Instagram/YouTube из него берётся аккаунт — <platform>_<account>.json или <account>.json",
      example: "instagram_blogix.ig.json",
    }),
    storage_state: z.unknown().openapi({ description: "Содержимое файла (Playwright storageState)" }),
  })).min(1).max(IMPORT_MAX_FILES),
  verify: z.boolean().default(true),
}).openapi(ENUM_REGISTER_ROUTE.IMPORT_SESSIONS);

export const ImportSessionsResponseSchema = z.object({
  items: z.array(z.object({
    name: z.string(),
    account_id: z.string().nullable(),
    ok: z.boolean(),
    error: z.string().nullable(),
    session: SessionResponseSchema.nullable(),
  })),
});
