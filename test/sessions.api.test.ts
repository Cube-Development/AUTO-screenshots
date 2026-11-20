import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { sessionsRouter } from "../src/modules/sessions";
import { sessionsService } from "../src/services";
import { instagramState, resetSessions, telegramState } from "./helpers";

const ADMIN = "admin@blogix.uz";
let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/sessions${path}`, {
    method,
    headers: { "X-API-Key": process.env.SERVER_API_KEY!, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("sessions API", () => {
  before(async () => {
    const app = express();
    app.use("/sessions", sessionsRouter);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => resetSessions(sessionsService));

  it("requires the API key", async () => {
    const response = await fetch(`${baseUrl}/sessions`);
    assert.equal(response.status, 401);
  });

  it("validates the platform and the account", async () => {
    assert.equal((await call("GET", "/?platform=tiktok")).status, 422);
    // В URL «..» не дойдёт до роута (URL сам схлопывает сегмент), а в теле PATCH — дойдёт
    await call("PUT", "/instagram/blogix", { storage_state: instagramState(), verify: false });
    const dots = await call("PATCH", "/instagram/blogix", { account_id: ".." });
    assert.equal(dots.status, 422);
    assert.equal(dots.body.code, 1010);
    assert.equal((await call("PUT", "/telegram/not-digits", { storage_state: telegramState(1), verify: false })).body.code, 1010);
  });

  it("uploads, edits and keeps the history with the admin", async () => {
    const put = await call("PUT", "/telegram/7697061334", {
      storage_state: telegramState(7697061334), verify: false, username: "lera", phone: "+998901234567",
    }, { "X-Admin-Email": ADMIN });
    assert.equal(put.status, 200);
    assert.equal(put.body.data.username, "@lera");
    assert.equal(put.body.data.is_default, true);
    assert.equal("storage_state" in put.body.data, false);

    const patch = await call("PATCH", "/telegram/7697061334", { label: "Резерв", phone: null }, { "X-Admin-Email": ADMIN });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.data.label, "Резерв");
    assert.equal(patch.body.data.phone, null);

    const events = await call("GET", "/telegram/7697061334/events?limit=10");
    assert.deepEqual(events.body.data.map((e: { action: string; actor: string }) => [e.action, e.actor]), [
      ["update", ADMIN],
      ["upload", ADMIN],
    ]);
  });

  it("rejects a static problem of the uploaded file", async () => {
    const response = await call("PUT", "/instagram/blogix", { storage_state: { cookies: [], origins: [] }, verify: false });
    assert.equal(response.status, 422);
    assert.equal(response.body.message, "SESSION_INVALID_STATE");
  });

  it("answers 409 on a rename onto an existing session and 422 for an inactive default", async () => {
    for (const id of ["1", "2"]) await call("PUT", `/telegram/${id}`, { storage_state: telegramState(id), verify: false });

    const rename = await call("PATCH", "/telegram/1", { account_id: "2" });
    assert.equal(rename.status, 409);
    assert.equal(rename.body.code, 1013);

    await call("PATCH", "/telegram/2", { status: "disabled" });
    const makeDefault = await call("PATCH", "/telegram/2", { is_default: true });
    assert.equal(makeDefault.status, 422);
    assert.equal(makeDefault.body.code, 1010);
  });

  it("imports several files with a result per file", async () => {
    const response = await call("POST", "/telegram/import", {
      verify: false,
      files: [
        { name: "any-name.json", storage_state: telegramState(7697061334) },
        { name: "bad-id.json", storage_state: telegramState("abc") },
        { name: "broken.json", storage_state: { foo: 1 } },
      ],
    }, { "X-Admin-Email": ADMIN });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items.map((i: { name: string; ok: boolean; account_id: string | null }) => [i.name, i.ok, i.account_id]), [
      ["any-name.json", true, "7697061334"],
      ["bad-id.json", false, null],
      ["broken.json", false, null],
    ]);
    assert.equal(sessionsService.events("telegram", "7697061334")[0].actor, ADMIN);
  });

  it("limits the number of imported files", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.json`, storage_state: instagramState() }));
    assert.equal((await call("POST", "/instagram/import", { verify: false, files })).status, 422);
  });

  it("skips the logout of an already expired session and still deletes it", async () => {
    await call("PUT", "/instagram/blogix", { storage_state: instagramState(), verify: false });
    sessionsService.markExpired("instagram", "blogix", "login page");

    const response = await call("DELETE", "/instagram/blogix?logout=true", undefined, { "X-Admin-Email": ADMIN });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { logout: null });
    const [event] = sessionsService.events("instagram", "blogix");
    assert.deepEqual([event.action, event.actor, event.detail], ["delete", ADMIN, "выход пропущен: сессия уже разлогинена"]);
  });

  it("deletes without a logout and answers 404 for an unknown session", async () => {
    await call("PUT", "/instagram/blogix", { storage_state: instagramState(), verify: false });
    assert.deepEqual((await call("DELETE", "/instagram/blogix")).body, { success: true, data: { logout: null } });
    assert.equal((await call("DELETE", "/instagram/blogix")).status, 404);
  });

  it("returns the summary with backup and check times", async () => {
    await call("PUT", "/telegram/1", { storage_state: telegramState(1), verify: false });
    const response = await call("GET", "/summary");

    assert.equal(response.status, 200);
    assert.equal(response.body.data.platforms.telegram.total, 1);
    assert.ok("last_backup_at" in response.body.data);
    assert.ok("last_check_all_at" in response.body.data);
    assert.equal(response.body.data.active_logins, 0);
  });

  it("checks the login input before opening a browser", async () => {
    assert.equal((await call("POST", "/youtube/login", {})).body.code, 1016);
    assert.equal((await call("POST", "/telegram/login", {})).body.code, 1016);
    assert.equal((await call("POST", "/instagram/login", { method: "qr" })).body.code, 1016);
    assert.equal((await call("POST", "/instagram/login", { username: "blogix" })).body.code, 1016);
  });

  it("answers LOGIN_NOT_FOUND for an unknown login and 422 for a malformed id", async () => {
    const unknown = await call("GET", "/login/00000000-0000-4000-8000-000000000000");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 1014);
    assert.equal((await call("GET", "/login/not-a-uuid")).status, 422);
  });
});
