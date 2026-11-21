import { Page } from "playwright";
import { SessionError } from "../../type";
import { ENUM_LOGIN_STEP_TYPE } from "./login.types";

export const LOGIN_STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 400;

/** Проверка состояния страницы: шаг, ошибка платформы (текст) или null — ждём дальше */
export type TLoginProbe = (page: Page) => Promise<ENUM_LOGIN_STEP_TYPE | { error: string } | null>;

/** Опрашивает страницу до результата шага; ошибка платформы — LOGIN_REJECTED, тишина — LOGIN_FAILED */
/**
 * diagnose — что платформа считает признаками входа на странице: попадает в ошибку, если шаг не распознан,
 * чтобы по одной ошибке было видно, какой признак не сработал
 */
export async function waitForLoginOutcome(
  page: Page,
  probe: TLoginProbe,
  stage: string,
  diagnose?: (page: Page) => Promise<string>,
): Promise<ENUM_LOGIN_STEP_TYPE> {
  const deadline = Date.now() + LOGIN_STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await probe(page).catch(() => null);
    if (typeof result === "string") return result;
    if (result) throw new SessionError("LOGIN_REJECTED", result.error);
    await page.waitForTimeout(POLL_MS);
  }
  const inputs = await describeInputs(page);
  const markers = diagnose ? await diagnose(page).catch(() => "") : "";
  throw new SessionError(
    "LOGIN_FAILED",
    `Нет результата шага «${stage}» за ${LOGIN_STEP_TIMEOUT_MS / 1000}с (${page.url()})` +
      (inputs ? `; поля на странице: ${inputs}` : "") +
      (markers ? `; признаки входа: ${markers}` : ""),
  );
}

/**
 * Видимые поля ввода кратко: «input[inputmode=numeric,maxlength=1]×5». Когда платформа меняет вёрстку
 * и шаг не распознан, по этому сразу видно, какой селектор нужен — без доступа к живому аккаунту
 */
async function describeInputs(page: Page): Promise<string> {
  const fields = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input, [contenteditable='true']"))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const attrs = ["type", "inputmode", "maxlength", "autocomplete"]
            .map((name) => (el.getAttribute(name) ? `${name}=${el.getAttribute(name)}` : ""))
            .filter(Boolean)
            .join(",");
          return `${el.tagName.toLowerCase()}${attrs ? `[${attrs}]` : ""}`;
        }),
    )
    .catch(() => [] as string[]);
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(field, (counts.get(field) ?? 0) + 1);
  return [...counts].map(([field, count]) => (count > 1 ? `${field}×${count}` : field)).join(", ");
}

/** Жмёт первую видимую кнопку/ссылку с подходящим текстом; false — такой нет */
export async function clickByText(page: Page, text: RegExp): Promise<boolean> {
  const target = page.locator("button, a, [role='button'], .btn, span").filter({ hasText: text }).first();
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click({ timeout: 5_000 });
  return true;
}

export const isVisible = (page: Page, selector: string) =>
  page.locator(selector).first().isVisible().catch(() => false);

export const visibleText = async (page: Page, selector: string): Promise<string | null> => {
  const locator = page.locator(selector).first();
  if (!(await locator.isVisible().catch(() => false))) return null;
  // Элемент мог пропасть после isVisible: без timeout innerText ждал бы его появления до 30 с
  const text = (await locator.innerText({ timeout: 1_000 }).catch(() => "")).trim();
  return text || null;
};
