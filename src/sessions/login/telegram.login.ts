import { Page } from "playwright";
import { SessionError } from "../../type";
import { ENUM_LOGIN_STEP, ENUM_LOGIN_STEP_TYPE, ILoginAccount, ILoginDriver, ILoginStartInput } from "./login.types";
import { LOGIN_STEP_TIMEOUT_MS, TLoginProbe, clickByText, isVisible, visibleText, waitForLoginOutcome } from "./login.utils";

const WEB_K_URL = "https://web.telegram.org/k/";
const PHONE_LOGIN_BUTTON = "button.btn-primary";
/** На странице телефона поля — div[contenteditable]; input появляется только на шагах кода и пароля */
const PHONE_INPUT = '.input-field-input[inputmode="decimal"]';
const NEXT_BUTTON = "button.btn-primary.btn-color-primary";
/**
 * Поле кода: в старом Web K одно поле, в новом — клетки по цифре (CSS-модули с хешем).
 * Перечислены признаки, а не классы: autocomplete/inputmode/maxlength переживают смену вёрстки
 */
const CODE_INPUT = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[maxlength="1"]',
  'input.input-field-input:not([type="password"])',
].join(", ");
/** Экран кода узнаётся и по тексту: «We have sent you a message in Telegram with the code» и т.п. */
const CODE_SENT_TEXT = /sent you (a message|an sms|a code|the code)|with the code|we've sent|отправили (вам )?(сообщение|код|sms)|с кодом/i;
/** Новый Web K пишет ошибку кода текстом под клетками, а не в label поля */
const CODE_ERROR_TEXT = /invalid code|incorrect code|wrong code|code (is )?(invalid|incorrect|expired)|неверный код|код (неверн|устарел)/i;
const PASSWORD_INPUT = 'input[type="password"]';
const LOGGED_IN = "#column-left .chatlist";
/** Web K помечает само поле (.input-field-input.error, aria-invalid) и пишет текст ошибки в соседний label */
const ERROR_LABEL = '.input-field:has(.input-field-input.error, [aria-invalid="true"]) label';

/** Web K показывает QR сразу на старте; классы — CSS-модули с хешем (_qrContainer_1njl8_230) */
const QR_CONTAINER = '[class*="_qrContainer_"], .page-signQR .qr-container';

/** QR нарисован, когда в контейнере пропал спиннер */
async function waitForQr(page: Page): Promise<void> {
  const container = page.locator(QR_CONTAINER).first();
  await container.waitFor({ state: "visible", timeout: LOGIN_STEP_TIMEOUT_MS });
  await container.locator(".preloader").first().waitFor({ state: "detached", timeout: LOGIN_STEP_TIMEOUT_MS }).catch(() => null);
}

const hasUserAuth = (page: Page) =>
  page
    .evaluate(() => {
      const auth = localStorage.getItem("user_auth");
      return !!auth && auth !== "null";
    })
    .catch(() => false);

const anyVisible = (page: Page, selector: string) =>
  page.locator(selector).filter({ visible: true }).count().then((count) => count > 0).catch(() => false);

const textVisible = (page: Page, text: RegExp) =>
  page.getByText(text).filter({ visible: true }).count().then((count) => count > 0).catch(() => false);

/** Общие исходы любого шага: вход выполнен или Telegram показал ошибку */
async function probeCommon(page: Page): Promise<ENUM_LOGIN_STEP_TYPE | { error: string } | null> {
  if ((await isVisible(page, LOGGED_IN)) || (await hasUserAuth(page))) return ENUM_LOGIN_STEP.DONE;
  const error = await visibleText(page, ERROR_LABEL);
  return error ? { error } : null;
}

/** Экран ввода кода: по тексту «отправили код» или по видимому полю кода (одному или клеткам) */
export const isCodeScreen = async (page: Page) => (await textVisible(page, CODE_SENT_TEXT)) || (await anyVisible(page, CODE_INPUT));

const afterPhone: TLoginProbe = async (page) =>
  (await probeCommon(page)) ?? ((await isCodeScreen(page)) ? ENUM_LOGIN_STEP.CODE : null);

const afterCode: TLoginProbe = async (page) => {
  const common = await probeCommon(page);
  if (common) return common;
  if (await anyVisible(page, PASSWORD_INPUT)) return ENUM_LOGIN_STEP.PASSWORD;
  const codeError = await page.getByText(CODE_ERROR_TEXT).filter({ visible: true }).first().innerText().catch(() => null);
  return codeError ? { error: codeError.trim() } : null;
};

/**
 * Ввод кода: в клетках фокус уже стоит на первой — кликаем, только если видно поле.
 * Backspace стирает прошлую попытку (по пустой клетке он переходит на предыдущую)
 */
async function enterCode(page: Page, code: string): Promise<void> {
  const field = page.locator(CODE_INPUT).filter({ visible: true }).first();
  if ((await field.count().catch(() => 0)) > 0) await field.click({ timeout: 5_000 }).catch(() => null);
  for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type(code, { delay: 60 });
}

const afterPassword: TLoginProbe = probeCommon;

/** Ввод в поле Web K: очистить и набрать как человек — так срабатывают его обработчики */
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector).first();
  await field.click({ timeout: LOGIN_STEP_TIMEOUT_MS });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value, { delay: 40 });
}

/**
 * Вход в Telegram Web K: «по номеру» → телефон → код (из Telegram или SMS) → пароль 2FA, если включён.
 * Сценарий тот же, что в старом telegram.auth.ts, только шаги приходят из админки
 */
export const telegramLoginDriver: ILoginDriver = {
  async start(page: Page, input: ILoginStartInput) {
    if (!input.phone) throw new SessionError("LOGIN_REJECTED", "Нужен телефон");

    await page.goto(WEB_K_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_STEP_TIMEOUT_MS });
    await page
      .locator(PHONE_LOGIN_BUTTON, { hasText: /phone number/i })
      .first()
      .click({ timeout: LOGIN_STEP_TIMEOUT_MS });
    await typeInto(page, PHONE_INPUT, input.phone);
    await page.locator(NEXT_BUTTON, { hasText: /next/i }).first().click({ timeout: LOGIN_STEP_TIMEOUT_MS });

    return waitForLoginOutcome(page, afterPhone, "телефон");
  },

  async submitCode(page: Page, code: string) {
    // Web K отправляет код сам, когда набрана нужная длина; Enter — на случай другой длины
    await enterCode(page, code);
    await page.keyboard.press("Enter").catch(() => null);
    return waitForLoginOutcome(page, afterCode, "код");
  },

  async submitPassword(page: Page, password: string) {
    await typeInto(page, PASSWORD_INPUT, password);
    await page.keyboard.press("Enter");
    return waitForLoginOutcome(page, afterPassword, "пароль");
  },

  async resendCode(page: Page) {
    // Web K показывает ссылку повторной отправки только по истечении таймера Telegram
    const clicked = await clickByText(page, /send.*(sms|again)|resend|didn.t get|get code/i);
    if (!clicked) throw new SessionError("LOGIN_REJECTED", "Повторная отправка пока недоступна — подождите таймер Telegram");
  },

  async startQr(page: Page) {
    await page.goto(WEB_K_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_STEP_TIMEOUT_MS });
    await waitForQr(page);
    return ENUM_LOGIN_STEP.QR;
  },

  async pollQr(page: Page) {
    if ((await isVisible(page, LOGGED_IN)) || (await hasUserAuth(page))) return ENUM_LOGIN_STEP.DONE;
    // После скана аккаунт с 2FA попадает на страницу облачного пароля
    if (await anyVisible(page, PASSWORD_INPUT)) return ENUM_LOGIN_STEP.PASSWORD;
    return null;
  },

  async qrImage(page: Page) {
    await waitForQr(page).catch(() => null);
    return page
      .locator(QR_CONTAINER)
      .first()
      .screenshot({ type: "png", timeout: 5_000 })
      .then((buffer) => buffer.toString("base64"))
      .catch(() => null);
  },

  async finish(page: Page): Promise<ILoginAccount> {
    // user_auth = {"dcID":2,"id":7697061334,...} — id аккаунта, он же account_id сессии
    const id = await page
      .waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem("user_auth") || "null")?.id ?? null;
          } catch {
            return null;
          }
        },
        null,
        { timeout: LOGIN_STEP_TIMEOUT_MS },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);

    if (!id) throw new SessionError("LOGIN_FAILED", "Вход выполнен, но в localStorage нет user_auth");
    return { accountId: String(id), username: null };
  },
};
