import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Browser } from "playwright";
import { SessionLoginManager } from "../src/sessions/login";
import { SessionsService } from "../src/sessions/sessions.service";
import { SessionError } from "../src/type";
import { resetSessions, telegramState } from "./helpers";

const service = SessionsService.getInstance();

const isCode = (code: number) => (err: unknown) => err instanceof SessionError && err.code === code;

/** Страница, на которой Web K так и не открылся: старт входа висит, вход остаётся в списке */
function hangingBrowser(counter: { contexts: number; closed: number }): Browser {
  return {
    newContext: async () => {
      counter.contexts++;
      return {
        newPage: async () => ({ goto: () => new Promise(() => undefined) }),
        close: async () => {
          counter.closed++;
        },
      };
    },
  } as unknown as Browser;
}

describe("SessionLoginManager", () => {
  beforeEach(() => resetSessions(service));

  it("supports Telegram and Instagram, not YouTube", async () => {
    assert.equal(SessionLoginManager.isSupported("telegram"), true);
    assert.equal(SessionLoginManager.isSupported("instagram"), true);
    assert.equal(SessionLoginManager.isSupported("youtube"), false);

    const manager = new SessionLoginManager(async () => hangingBrowser({ contexts: 0, closed: 0 }), service);
    await assert.rejects(manager.start("youtube", {}), isCode(1016));
  });

  it("refuses a QR login outside Telegram before opening a browser", async () => {
    const counter = { contexts: 0, closed: 0 };
    const manager = new SessionLoginManager(async () => hangingBrowser(counter), service);

    await assert.rejects(manager.start("instagram", { method: "qr", username: "a", password: "b" }), isCode(1016));
    assert.equal(counter.contexts, 0);
  });

  it("does not exceed three open logins even when started at once", async () => {
    const counter = { contexts: 0, closed: 0 };
    const manager = new SessionLoginManager(async () => hangingBrowser(counter), service);

    const starts = [1, 2, 3, 4].map((i) => manager.start("telegram", { phone: `+99890000000${i}` }));
    const fourth = await Promise.race([starts[3].then(() => "started", (err) => err), new Promise((r) => setTimeout(() => r("pending"), 200))]);

    assert.ok(fourth instanceof SessionError && fourth.code === 1017, String(fourth));
    // первые три ещё открывают браузер — даём им дойти до списка входов
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.activeCount, 3);
    assert.equal(counter.contexts, 3);
  });

  it("closes the browser context when the page could not be opened", async () => {
    const counter = { closed: 0 };
    const browser = {
      newContext: async () => ({
        newPage: async () => {
          throw new Error("Target closed");
        },
        close: async () => {
          counter.closed++;
        },
      }),
    } as unknown as Browser;
    const manager = new SessionLoginManager(async () => browser, service);

    await assert.rejects(manager.start("telegram", { phone: "+998900000001" }), /Target closed/);
    assert.equal(counter.closed, 1);
    assert.equal(manager.activeCount, 0);
  });

  it("answers LOGIN_NOT_FOUND for unknown logins", async () => {
    const manager = new SessionLoginManager(async () => hangingBrowser({ contexts: 0, closed: 0 }), service);
    const id = "00000000-0000-4000-8000-000000000000";

    await assert.rejects(manager.submitCode(id, "12345"), isCode(1014));
    await assert.rejects(manager.pollQr(id), isCode(1014));
    assert.equal(await manager.cancel(id), false);
  });

  it("relogin of an unknown session is SESSION_NOT_FOUND", async () => {
    const manager = new SessionLoginManager(async () => hangingBrowser({ contexts: 0, closed: 0 }), service);
    await assert.rejects(manager.relogin("telegram", "404", {}), isCode(1008));
  });

  it("relogin takes the phone from the session", async () => {
    service.upsert("telegram", "1", telegramState(1), { verified: true, phone: "+998901234567" });
    const manager = new SessionLoginManager(async () => hangingBrowser({ contexts: 0, closed: 0 }), service);
    const calls: unknown[] = [];
    manager.start = async (platform, input) => {
      calls.push({ platform, input });
      return { login_id: "x", platform, step: "code", session: null, qr_image: null };
    };

    await manager.relogin("telegram", "1", { actor: "admin@blogix.uz" });
    assert.deepEqual(calls, [{
      platform: "telegram",
      input: { method: undefined, actor: "admin@blogix.uz", phone: "+998901234567", username: undefined, password: undefined, expectedAccountId: "1" },
    }]);
  });
});
