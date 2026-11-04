import axios from "axios";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { SETTINGS } from "../config";
import { log } from "../utils";

/** Формат файла, который уходит в хранилище и в TG */
export const SCREENSHOT_EXTENSION = "jpg";
export const SCREENSHOT_MIME = "image/jpeg";

/**
 * Перекодирует PNG от Playwright в JPEG (~-60% веса).
 * mozjpeg q92 + 4:4:4 (без субдискретизации цвета) — текст и цветные элементы
 * остаются чёткими, визуально неотличимо от PNG. Нативный JPEG Playwright
 * использует 4:2:0 и мылит цветной текст, поэтому кодируем через sharp.
 */
export async function compressScreenshot(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export const TEST_SCREENS_DIR = path.join("src", "tests", "screenshots", "screens");

if (SETTINGS.TEST_SCREENSHOTS && !fs.existsSync(TEST_SCREENS_DIR)) {
  fs.mkdirSync(TEST_SCREENS_DIR, { recursive: true });
}

/** Форматирует дату в СНГ стандарт: ДД.ММ.ГГГГ_ЧЧ-ММ-СС */
export function getCISDateString(): string {
    const now = new Date();
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${d}.${m}.${y}_${h}-${min}-${s}`;
}

export async function uploadScreenshot(url: string, bytes: Buffer, signal?: AbortSignal) {
  try {
    await axios.put(url, bytes, {
      headers: { "Content-Type": SCREENSHOT_MIME },
      signal: signal,
    });
  } catch (error: any) {
    if (axios.isCancel(error)) throw new Error("ABORTED_BY_CLIENT");
    const details = error.response?.data?.message || error.message;
    log.error(`❌ Screenshot upload failed: ${details}`);
    throw new Error(`UPLOAD_LINK_FAILED: ${details}`);
  }
}
