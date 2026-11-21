# Auto Screenshots Server

Автоматизированный сервер для снятия скриншотов с веб-страниц с поддержкой REST API.

## Описание

Auto Screenshots Server предоставляет HTTP API для автоматизации процесса снятия скриншотов с веб-страниц.

## Особенности

- ✅ REST API с автоматической документацией Swagger
- 📋 TypeScript поддержка
- 🔄 Автоматическое обновление при разработке
- ⚡ Express.js сервер

## Требования

- **Node.js** 18+
- **Google Chrome** на сервере (один раз, нужен root): `sudo npx playwright install --with-deps chrome`. В Chromium из Playwright нет H.264: видео рилсов, сторис и YouTube не играет. Без Chrome сервис сам откатится на Chromium

## Установка

```bash
# Клонируйте репозиторий
git clone https://github.com/Cube-Development/AUTO-screenshots.git
cd AUTO-screenshots

# Установите зависимости
npm install

# Скопируйте файл окружения
cp .env.example .env
```

## Переменные окружения

Создайте файл `.env` в корне проекта:

```env

BLOGIX_API_URL=
SERVER_API_KEY=
BLOGIX_API_KEY=

TEST_SCREENSHOTS=
MAX_SCREENSHOT_LIMIT=
PORT=

SEND_TO_TELEGRAM=
TG_BOT_TOKEN=
TG_CHAT_ID=
TG_TOPIC_ID=

SESSIONS_DB_PATH=
SESSIONS_ENC_KEY=
LEGACY_AUTH_DIR=
```

### Описание переменных

| Переменная | Описание | Обязательная |
|------------|----------|--------------|
| `BLOGIX_API_URL` | Base URL для Blogix API | ✅ |
| `SERVER_API_KEY` | API ключ для аутентификации | ✅ |
| `BLOGIX_API_KEY` | API ключ для аутентификации | ✅ |
| `TEST_SCREENSHOTS` | Флаг для сохраниния скриншотов | ❌ |
| `MAX_SCREENSHOT_LIMIT` | Максимальное количество скриншотов | ❌ |
| `PORT` | Порт сервера | ❌ |
| `SEND_TO_TELEGRAM` | Включить отправку копии скриншотов в ТГ | ❌ |
| `TG_BOT_TOKEN` | Токен бота для уведомлений | ❌ |
| `TG_CHAT_ID` | ID чата, куда присылать скриншоты | ❌ |
| `TG_TOPIC_ID` | ID топика, куда присылать скриншоты | ❌ |
| `SESSIONS_DB_PATH` | Путь к SQLite с сессиями (по умолчанию `./data/sessions.db`, на проде — вне папки репо) | ❌ |
| `SESSIONS_ENC_KEY` | Ключ шифрования сессий, 32 байта в base64 (`openssl rand -base64 32`) | ✅ |
| `SESSIONS_CHECK_HOUR` | Час ежедневного бэкапа и проверки сессий по Ташкенту (по умолчанию 4) | ❌ |
| `SESSIONS_BACKUP_DIR` | Папка ежедневных бэкапов базы (по умолчанию `./data/backups`) | ❌ |
| `SESSIONS_BACKUP_KEEP` | Сколько последних бэкапов хранить (по умолчанию 7) | ❌ |
| `SESSIONS_SEED_PATH` | Стартовая копия базы для первого запуска (по умолчанию `./seed/sessions.db`) | ❌ |
| `LEGACY_AUTH_DIR` | Папка со старыми `auth.json` для разового импорта в пустую базу. Не задано — импорта нет | ❌ |

## Instagram: пост, рилс, сторис

- Пост и рилс: `/p/<code>/`, `/reel/<code>/` (рилс открывается как пост), в т.ч. новый вид `/<user>/p/<code>/`.
- Сторис: `/stories/<user>/<id>/` (ссылка «Поделиться») или `/stories/<user>/` — текущая сторис. Сервис подтверждает «View as …?» (аккаунт сессии попадает в зрители), ставит сторис на паузу и снимает карточку с автором и временем.
- Ошибки сторис (`SCREENSHOT_FAILED: …`): `STORY_EXPIRED` — сторис с этим id уже нет (Instagram подменил бы её текущей, поэтому id сверяется), `STORY_NOT_AVAILABLE` — у аккаунта нет активных сторис, `STORY_NOT_FOUND` — аккаунта нет, `PRIVATE_ACCOUNT_INSTAGRAM` — закрытый аккаунт.

## Сессии

Сессии платформ (Playwright `storageState`) хранятся зашифрованными в SQLite и управляются через API `/sessions` (тот же ключ `SERVER_API_KEY`, что и для скриншотов). Бэк проксирует его в админку, напрямую сервис наружу не открывается.

- **Telegram:** `accountId` — `telegram_user_id` юзербота (бэк передаёт его как `user_bot_id`).
- **Instagram/YouTube:** `accountId` — логин или метка. Берётся сессия по умолчанию, иначе любая активная.
- **Нет сессии:** скриншот сразу возвращает `1008 SESSION_NOT_FOUND`. Протухшая сессия получает статус `expired`, скриншот возвращает `1009 SESSION_EXPIRED`, а в TG-чат уходит уведомление.
- **Стартовая копия:** `seed/sessions.db` лежит в репо. Если базы по `SESSIONS_DB_PATH` ещё нет (первый деплой), сервис копирует её оттуда; дальше работает только со своей базой и seed не трогает. Сессии в seed зашифрованы `SESSIONS_ENC_KEY` — без того же ключа они не расшифруются.
- **Старые папки:** если задан `LEGACY_AUTH_DIR`, папка импортируется один раз за жизнь базы (флаг в таблице `meta`), существующие записи не перезаписываются. При переносе готовой `sessions.db` переменная не нужна.
- **Данные аккаунта:** у сессии есть `phone` и `username` (всегда с `@`). `PATCH /sessions/:platform/:accountId` меняет их, подпись, статус и сам `account_id` без перезаливки сессии; поле без значения не меняется, `null` очищает.

Получить новую сессию можно двумя способами. Оба идут через админку и бэк, напрямую в сервис никто не ходит.

**1. Вход в headless-браузере сервиса** (Telegram и Instagram):

| Шаг | Ручка |
|---|---|
| Старт | `POST /sessions/:platform/login`. Telegram: `{phone}`, Instagram: `{username, password}`, плюс `label?` и `expected_account_id?` |
| Код | `POST /sessions/login/:loginId/code {code}` |
| Пароль 2FA (Telegram) | `POST /sessions/login/:loginId/password {password}` |
| Отправить код ещё раз | `POST /sessions/login/:loginId/resend` |
| Отменить | `DELETE /sessions/login/:loginId`. Брошенный вход закрывается сам через 10 минут |
| Перелогин сессии | `POST /sessions/:platform/:accountId/relogin`: телефон или логин берутся из неё, войти нужно в тот же аккаунт |

После `step: done` сессия уже сохранена в базу вместе с телефоном.
- Неверный код или пароль возвращают `1016`, вход остаётся открытым.
- Если шаг упал, в ответе есть `detail_image` — скриншот страницы входа.
- YouTube через браузер не входит: Google блокирует автоматический вход.

**2. Загрузка файла.** Файл снимается локально (нужен браузер с интерфейсом):

```bash
npm run auth:telegram                    # telegram_user_id определяется сам
npm run auth:instagram -- <username>
npm run auth:youtube -- <login>
```

Файл появится в `sessions-export/`. Загрузите его в админке и удалите локально.

**Ещё ручки:**
- `GET /sessions/summary` — сводка по платформам;
- `POST /sessions/check-all?platform=` — живая проверка всех активных сессий;
- `POST /sessions/:platform/:accountId/test-screenshot {post_url}` — скриншот поста под этой сессией без загрузки в Blogix.
- `POST /sessions/:platform/import {files, verify}` — до 10 файлов сразу: Telegram-аккаунт берётся из `user_auth` в файле, Instagram/YouTube — из имени `<platform>_<account>.json`;
- `DELETE /sessions/:platform/:accountId?logout=true` — сначала выйти из аккаунта (Telegram: Настройки → Выйти), затем удалить; при ошибке выхода сессия всё равно удаляется;
- `POST /sessions/telegram/login {method: "qr"}` → `GET /sessions/login/:loginId` раз в несколько секунд, пока QR не отсканируют (в ответе `qr_image`, png base64);
- `GET /sessions/:platform/:accountId/events` — история: загрузки, входы, правки, протухание, смена сессии по умолчанию, удаление. Кто действовал — из заголовка `X-Admin-Email` (его передаёт бэк).

**Автоматика:**
- раз в сутки (`SESSIONS_CHECK_HOUR`, по умолчанию 4:00 по Ташкенту) проверяются все активные сессии, протухшие уходят списком в TG;
- протухшая, выключенная или удалённая сессия по умолчанию сама заменяется самой старой активной;
- перед проверкой там же делается бэкап базы в `SESSIONS_BACKUP_DIR` (`sessions-YYYYMMDD.db`, хранятся последние `SESSIONS_BACKUP_KEEP`);
- скриншоты Instagram и YouTube идут по кругу по всем активным сессиям платформы (Telegram — под сессией юзербота или по умолчанию);
- у сессий есть счётчики `success_count` и `fail_count`.

**`npm run seed:update`** обновляет `seed/sessions.db` из рабочей базы (работает и при запущенном сервисе).

**Тесты:** `npm test` — node:test через tsx, без сети и без .env: у каждого файла своя временная база, Telegram-уведомления выключены (`test/setup-env.ts`). `npm run test:types` проверяет типы тестов.

| Код | message | Когда |
|-----|---------|-------|
| 1008 | `SESSION_NOT_FOUND` | Нет сессии или нет активной сессии платформы |
| 1009 | `SESSION_EXPIRED` | Сессия разлогинена (обнаружено при скриншоте) |
| 1010 | `SESSION_INVALID_STATE` | Файл не похож на `storageState` или в нём нет авторизации |
| 1011 | `SESSION_NOT_LOGGED_IN` | Живая проверка при загрузке не нашла вход |
| 1012 | `SESSION_INTERNAL_ERROR` | Внутренняя ошибка API сессий |
| 1013 | `SESSION_ALREADY_EXISTS` | Смена `account_id`: у платформы уже есть сессия с таким аккаунтом (409) |
| 1014 | `LOGIN_NOT_FOUND` | Вход не найден или истёк (404) |
| 1015 | `LOGIN_WRONG_STEP` | Вход на другом шаге или ещё выполняет предыдущий (409) |
| 1016 | `LOGIN_REJECTED` | Платформа отклонила телефон, код или пароль; вошли не в `expected_account_id` (422) |
| 1017 | `LOGIN_FAILED` | Страница входа не ответила или повела себя неожиданно (502) |
| 1018 | `LOGIN_ACCOUNT_MISMATCH` | Вход выполнен не в ожидаемый аккаунт (перелогин, юзербот): сессия не сохранена, вход закрыт (422) |

## Команды

```bash
# Разработка с hot-reload
npm run dev

# Сборка проекта
npm run build

# Продакшен запуск
npm start

# Очистка build директории
npm run clean
```

## API Документация

После запуска сервера документация Swagger доступна по адресу:
```
http://localhost:PORT/api/docs
```
