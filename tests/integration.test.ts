import { describe, test, expect, afterAll } from "bun:test";
import { StateDB } from "../src/state";
import { launch } from "../src/commands/launch";
import { check } from "../src/commands/session-ops";
import { capture } from "../src/commands/session-ops";
import { kill } from "../src/commands/session-ops";
import { Tmux } from "../src/tmux";
import { rmSync, rmdirSync, unlinkSync } from "fs";
import { join } from "path";

const TEST_DB = "/tmp/ahelpa-integration-test.db";
// The repository root is a stable Claude workspace. Random temporary projects
// leave orphaned workspace-trust paths and can stall on the trust menu.
const TEST_PROJECT = join(import.meta.dir, "..");
const createdSessions: string[] = [];

describe("integration", () => {
  let db: StateDB;

  afterAll(async () => {
    for (const id of createdSessions) {
      try { await Tmux.kill(id); } catch {}
    }
    db?.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
    for (const id of createdSessions) {
      rmSync(join(TEST_PROJECT, ".ahelpa", id), { recursive: true, force: true });
    }
    try { rmdirSync(join(TEST_PROJECT, ".ahelpa")); } catch {}
  });

  test("full lifecycle: launch → check → capture → kill", async () => {
    db = new StateDB(TEST_DB);

    // Launch
    const result = await launch({
      db,
      agentType: "claude-code",
      task: "echo 'hello from helper'",
      projectPath: TEST_PROJECT,
      parentId: "integration-test",
    });
    createdSessions.push(result.sessionId);

    expect(result.sessionId).toMatch(/^claude-/);
    expect(result.ownerToken).toBeDefined();

    // Check
    const sessions = check(db);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const found = sessions.find(s => s.id === result.sessionId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("running");

    // Wait for tmux to have some output
    await Bun.sleep(3000);

    // Capture
    const output = await capture(db, result.sessionId, result.ownerToken);
    expect(typeof output).toBe("string");

    // Kill
    await kill(db, result.sessionId, result.ownerToken);
    const afterKill = db.getSession(result.sessionId);
    expect(afterKill!.status).toBe("dead");

    // Verify tmux session is gone
    const alive = await Tmux.hasSession(result.sessionId);
    expect(alive).toBe(false);
  }, 45000);
});
