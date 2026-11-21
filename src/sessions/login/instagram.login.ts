import { Page } from "playwright";
import { SessionError } from "../../type";
import { ENUM_LOGIN_STEP, ENUM_LOGIN_STEP_TYPE, ILoginAccount, ILoginDriver, ILoginStartInput } from "./login.types";
import { LOGIN_STEP_TIMEOUT_MS, TLoginProbe, clickByText, isVisible, visibleText, waitForLoginOutcome } from "./login.utils";

const LOGIN_URL = "https://www.instagram.com/accounts/login/";
/** Старая форма — username/password, новая (с 2026, как у Facebook) — email/pass */
const USERNAME_INPUT = 'input[name="username"], input[name="email"]';
const PASSWORD_INPUT = 'input[name="password"], input[name="pass"]';
/** 2FA (verificationCode) или проверка подозрительного входа (security_code) */
const CODE_INPUT =
  'input[name="verificationCode"], input[name="security_code"], input[name="approvals_code"], input[autocomplete="one-time-code"]';
const ERROR_ALERT = '#slfErrorAlert, [role="alert"]';
/** В новой форме у блока ошибки нет ни id, ни role — только обфусцированные классы, поэтому ищем по тексту (контекст входа en-US) */
const ERROR_TEXT =
  "text=/login information you entered is incorrect|password was incorrect|doesn't belong to an account|problem logging you into|wait a few minutes before you try again|code (isn't|is not|wasn't) (right|valid|correct)|code didn't work|(incorrect|invalid|wrong) code|code has expired/i";
const PROGRESS_TEXT = /being validated|validating|verifying|loading|sending|please wait/i;
const COOKIE_BUTTON =/allow all cookies|only allow essential cookies|decline optional cookies|accept all/i;
/**
 * Проверка входа в стиле Meta (/auth_platform/): «Check your notifications on another device» → Try another way →
 * выбор способа (radio): Email с кодом или уведомление. Админ не может нажать «подтвердить» за сервис — берём код на почту
 */
const APPROVAL_SCREEN = "text=/check your notifications on another device/i";
const CHALLENGE_PICKER = 'input[type="radio"][name="challenge"]';
/** Радиокнопки выбора скрыты стилями (размер 0) — проверяем наличие, а не видимость */
const hasPicker = async (page: Page) => (await page.locator(CHALLENGE_PICKER).count().catch(() => 0)) > 0;
/** Поле кода на страницах /auth_platform/ без стабильного name */
const AUTH_PLATFORM_CODE_INPUT = 'input[type="text"], input[type="number"], input[type="tel"], input:not([type])';

const hasSessionCookie = async (page: Page) =>
  (await page.context().cookies("https://www.instagram.com")).some((cookie) => cookie.name === "sessionid");

const codeInput = (page: Page) =>
  page.url().includes("/auth_platform/") && !page.url().includes("/challengepicker/")
    ? page.locator(CODE_INPUT).or(page.locator(AUTH_PLATFORM_CODE_INPUT)).first()
    : page.locator(CODE_INPUT).first();

/** Подтверждение на другом устройстве → выбрать код на почту; false — такого варианта нет */
async function chooseEmailCode(page: Page): Promise<boolean> {
  if (await isVisible(page, APPROVAL_SCREEN)) {
    const other = page.getByRole("button", { name: /try another way/i }).first();
    if (!(await other.isVisible().catch(() => false))) return false;
    await other.click({ timeout: 5_000 });
    await page.locator(CHALLENGE_PICKER).first().waitFor({ state: "attached", timeout: 15_000 });
  }
  if (!(await hasPicker(page))) return false;
  const email = page.locator("label").filter({ hasText: /^\s*email/i }).first();
  if (!(await email.isVisible().catch(() => false))) return false;
  await email.click({ timeout: 5_000 });
  await page.getByRole("button", { name: /^continue$/i }).first().click({ timeout: 5_000 });
  return true;
}

/** sessionid появляется сразу после входа, ещё до диалогов «сохранить данные» */
const probe = (codeIsNext: boolean): TLoginProbe => async (page) => {
  if (await hasSessionCookie(page)) return ENUM_LOGIN_STEP.DONE;
  // На /auth_platform/ role=alert — ещё и живой статус («Input Code is being validated.»), а не только ошибка
  const alert = await visibleText(page, ERROR_ALERT);
  const error = (alert && !PROGRESS_TEXT.test(alert) ? alert : null) ?? (await visibleText(page, ERROR_TEXT));
  if (error) return { error };
  if (!codeIsNext) return null;
  if (await codeInput(page).isVisible().catch(() => false)) return ENUM_LOGIN_STEP.CODE;
  if ((await isVisible(page, APPROVAL_SCREEN)) || (await hasPicker(page))) {
    if (!(await chooseEmailCode(page))) {
      return { error: "Instagram просит подтвердить вход на другом устройстве и не предлагает код на почту" };
    }
  }
  return null;
};

/** Настоящий логин аккаунта: входить можно и по почте/телефону, а account_id сессии — это логин */
async function readUsername(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies("https://www.instagram.com");
  const userId = cookies.find((cookie) => cookie.name === "ds_user_id")?.value;
  if (!userId) return null;
  if (!page.url().startsWith("https://www.instagram.com")) {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: LOGIN_STEP_TIMEOUT_MS });
  }
  // Без async внутри evaluate: target es2016 превращает его в __awaiter, которого в браузере нет
  // Данные формы «Edit profile»; /users/<id>/info/ сразу после входа часто отвечает 429
  return page.evaluate(() =>
    fetch("/api/v1/accounts/edit/web_form_data/", { headers: { "X-IG-App-ID": "936619743392459" } })
      .then((response) => response.json())
      .then((data) => (typeof data?.form_data?.username === "string" ? (data.form_data.username as string) : null))
      .catch(() => null),
  );
}

/**
 * До формы бывают два экрана в любом порядке: промо приложения («Get the full experience…» → Log in)
 * и окно cookies, которое появляется через несколько секунд и, пока открыто, перекрывает кнопку «Log in».
 * Сервер отдаёт обычную форму, а скрипты потом могут заменить её промо — поэтому ввод с повтором:
 * поле пропало посреди ввода — снова открываем форму
 */
async function fillLoginForm(page: Page, username: string, password: string): Promise<void> {
  const user = page.locator(USERNAME_INPUT).first();
  const pass = page.locator(PASSWORD_INPUT).first();
  const cookies = page.getByRole("button", { name: COOKIE_BUTTON }).first();
  const logIn = page.getByRole("button", { name: /^log in$/i }).or(page.getByRole("link", { name: /^log in$/i })).first();
  const deadline = Date.now() + LOGIN_STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await cookies.isVisible().catch(() => false)) {
      await cookies.click({ timeout: 3_000 }).catch(() => null);
    } else if ((await user.isVisible().catch(() => false)) && (await pass.isVisible().catch(() => false))) {
      const filled = await user
        .fill(username, { timeout: 3_000 })
        .then(() => pass.fill(password, { timeout: 3_000 }))
        .then(() => pass.press("Enter", { timeout: 3_000 }))
        .then(() => true, () => false);
      if (filled) return;
    } else if (await logIn.isVisible().catch(() => false)) {
      await logIn.click({ timeout: 3_000 }).catch(() => null);
    }
    await page.waitForTimeout(500);
  }
  throw new SessionError("LOGIN_FAILED", `Instagram не показал форму входа (${page.url()})`);
}

/** Вход в Instagram: логин + пароль → код, если Instagram попросит (2FA или проверка входа) */
export const instagramLoginDriver: ILoginDriver = {
  async start(page: Page, input: ILoginStartInput) {
    if (!input.username || !input.password) throw new SessionError("LOGIN_REJECTED", "Нужны логин и пароль");

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_STEP_TIMEOUT_MS });
    await fillLoginForm(page, input.username, input.password);

    return waitForLoginOutcome(page, probe(true), "логин и пароль");
  },

  async submitCode(page: Page, code: string) {
    const field = codeInput(page);
    await field.fill(code, { timeout: LOGIN_STEP_TIMEOUT_MS });
    await field.press("Enter");
    // На /auth_platform/ Enter может не отправлять форму — тогда кнопка Continue
    await page.waitForTimeout(1_000);
    if (!(await hasSessionCookie(page))) {
      await page.getByRole("button", { name: /^(continue|confirm|submit)$/i }).first().click({ timeout: 2_000 }).catch(() => null);
    }
    // Поле кода остаётся на странице до успеха — ждём только cookie или ошибку
    return waitForLoginOutcome(page, probe(false), "код");
  },

  async submitPassword(): Promise<ENUM_LOGIN_STEP_TYPE> {
    throw new SessionError("LOGIN_WRONG_STEP", "У Instagram пароль передаётся на старте");
  },

  async resendCode(page: Page) {
    const clicked = await clickByText(page, /resend|(get|send) a new code|send.*again/i);
    if (!clicked) throw new SessionError("LOGIN_REJECTED", "Instagram не предлагает отправить код ещё раз");
  },

  async finish(page: Page, input: ILoginStartInput): Promise<ILoginAccount> {
    const username = await readUsername(page).catch(() => null);
    const login = (username ?? input.username ?? "").trim().replace(/^@/, "").toLowerCase();
    return { accountId: login, username: `@${login}` };
  },
};
