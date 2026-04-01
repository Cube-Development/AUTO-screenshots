import axios from "axios";
import fs from "fs";
import path from "path";
import { SETTINGS } from "../config";

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

export async function uploadScreenshot(url: string, bytes: Buffer) {
  await axios.put(url, bytes, {
    headers: { "Content-Type": "image/png" },
  });
}
