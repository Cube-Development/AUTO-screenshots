import rateLimit from "express-rate-limit";
import { SETTINGS } from "../../config";

export const screenshotLimiter = rateLimit({
  windowMs: 1000,
  max: SETTINGS.MAX_SCREENSHOT_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    message: `Слишком много запросов на скриншоты. Макс. ${SETTINGS.MAX_SCREENSHOT_LIMIT} RPS.`,
  },
});
