import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { openSessionsDb, runInTransaction } from "../src/sessions/sessions.db";
import { SessionsRepository } from "../src/sessions/sessions.repository";

const tmp = (name: string) => path.join(process.env.TEST_TMP_DIR!, name);

function row(accountId: string, extra: Partial<{ label: string | null; phone: string | null; username: string | null }> = {}) {
  return {
    platform: "instagram" as const, accountId, label: null, phone: null, username: null,
    storageState: Buffer.from("x"), checkedAt: null, ...extra,
  };
}

describe("openSessionsDb", () => {
  it("applies every migration", () => {
    const db = openSessionsDb(tmp("migrate.db"));
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const columns = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);

    assert.equal(user_version, 5);
    assert.ok(tables.includes("sessions") && tables.includes("meta") && tables.includes("session_events"));
    for (const column of ["phone", "username", "success_count", "fail_count", "last_fail_at"]) assert.ok(columns.includes(column), column);
    db.close();
  });

  it("copies the seed only when the database is missing", () => {
    const seedPath = tmp("seed.db");
    const seed = openSessionsDb(seedPath);
    new SessionsRepository(seed).upsert(row("from-seed"));
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed.close();

    const fromSeed = openSessionsDb(tmp("from-seed.db"), seedPath);
    assert.ok(new SessionsRepository(fromSeed).get("instagram", "from-seed"));
    fromSeed.close();

    const existing = openSessionsDb(tmp("existing.db"));
    existing.close();
    const reopened = openSessionsDb(tmp("existing.db"), seedPath);
    assert.equal(new SessionsRepository(reopened).get("instagram", "from-seed"), null);
    reopened.close();
  });
});

describe("runInTransaction", () => {
  it("runs nested calls inside the outer transaction and rolls everything back on error", () => {
    const db = openSessionsDb(tmp("tx.db"));
    const repository = new SessionsRepository(db);

    assert.throws(() =>
      runInTransaction(db, () => {
        repository.upsert(row("outer"));
        runInTransaction(db, () => repository.upsert(row("inner")));
        throw new Error("boom");
      }),
    );
    assert.equal(repository.list().length, 0);

    runInTransaction(db, () => {
      repository.upsert(row("outer"));
      runInTransaction(db, () => repository.upsert(row("inner")));
    });
    assert.equal(repository.list().length, 2);
    db.close();
  });
});

describe("SessionsRepository", () => {
  const fresh = (name: string) => new SessionsRepository(openSessionsDb(tmp(name)));

  it("keeps stored account data on a replacement when nothing new is given", () => {
    const repository = fresh("upsert.db");
    repository.upsert(row("a", { label: "Резерв", phone: "+998901234567", username: "@a" }));
    repository.markStatus("instagram", "a", "expired", "login page");
    repository.upsert(row("a"));

    const stored = repository.get("instagram", "a")!;
    assert.equal(stored.label, "Резерв");
    assert.equal(stored.phone, "+998901234567");
    assert.equal(stored.status, "active");
    assert.equal(stored.last_error, null);
  });

  it("updates only given fields and clears with null", () => {
    const repository = fresh("update.db");
    repository.upsert(row("a", { label: "x", phone: "+998901234567" }));
    repository.update("instagram", "a", { label: null, username: "@a" });

    const stored = repository.get("instagram", "a")!;
    assert.equal(stored.label, null);
    assert.equal(stored.phone, "+998901234567");
    assert.equal(stored.username, "@a");
  });

  it("keeps a single default session per platform", () => {
    const repository = fresh("default.db");
    repository.upsert(row("a"));
    repository.upsert(row("b"));
    repository.setDefault("instagram", "a", true);
    repository.setDefault("instagram", "b", true);

    assert.deepEqual(repository.list("instagram").filter((r) => r.is_default === 1).map((r) => r.account_id), ["b"]);
    assert.equal(repository.listActive("instagram")[0].account_id, "b");
  });

  it("counts screenshot results", () => {
    const repository = fresh("counters.db");
    repository.upsert(row("a"));
    repository.recordResult("instagram", "a", true);
    repository.recordResult("instagram", "a", true);
    repository.recordResult("instagram", "a", false);

    const stored = repository.get("instagram", "a")!;
    assert.equal(stored.success_count, 2);
    assert.equal(stored.fail_count, 1);
    assert.ok(stored.last_fail_at);
  });

  it("lists events newest first and moves them with a rename", () => {
    const repository = fresh("events.db");
    repository.addEvent({ platform: "instagram", account_id: "a", action: "upload", actor: null, detail: null });
    repository.addEvent({ platform: "instagram", account_id: "a", action: "update", actor: "admin@x", detail: "label" });
    repository.renameEvents("instagram", "a", "b");

    assert.deepEqual(repository.listEvents("instagram", "a", 10), []);
    assert.deepEqual(repository.listEvents("instagram", "b", 10).map((e) => e.action), ["update", "upload"]);
    assert.equal(repository.listEvents("instagram", "b", 1).length, 1);
  });

  it("backs up into a separate database even with a quote in the path", () => {
    const repository = fresh("backup-src.db");
    repository.upsert(row("a"));
    const target = tmp("it's-backup.db");
    repository.backupTo(target);

    assert.ok(fs.existsSync(target));
    assert.ok(new SessionsRepository(openSessionsDb(target)).get("instagram", "a"));
  });
});
