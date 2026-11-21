import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginStartSchema } from "../src/modules/sessions/dto";

const username = (value: string) => LoginStartSchema.safeParse({ username: value, password: "x" });

describe("LoginStartSchema.username (Instagram)", () => {
  it("accepts login, email and phone", () => {
    assert.equal(username("@blogix.ig").data?.username, "blogix.ig");
    assert.equal(username("someone@gmail.com").data?.username, "someone@gmail.com");
    assert.equal(username("+998 90 123-45-67").success, true);
  });

  it("rejects garbage", () => {
    assert.equal(username("two words").success, false);
    assert.equal(username("a@b").success, false);
    assert.equal(username("x".repeat(31)).success, false);
  });
});
