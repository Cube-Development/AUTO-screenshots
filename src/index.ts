import 'dotenv/config';

import bodyParser from "body-parser";
import express from "express";
import swaggerUi from "swagger-ui-express";
import { SETTINGS } from './config';
import { ROUTES_SCREENSHOT, postScreenshotRouter, screenshotLimiter } from "./modules/post-screenshot";
import { screenshotService } from './services';
import { log } from './utils';
import { openApiDocument } from './utils/swagger';

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Инициализация браузера и сессий при старте
screenshotService.init().catch((err: any) => log.error(`Ошибка прогрева браузера: ${err}`));

// Подключаем Swagger UI
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.get("/", (req, res) => {
  res.send("SERVER IS STARTED");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.use(ROUTES_SCREENSHOT.BASE, screenshotLimiter, postScreenshotRouter);

const server = app.listen(SETTINGS.PORT, "0.0.0.0", () => {
  log.info(`Server is running on port ${SETTINGS.PORT}`);
});

const gracefulShutdown = async (signal: string) => {
  log.warn(`Получен сигнал ${signal}. Останавливаем сервер...`);

  // Перестаём принимать новые соединения
  server.close(() => {
    log.info("HTTP сервер закрыт (новые запросы не принимаются)");
  });

  // Закрываем shared Chromium
  await screenshotService.close();

  log.success("Сервер остановлен ✅");
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));

process.on('exit', () => {
});