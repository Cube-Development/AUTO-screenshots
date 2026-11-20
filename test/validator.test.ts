import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAccountId, findStorageStateProblem, isValidAccountId } from "../src/sessions/sessions.validator";
import { instagramState, telegramState, youtubeState } from "./helpers";

describe("findStorageStateProblem", () => {
  it("accepts a logged in state of each platform", () => {
    assert.equal(findStorageStateProblem("telegram", telegramState(7697061334)), null);
    assert.equal(findStorageStateProblem("instagram", instagramState()), null);
    assert.equal(findStorageStateProblem("youtube", youtubeState()), null);
  });

  it("names what is missing", () => {
    assert.match(findStorageStateProblem("telegram", { cookies: [], origins: [] })!, /user_auth/);
    assert.match(findStorageStateProblem("instagram", { cookies: [], origins: [] })!, /sessionid/);
    assert.match(findStorageStateProblem("youtube", { cookies: [], origins: [] })!, /cookies/i);
  });

  it("treats user_auth=null as logged out", () => {
    const state = telegramState(1);
    state.origins[0].localStorage[0].value = "null";
    assert.match(findStorageStateProblem("telegram", state)!, /user_auth/);
  });
});

describe("isValidAccountId", () => {
  it("requires digits for Telegram", () => {
    assert.equal(isValidAccountId("telegram", "7697061334"), true);
    assert.equal(isValidAccountId("telegram", "lera_zkh"), false);
  });

  it("accepts logins with dots inside but not dots only", () => {
    for (const id of ["legacy", "blogix.ig", "a..b", "user@mail"]) assert.equal(isValidAccountId("instagram", id), true, id);
    for (const id of [".", "..", "...", "bad id", "", "x".repeat(129)]) assert.equal(isValidAccountId("instagram", id), false, id);
  });
});

describe("deriveAccountId", () => {
  it("takes the Telegram account from user_auth, not from the file name", () => {
    assert.equal(deriveAccountId("telegram", "whatever.json", telegramState(7697061334)), "7697061334");
  });

  it("rejects a Telegram file with a non numeric id", () => {
    assert.equal(deriveAccountId("telegram", "a.json", telegramState("abc")), null);
    assert.equal(deriveAccountId("telegram", "a.json", { cookies: [], origins: [] }), null);
  });

  it("takes the Instagram/YouTube account from the file name", () => {
    assert.equal(deriveAccountId("instagram", "instagram_blogix.ig.json", instagramState()), "blogix.ig");
    assert.equal(deriveAccountId("youtube", "C:\\exports\\youtube_channel.JSON", youtubeState()), "channel");
    assert.equal(deriveAccountId("instagram", "blogix.json", instagramState()), "blogix");
  });

  it("refuses names that do not carry an account", () => {
    assert.equal(deriveAccountId("instagram", "auth.json", instagramState()), null);
    assert.equal(deriveAccountId("instagram", "instagram_.json", instagramState()), null);
    assert.equal(deriveAccountId("instagram", "...json", instagramState()), null);
    assert.equal(deriveAccountId("youtube", "my channel.json", youtubeState()), null);
  });
});
