import { Page } from "playwright";
import { SessionError } from "../../type";
import { ENUM_LOGIN_STEP, ENUM_LOGIN_STEP_TYPE, ILoginAccount, ILoginDriver, ILoginStartInput } from "./login.types";
import { LOGIN_STEP_TIMEOUT_MS, TLoginProbe, clickByText, isVisible, visibleText, waitForLoginOutcome } from "./login.utils";

const LOGIN_URL = "https://www.instagram.com/accounts/login/";
const USERNAME_INPUT = 'input[name="username"]';
const PASSWORD_INPUT = 'input[name="password"]';
/** 2FA (verificationCode) или проверка подозрительного входа (security_code) */
const CODE_INPUT = 'input[name="verificationCode"], input[name="security_code"], input[name="approvals_code"]';
const ERROR_ALERT = '#slfErrorAlert, [role="alert"]';
const COOKIE_BUTTON = /allow all cookies|only allow essential cookies|accept all/i;

const hasSessionCookie = async (page: Page) =>
  (await page.context().cookies("https://www.instagram.com")).some((cookie) => cookie.name === "sessionid");

/** sessionid появляется сразу после входа, ещё до диалогов «сохранить данные» */
const probe = (codeIsNext: boolean): TLoginProbe => async (page) => {
  if (await hasSessionCookie(page)) return ENUM_LOGIN_STEP.DONE;
  const error = await visibleText(page, ERROR_ALERT);
  if (error) return { error };
  if (codeIsNext && (await isVisible(page, CODE_INPUT))) return ENUM_LOGIN_STEP.CODE;
  return null;
};

async function dismissCookieBanner(page: Page): Promise<void> {
  await page.getByRole("button", { name: COOKIE_BUTTON }).first().click({ timeout: 3_000 }).catch(() => null);
}

/** Вход в Instagram: логин + пароль → код, если Instagram попросит (2FA или проверка входа) */
export const instagramLoginDriver: ILoginDriver = {
  async start(page: Page, input: ILoginStartInput) {
    if (!input.username || !input.password) throw new SessionError("LOGIN_REJECTED", "Нужны логин и пароль");

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_STEP_TIMEOUT_MS });
    await dismissCookieBanner(page);
    await page.locator(USERNAME_INPUT).fill(input.username, { timeout: LOGIN_STEP_TIMEOUT_MS });
    await page.locator(PASSWORD_INPUT).fill(input.password);
    await page.locator(PASSWORD_INPUT).press("Enter");

    return waitForLoginOutcome(page, probe(true), "логин и пароль");
  },

  async submitCode(page: Page, code: string) {
    const field = page.locator(CODE_INPUT).first();
    await field.fill(code, { timeout: LOGIN_STEP_TIMEOUT_MS });
    await field.press("Enter");
    // Поле кода остаётся на странице до успеха — ждём только cookie или ошибку
    return waitForLoginOutcome(page, probe(false), "код");
  },

  async submitPassword(): Promise<ENUM_LOGIN_STEP_TYPE> {
    throw new SessionError("LOGIN_WRONG_STEP", "У Instagram пароль передаётся на старте");
  },

  async resendCode(page: Page) {
    const clicked = await clickByText(page, /resend|get a new code|send.*again/i);
    if (!clicked) throw new SessionError("LOGIN_REJECTED", "Instagram не предлагает отправить код ещё раз");
  },

  async finish(_page: Page, input: ILoginStartInput): Promise<ILoginAccount> {
    const login = (input.username ?? "").trim().replace(/^@/, "").toLowerCase();
    return { accountId: login, username: `@${login}` };
  },
};
