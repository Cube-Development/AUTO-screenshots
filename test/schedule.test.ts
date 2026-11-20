import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { msUntilTashkentHour } from "../src/sessions/sessions.schedule";

const DAY_MS = 24 * 60 * 60_000;

describe("msUntilTashkentHour", () => {
  afterEach(() => mock.timers.reset());

  it("waits until the hour in Tashkent (UTC+5)", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 20, 20, 0) }); // 01:00 Tashkent
    assert.equal(msUntilTashkentHour(4), 3 * 60 * 60_000);
  });

  it("moves to the next day when the hour has passed or is now", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 20, 23, 0) }); // 04:00 Tashkent
    assert.equal(msUntilTashkentHour(4), DAY_MS);
  });

  it("always waits more than zero and at most a day", () => {
    for (let hour = 0; hour < 24; hour++) {
      const delay = msUntilTashkentHour(hour);
      assert.ok(delay > 0 && delay <= DAY_MS, String(hour));
    }
  });
});
