import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { SessionsService } from "../src/sessions/sessions.service";
import { SessionError, TSessionChangeEvent } from "../src/type";
import { instagramState, resetSessions, telegramState } from "./helpers";

const service = SessionsService.getInstance();
const ADMIN = "admin@blogix.uz";

const addTelegram = (id: string, options: { verified?: boolean; actor?: string } = {}) =>
  service.upsert("telegram", id, telegramState(id), { verified: options.verified ?? true, actor: options.actor });
const addInstagram = (id: string) => service.upsert("instagram", id, instagramState(), { verified: true });

describe("SessionsService", () => {
  beforeEach(() => resetSessions(service));

  describe("upsert", () => {
    it("makes the first session of a platform the default one", () => {
      assert.equal(addTelegram("1").is_default, true);
      assert.equal(addTelegram("2").is_default, false);
    });

    it("writes who uploaded and whether it is new or a replacement", () => {
      addTelegram("1", { actor: ADMIN });
      addTelegram("1", { verified: false });

      const events = service.events("telegram", "1");
      assert.deepEqual(events.map((e) => [e.action, e.actor, e.detail]), [
        ["upload", null, "замена сессии"],
        ["upload", ADMIN, "новая сессия, вход проверен"],
      ]);
    });

    it("tells the screenshot pools about the new session", () => {
      const seen: TSessionChangeEvent[] = [];
      const off = service.onChange((event) => seen.push(event));
      addTelegram("1");
      off();

      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, "upsert");
    });
  });

  describe("resolve", () => {
    it("returns the requested active session", () => {
      addTelegram("1");
      addTelegram("2");
      assert.equal(service.resolve("telegram", "2").accountId, "2");
    });

    it("falls back to the default Telegram session when the requested one is unknown or disabled", () => {
      addTelegram("1");
      addTelegram("2");
      service.update("telegram", "2", { status: "disabled" });

      assert.equal(service.resolve("telegram", "2").accountId, "1");
      assert.equal(service.resolve("telegram", "999").accountId, "1");
      assert.equal(service.resolve("telegram").accountId, "1");
    });

    it("rotates over active Instagram sessions, skipping inactive ones", () => {
      addInstagram("a");
      addInstagram("b");
      addInstagram("c");
      service.update("instagram", "c", { status: "disabled" });

      const picked = [1, 2, 3, 4].map(() => service.resolve("instagram").accountId);
      assert.deepEqual(picked, ["a", "b", "a", "b"]);
    });

    it("fails fast when the platform has no active session", () => {
      assert.throws(() => service.resolve("youtube"), (err: unknown) => err instanceof SessionError && err.code === 1008);
    });

    it("decrypts the stored state", () => {
      addTelegram("1");
      assert.deepEqual(service.resolve("telegram", "1").state, telegramState("1"));
    });
  });

  describe("update", () => {
    it("renames the session and moves its history", () => {
      addTelegram("1");
      const updated = service.update("telegram", "1", { accountId: "11", label: "Резерв" }, ADMIN);

      assert.equal(updated?.account_id, "11");
      assert.equal(service.get("telegram", "1"), null);
      const actions = service.events("telegram", "11").map((e) => e.action);
      assert.deepEqual(actions, ["update", "upload"]);
      assert.match(service.events("telegram", "11")[0].detail!, /account_id: 1 → 11.*заметка: Резерв/);
    });

    it("refuses a rename onto an existing session", () => {
      addTelegram("1");
      addTelegram("2");
      assert.throws(() => service.update("telegram", "1", { accountId: "2" }), (err: unknown) => err instanceof SessionError && err.code === 1013);
    });

    it("refuses to make an inactive session the default one", () => {
      addTelegram("1");
      addTelegram("2");
      service.update("telegram", "2", { status: "disabled" });

      assert.throws(() => service.update("telegram", "2", { isDefault: true }), (err: unknown) => err instanceof SessionError && err.code === 1010);
      assert.throws(() => service.update("telegram", "1", { status: "disabled", isDefault: true }), (err: unknown) => err instanceof SessionError && err.code === 1010);
    });

    it("moves the default flag when the default session is disabled", () => {
      addTelegram("1");
      addTelegram("2");
      service.update("telegram", "1", { status: "disabled" });

      assert.equal(service.get("telegram", "2")?.is_default, true);
      assert.equal(service.events("telegram", "2")[0].action, "default_change");
    });

    it("returns null for an unknown session", () => {
      assert.equal(service.update("telegram", "404", { label: "x" }), null);
    });
  });

  describe("markChecked", () => {
    it("expires a logged out session and moves the default flag", () => {
      addTelegram("1");
      addTelegram("2");
      const checked = service.markChecked("telegram", "1", { ok: false, error: "Открылась страница входа" }, ADMIN);

      assert.equal(checked?.status, "expired");
      assert.equal(checked?.last_error, "Открылась страница входа");
      assert.equal(service.get("telegram", "2")?.is_default, true);
      const [event] = service.events("telegram", "1");
      assert.equal(event.action, "expire");
      assert.equal(event.actor, ADMIN);
    });

    it("keeps the status when the check itself failed (network, timeout)", () => {
      addTelegram("1");
      const checked = service.markChecked("telegram", "1", { ok: false, error: "net::ERR_TIMED_OUT", inconclusive: true });

      assert.equal(checked?.status, "active");
      assert.equal(checked?.is_default, true);
      assert.equal(checked?.last_error, "net::ERR_TIMED_OUT");
      assert.ok(checked?.last_check_at);
      assert.equal(service.events("telegram", "1")[0].action, "upload");
    });

    it("reactivates an expired session that has a login again", () => {
      addTelegram("1");
      service.markExpired("telegram", "1", "login page");
      const checked = service.markChecked("telegram", "1", { ok: true, error: null });

      assert.equal(checked?.status, "active");
      assert.equal(checked?.last_error, null);
      assert.equal(service.events("telegram", "1")[0].action, "reactivate");
    });

    it("does not turn a disabled session back on", () => {
      addTelegram("1");
      service.update("telegram", "1", { status: "disabled" });
      assert.equal(service.markChecked("telegram", "1", { ok: true, error: null })?.status, "disabled");
    });
  });

  describe("delete", () => {
    it("keeps the history of a deleted session and moves the default flag", () => {
      addTelegram("1");
      addTelegram("2");
      assert.equal(service.delete("telegram", "1", ADMIN, "с выходом из аккаунта"), true);

      assert.equal(service.get("telegram", "1"), null);
      assert.deepEqual(service.events("telegram", "1")[0].detail, "с выходом из аккаунта");
      assert.equal(service.get("telegram", "2")?.is_default, true);
      assert.equal(service.delete("telegram", "1"), false);
    });
  });

  describe("summary and events", () => {
    it("counts statuses and names the default session", () => {
      addTelegram("1");
      service.update("telegram", "1", { username: "@one" });
      addTelegram("2");
      service.markExpired("telegram", "2", "x");

      const summary = service.summary();
      assert.deepEqual(summary.telegram, {
        total: 2, active: 1, disabled: 0, expired: 1, default_account_id: "1", default_username: "@one",
      });
      assert.equal(summary.youtube.total, 0);
    });

    it("clamps the events limit", () => {
      addTelegram("1");
      for (let i = 0; i < 5; i++) service.update("telegram", "1", { label: `l${i}` });
      assert.equal(service.events("telegram", "1", 2).length, 2);
      assert.equal(service.events("telegram", "1", 0).length, 1);
    });
  });
});
