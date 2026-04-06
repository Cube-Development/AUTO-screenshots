import axios from "axios";
import FormData from "form-data";
import { SETTINGS } from "../config";
import { log } from "../utils";

/**
 * Fire-and-forget отправка скриншота в Telegram бот.
 * Сначала пробует sendPhoto, при ошибке — sendDocument.
 * Не блокирует основной pipeline и не бросает ошибки наружу.
 */
export async function notifyTelegram(
  screenshot: Buffer,
  sourceUrl: string,
  fileName: string
): Promise<void> {
  const token = SETTINGS.TG_BOT_TOKEN;
  const chatId = SETTINGS.TG_CHAT_ID;
  const topicId = SETTINGS.TG_TOPIC_ID;

  if (!token || !chatId) return;

  const caption = `<u>Скриншот</u>\nСсылка на пост: ${sourceUrl}\nИмя файла: <code>${fileName}</code>`;

  const baseUrl = `https://api.telegram.org/bot${token}`;

  try {
    // Попытка 1: sendPhoto
    await sendTelegramFile(baseUrl, "sendPhoto", "photo", chatId, screenshot, fileName, caption, topicId);
    log.info(`📩 Скриншот отправлен в TG бот (photo) | ${sourceUrl}`);
  } catch (photoError: any) {
    const photoMsg = photoError.response?.data?.description || photoError.message;
    log.warn(`⚠️ sendPhoto не удался: ${photoMsg}. Пробую sendDocument...`);

    try {
      // Попытка 2: sendDocument
      await sendTelegramFile(baseUrl, "sendDocument", "document", chatId, screenshot, fileName, caption, topicId);
      log.info(`📩 Скриншот отправлен в TG бот (document) | ${sourceUrl}`);
    } catch (docError: any) {
      const docMsg = docError.response?.data?.description || docError.message;
      log.warn(`⚠️ Не удалось отправить в TG бот: ${docMsg}`);
    }
  }
}

async function sendTelegramFile(
  baseUrl: string,
  method: string,
  fieldName: string,
  chatId: string,
  buffer: Buffer,
  fileName: string,
  caption: string,
  topicId?: string,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (topicId) form.append("message_thread_id", topicId);
  form.append(fieldName, buffer, { filename: fileName, contentType: "image/png" });
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  await axios.post(`${baseUrl}/${method}`, form, {
    headers: form.getHeaders(),
    timeout: 10000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}
