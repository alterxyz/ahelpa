import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StateDB } from "../src/state";
import { status } from "../src/commands/session-ops";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/ahelpa-status-test.db";

describe("status", () => {
  let db: StateDB;

  beforeEach(() => {
    db = new StateDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  test("shows nesting depth and parent session in the status view", () => {
    db.createSession({
      id: "root-session",
      parentId: "cli-root",
      agentType: "claude-code",
      task: "root",
      ownerToken: "tok-root",
      projectPath: "/tmp",
    });
    db.createSession({
      id: "child-session",
      parentId: "root-session",
      agentType: "codex",
      task: "child",
      ownerToken: "tok-child",
      projectPath: "/tmp",
      label: "nested",
    });

    const output = status(db, true);

    expect(output).toContain("DEPTH");
    expect(output).toContain("PARENT");
    expect(output).toContain("child-session");
    expect(output).toContain("root-session");
    expect(output).toContain("nested");
  });
});
