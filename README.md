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
