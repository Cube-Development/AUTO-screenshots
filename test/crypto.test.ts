import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { decryptState, encryptState } from "../src/sessions/sessions.crypto";
import { telegramState } from "./helpers";

const KEY = crypto.randomBytes(32);

describe("sessions crypto", () => {
  it("round-trips a storageState", () => {
    const state = telegramState(7697061334);
    assert.deepEqual(decryptState(encryptState(state, KEY), KEY), state);
  });

  it("uses a fresh IV every time", () => {
    const state = telegramState(1);
    assert.notDeepEqual(encryptState(state, KEY), encryptState(state, KEY));
  });

  it("does not decrypt with another key", () => {
    const blob = encryptState(telegramState(1), KEY);
    assert.throws(() => decryptState(blob, crypto.randomBytes(32)));
  });

  it("detects a tampered blob", () => {
    const blob = encryptState(telegramState(1), KEY);
    blob[blob.length - 1] ^= 0xff;
    assert.throws(() => decryptState(blob, KEY));
  });
});
