import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findStorageStateProblem, deriveAccountId } from "../src/sessions/sessions.validator";
import { telegramAccountIdFromStorage } from "../src/sessions/telegram-auth";
import type { TStorageState } from "../src/type";

const entry = (name: string, value: unknown) => ({ name, value: JSON.stringify(value) });

/** Свежий вход нового Web K: только слоты аккаунтов, без user_auth */
const newWebKState: TStorageState = {
  cookies: [],
  origins: [{
    origin: "https://web.telegram.org",
    localStorage: [
      entry("account1", { userId: "7697061334", dcId: 2 }),
      entry("account2", { sign_in_dc_id: 2 }),
      entry("number_of_accounts", 1),
    ],
  }],
};

describe("telegramAccountIdFromStorage", () => {
  it("reads the old user_auth", () => {
    assert.equal(telegramAccountIdFromStorage([entry("user_auth", { dcID: 2, id: 7697061334 })]), "7697061334");
  });

  it("reads the account slots of the new Web K, skipping empty ones", () => {
    assert.equal(telegramAccountIdFromStorage([entry("account1", { sign_in_dc_id: 2 }), entry("account2", { userId: "42" })]), "42");
  });

  it("prefers user_auth when both are present", () => {
    assert.equal(telegramAccountIdFromStorage([entry("account1", { userId: "2" }), entry("user_auth", { id: 1 })]), "1");
  });

  it("is null when nobody is logged in or the value is broken", () => {
    assert.equal(telegramAccountIdFromStorage([]), null);
    assert.equal(telegramAccountIdFromStorage([{ name: "user_auth", value: "null" }]), null);
    assert.equal(telegramAccountIdFromStorage([{ name: "user_auth", value: "{broken" }]), null);
    assert.equal(telegramAccountIdFromStorage([entry("account1", { userId: "" })]), null);
  });
});

describe("a session file of the new Web K", () => {
  it("passes the static check and gives its account", () => {
    assert.equal(findStorageStateProblem("telegram", newWebKState), null);
    assert.equal(deriveAccountId("telegram", "auth.json", newWebKState), "7697061334");
  });
});
