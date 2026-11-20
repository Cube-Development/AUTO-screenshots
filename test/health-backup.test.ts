import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { SessionsBackup } from "../src/sessions/sessions.backup";
import { SessionsHealth } from "../src/sessions/sessions.health";
import { SessionsService } from "../src/sessions/sessions.service";
import { instagramState, offlineBrowser, resetSessions, telegramState } from "./helpers";

const service = SessionsService.getInstance();

describe("SessionsHealth", () => {
  beforeEach(() => {
    resetSessions(service);
    service.upsert("telegram", "1", telegramState(1), { verified: true });
    service.upsert("instagram", "a", instagramState(), { verified: true });
  });

  it("does not expire sessions when the platform is unreachable", async () => {
    const health = new SessionsHealth(async () => offlineBrowser(), service);
    const result = await health.checkAll();

    assert.equal(result.checked, 2);
    assert.equal(result.active, 0);
    assert.equal(result.expired, 0);
    assert.ok(result.items.every((item) => item.inconclusive && !item.ok));
    assert.equal(service.get("telegram", "1")?.status, "active");
    assert.equal(service.get("telegram", "1")?.is_default, true);
    assert.match(service.get("instagram", "a")!.last_error!, /ERR_INTERNET_DISCONNECTED/);
  });

  it("records the full check time only for a check of every platform", async () => {
    const health = new SessionsHealth(async () => offlineBrowser(), service);

    await health.checkAll("telegram");
    assert.equal(health.lastCheckAllAt, null);

    await health.checkAll();
    assert.ok(health.lastCheckAllAt);
  });

  it("joins a running full check and trims its result to the asked platform", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const health = new SessionsHealth(async () => {
      await gate;
      return offlineBrowser();
    }, service);

    const all = health.checkAll();
    const onlyTelegram = health.checkAll("telegram");
    release();

    assert.equal((await all).checked, 2);
    const trimmed = await onlyTelegram;
    assert.deepEqual(trimmed.items.map((item) => item.platform), ["telegram"]);
  });

  it("runs its own full check after a single platform check", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let runs = 0;
    const health = new SessionsHealth(async () => {
      runs++;
      if (runs === 1) await gate;
      return offlineBrowser();
    }, service);

    const telegramOnly = health.checkAll("telegram");
    const all = health.checkAll();
    release();

    assert.equal((await telegramOnly).checked, 1);
    assert.equal((await all).checked, 2);
    assert.equal(runs, 2);
  });
});

describe("SessionsBackup", () => {
  const dir = process.env.SESSIONS_BACKUP_DIR!;

  beforeEach(() => {
    resetSessions(service);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a daily copy and remembers when", async () => {
    service.upsert("telegram", "1", telegramState(1), { verified: true });
    const backup = new SessionsBackup(service, dir, 2);

    const file = await backup.run();
    assert.match(path.basename(file), /^sessions-\d{8}\.db$/);
    assert.ok(fs.statSync(file).size > 0);
    assert.ok(backup.lastBackupAt);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });

  it("keeps only the newest copies and leaves other files alone", async () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["sessions-20200101.db", "sessions-20200102.db", "sessions-20200103.db", "notes.txt"]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }

    const file = await new SessionsBackup(service, dir, 2).run();
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ["notes.txt", "sessions-20200103.db", path.basename(file)].sort());
  });
});
