import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Wakeup } from "../src/wakeup";
import { RuntimeLayout } from "../src/runtime-layout";
import { settle } from "../src/settle";

let TEST_DB: string;
let TEST_ARCHIVE: string;
let TEST_TMP: string;
let scratch: string;

describe("settle", () => {
  let db: StateDB;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-settle-"));
    TEST_DB = join(scratch, "state.db");
    TEST_ARCHIVE = join(scratch, "archive");
    TEST_TMP = join(scratch, "tmp");
  });

  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  });

  test("atomically updates DB and writes archive", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: "/tmp", tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);

    db.createSession({ id: "s1", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    await settle(db, archive, wakeup, "s1", "idle", { status: "idle", lastOutput: "done" });

    expect(db.getSession("s1")?.status).toBe("idle");
    const archived = archive.get("s1");
    expect(archived?.status).toBe("idle");
    expect(archived?.lastOutput).toBe("done");
  });

  test("rolls back DB on archive failure", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    db = new StateDB(TEST_DB);
    const badArchive = {
      save() { throw new Error("disk full"); },
      get() { return null; },
    } as unknown as Archive;
    const layout = new RuntimeLayout({ homeDir: "/tmp", tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);

    db.createSession({ id: "s2", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    await expect(settle(db, badArchive, wakeup, "s2", "idle", { status: "idle" })).rejects.toThrow("disk full");

    expect(db.getSession("s2")?.status).toBe("running");
  });

  test("StateDB.transaction rolls back on throw", () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "tx1", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    expect(() => {
      db.transaction(() => {
        db.updateStatus("tx1", "idle");
        throw new Error("boom");
      });
    }).toThrow("boom");

    expect(db.getSession("tx1")?.status).toBe("running");
  });
});
