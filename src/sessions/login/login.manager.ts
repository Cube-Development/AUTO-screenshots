import crypto from "crypto";
import { Browser, BrowserContext, Page } from "playwright";
import { ENUM_SESSION_EVENT, ENUM_SESSION_PLATFORM, ENUM_SESSION_PLATFORM_TYPE, SessionError, TStorageState } from "../../type";
import { log } from "../../utils";
import { SessionsService } from "../sessions.service";
import { instagramLoginDriver } from "./instagram.login";
import { ENUM_LOGIN_METHOD, ENUM_LOGIN_STEP, ENUM_LOGIN_STEP_TYPE, ILoginDriver, ILoginResult, ILoginStartInput } from "./login.types";
import { telegramLoginDriver } from "./telegram.login";

/** Брошенный вход закрывается: браузерный контекст держит память */
const LOGIN_TTL_MS = 10 * 60_000;
/** Потолок жизни входа: опрос QR продлевает TTL, но забытый диалог не должен держать слот бессрочно */
const LOGIN_MAX_LIFETIME_MS = 15 * 60_000;
/** Каждый вход — отдельный контекст Chromium рядом со скриншотами */
const MAX_ACTIVE_LOGINS = 3;

/** YouTube: Google блокирует вход в автоматизированном браузере — только загрузка файла */
const DRIVERS: Partial<Record<ENUM_SESSION_PLATFORM_TYPE, ILoginDriver>> = {
  [ENUM_SESSION_PLATFORM.TELEGRAM]: telegramLoginDriver,
  [ENUM_SESSION_PLATFORM.INSTAGRAM]: instagramLoginDriver,
};

interface ILoginEntry {
  id: string;
  platform: ENUM_SESSION_PLATFORM_TYPE;
  driver: ILoginDriver;
  input: ILoginStartInput;
  context: BrowserContext;
  page: Page;
  step: ENUM_LOGIN_STEP_TYPE;
  busy: boolean;
  timer: NodeJS.Timeout;
  startedAt: number;
}

/**
 * Вход в аккаунт внутри headless-браузера сервиса: шаги (телефон/логин → код → пароль) приходят из админки.
 * После входа storageState сразу шифруется и сохраняется как сессия — как при загрузке файла
 */
export class SessionLoginManager {
  private readonly logins = new Map<string, ILoginEntry>();
  /** Входы, которые уже прошли проверку лимита, но ещё открывают браузер: иначе параллельные старты превысят лимит */
  private starting = 0;

  constructor(
    private readonly getBrowser: () => Promise<Browser>,
    private readonly sessions: SessionsService,
  ) {}

  public static isSupported(platform: ENUM_SESSION_PLATFORM_TYPE): boolean {
    return Boolean(DRIVERS[platform]);
  }

  /** Сколько входов сейчас открыто — для сводки */
  public get activeCount(): number {
    return this.logins.size;
  }

  /**
   * Перелогин существующей сессии: телефон или логин берутся из неё, войти нужно в тот же аккаунт.
   * Instagram пароль не хранит — его присылает админ
   */
  public async relogin(
    platform: ENUM_SESSION_PLATFORM_TYPE,
    accountId: string,
    overrides: Pick<ILoginStartInput, "phone" | "password" | "method" | "actor">,
  ): Promise<ILoginResult> {
    const session = this.sessions.get(platform, accountId);
    if (!session) throw new SessionError("SESSION_NOT_FOUND");

    return this.start(platform, {
      method: overrides.method,
      actor: overrides.actor,
      phone: overrides.phone ?? session.phone ?? undefined,
      username: platform === ENUM_SESSION_PLATFORM.INSTAGRAM ? accountId : undefined,
      password: overrides.password,
      expectedAccountId: accountId,
    });
  }

  public async resendCode(loginId: string): Promise<ILoginResult> {
    const entry = this.take(loginId, ENUM_LOGIN_STEP.CODE);
    return this.runStep(
      entry,
      async () => {
        await entry.driver.resendCode(entry.page);
        return ENUM_LOGIN_STEP.CODE;
      },
      { closeOnReject: false },
    );
  }

  public async start(platform: ENUM_SESSION_PLATFORM_TYPE, input: ILoginStartInput): Promise<ILoginResult> {
    const driver = DRIVERS[platform];
    if (!driver) throw new SessionError("LOGIN_REJECTED", `Вход в ${platform} через браузер не поддерживается — загрузите файл сессии`);
    if (input.method === ENUM_LOGIN_METHOD.QR && !driver.startQr) {
      throw new SessionError("LOGIN_REJECTED", `Вход по QR в ${platform} не поддерживается`);
    }
    if (this.logins.size + this.starting >= MAX_ACTIVE_LOGINS) {
      throw new SessionError("LOGIN_FAILED", `Уже идёт ${this.logins.size + this.starting} входа, завершите или отмените их`);
    }

    this.starting++;
    let entry: ILoginEntry;
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      // newPage может упасть — контекст тогда закрываем сами, в logins он ещё не попал
      const page = await context.newPage().catch(async (err) => {
        await context.close().catch(() => null);
        throw err;
      });
      const id = crypto.randomUUID();
      const startedAt = Date.now();
      entry = {
        id,
        platform,
        driver,
        input,
        context,
        page,
        step: ENUM_LOGIN_STEP.CODE,
        busy: true,
        startedAt,
        timer: this.expireTimer(id, startedAt),
      };
      this.logins.set(id, entry);
    } finally {
      this.starting--;
    }
    log.info({ loginId: entry.id, platform }, `🔐 Вход начат`);

    const isQr = input.method === ENUM_LOGIN_METHOD.QR;
    return this.runStep(entry, () => (isQr ? driver.startQr!(entry.page) : driver.start(entry.page, input)), {
      closeOnReject: true,
    });
  }

  /** Опрос входа по QR: отсканировали — done (или password при 2FA), иначе свежий QR */
  public async pollQr(loginId: string): Promise<ILoginResult> {
    const entry = this.take(loginId, ENUM_LOGIN_STEP.QR);
    return this.runStep(entry, async () => (await entry.driver.pollQr!(entry.page)) ?? ENUM_LOGIN_STEP.QR, {
      closeOnReject: false,
    });
  }

  public async submitCode(loginId: string, code: string): Promise<ILoginResult> {
    const entry = this.take(loginId, ENUM_LOGIN_STEP.CODE);
    return this.runStep(entry, () => entry.driver.submitCode(entry.page, code), { closeOnReject: false });
  }

  public async submitPassword(loginId: string, password: string): Promise<ILoginResult> {
    const entry = this.take(loginId, ENUM_LOGIN_STEP.PASSWORD);
    return this.runStep(entry, () => entry.driver.submitPassword(entry.page, password), { closeOnReject: false });
  }

  public async cancel(loginId: string): Promise<boolean> {
    if (!this.logins.has(loginId)) return false;
    await this.close(loginId);
    log.info({ loginId }, `🔐 Вход отменён`);
    return true;
  }

  /** Вход ждёт именно этот шаг и не занят предыдущим запросом */
  private take(loginId: string, step: ENUM_LOGIN_STEP_TYPE): ILoginEntry {
    const entry = this.logins.get(loginId);
    if (!entry) throw new SessionError("LOGIN_NOT_FOUND", "Вход не найден или истёк — начните заново");
    if (entry.busy) throw new SessionError("LOGIN_WRONG_STEP", "Предыдущий шаг ещё выполняется");
    if (entry.step !== step) throw new SessionError("LOGIN_WRONG_STEP", `Вход ждёт шаг ${entry.step}`);
    entry.busy = true;
    return entry;
  }

  /**
   * Неверный код/пароль (LOGIN_REJECTED) оставляет вход открытым — можно ввести снова.
   * Неверный телефон на старте и любые сбои закрывают вход
   */
  private async runStep(
    entry: ILoginEntry,
    action: () => Promise<ENUM_LOGIN_STEP_TYPE>,
    options: { closeOnReject: boolean },
  ): Promise<ILoginResult> {
    try {
      const step = await action();
      if (step === ENUM_LOGIN_STEP.DONE) return await this.complete(entry);

      const repeated = entry.step === step;
      entry.step = step;
      const qrImage = step === ENUM_LOGIN_STEP.QR ? ((await entry.driver.qrImage?.(entry.page)) ?? null) : null;
      entry.busy = false;
      clearTimeout(entry.timer);
      entry.timer = this.expireTimer(entry.id, entry.startedAt);
      // Опрос QR повторяет шаг каждые несколько секунд — в лог только переходы
      if (!repeated || step !== ENUM_LOGIN_STEP.QR) {
        log.info({ loginId: entry.id, platform: entry.platform, step }, `🔐 Вход ждёт следующий шаг`);
      }
      return { login_id: entry.id, platform: entry.platform, step, session: null, qr_image: qrImage };
    } catch (err) {
      const error = err instanceof SessionError ? err : new SessionError("LOGIN_FAILED", (err as Error)?.message ?? String(err));
      // Снимок до закрытия контекста: видно, что показала платформа вместо ожидаемого шага
      error.image = await entry.page
        .screenshot({ type: "jpeg", quality: 60 })
        .then((buffer) => buffer.toString("base64"))
        .catch(() => null);

      const keepOpen = error.message === "LOGIN_REJECTED" && !options.closeOnReject;
      if (keepOpen) {
        entry.busy = false;
      } else {
        await this.close(entry.id);
      }
      log.warn({ loginId: entry.id, platform: entry.platform, err: error.message, detail: error.detail }, `🔐 Шаг входа не прошёл`);
      throw error;
    }
  }

  /** Вход выполнен: сессия сохраняется (или заменяет прежнюю того же аккаунта) и сразу доступна скриншотам */
  private async complete(entry: ILoginEntry): Promise<ILoginResult> {
    try {
      const account = await entry.driver.finish(entry.page, entry.input);
      const expected = entry.input.expectedAccountId;
      if (expected && account.accountId.toLowerCase() !== expected.toLowerCase()) {
        throw new SessionError("LOGIN_ACCOUNT_MISMATCH", `Вход выполнен в аккаунт ${account.accountId}, а ожидался ${expected} — сессия не сохранена`);
      }
      const state = (await entry.context.storageState()) as TStorageState;
      const session = this.sessions.upsert(entry.platform, account.accountId, state, {
        label: entry.input.label,
        phone: entry.input.phone,
        username: account.username ?? undefined,
        verified: true,
        source: ENUM_SESSION_EVENT.LOGIN,
        actor: entry.input.actor ?? null,
      });
      log.info({ loginId: entry.id, platform: entry.platform, accountId: account.accountId }, `🔐 Вход выполнен, сессия сохранена`);
      return { login_id: entry.id, platform: entry.platform, step: ENUM_LOGIN_STEP.DONE, session, qr_image: null };
    } finally {
      await this.close(entry.id);
    }
  }

  /** 10 минут без действий, но не дольше потолка жизни входа */
  private expireTimer(loginId: string, startedAt: number): NodeJS.Timeout {
    const delay = Math.max(0, Math.min(LOGIN_TTL_MS, startedAt + LOGIN_MAX_LIFETIME_MS - Date.now()));
    const timer = setTimeout(() => {
      void this.close(loginId).then(() => log.info({ loginId }, `🔐 Вход истёк`));
    }, delay);
    timer.unref();
    return timer;
  }

  private async close(loginId: string): Promise<void> {
    const entry = this.logins.get(loginId);
    if (!entry) return;
    this.logins.delete(loginId);
    clearTimeout(entry.timer);
    await entry.context.close().catch(() => null);
  }
}
