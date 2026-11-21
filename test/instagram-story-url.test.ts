import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInstagramStoryUrl } from "../src/screenshot/instagram.utils";

describe("parseInstagramStoryUrl", () => {
  it("reads user and story id from a share link", () => {
    assert.deepEqual(
      parseInstagramStoryUrl("https://www.instagram.com/stories/some.user_1/4034805478874137517/?utm_source=ig_story_item_share&igsh=abc"),
      { username: "some.user_1", storyId: "4034805478874137517" },
    );
    assert.deepEqual(parseInstagramStoryUrl("https://www.instagram.com/stories/someuser/4034805478874137517"), {
      username: "someuser",
      storyId: "4034805478874137517",
    });
  });

  it("accepts a link to the account's current stories", () => {
    assert.deepEqual(parseInstagramStoryUrl("https://www.instagram.com/stories/someuser/"), { username: "someuser", storyId: null });
  });

  it("ignores posts, reels and garbage", () => {
    assert.equal(parseInstagramStoryUrl("https://www.instagram.com/p/Df-eXldGxRb/"), null);
    assert.equal(parseInstagramStoryUrl("https://www.instagram.com/reel/Df2aGgPtPZQ/?igsh=x"), null);
    assert.equal(parseInstagramStoryUrl("https://www.instagram.com/someuser/p/Df-eXldGxRb/"), null);
    assert.equal(parseInstagramStoryUrl("not a url"), null);
  });
});
