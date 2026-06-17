import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StateDB } from "../src/state";
import { check } from "../src/commands/session-ops";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/ahelpa-check-test.db";

describe("check", () => {
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

  test("includes nesting depth and lineage metadata", () => {
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
    });
    db.createSession({
      id: "grandchild-session",
      parentId: "child-session",
      agentType: "codex",
      task: "grandchild",
      ownerToken: "tok-grandchild",
      projectPath: "/tmp",
    });

    const sessions = check(db);
    const grandchild = sessions.find((session) => session.id === "grandchild-session");

    expect(grandchild).toBeDefined();
    expect(grandchild!.depth).toBe(3);
    expect(grandchild!.parentSessionId).toBe("child-session");
    expect(grandchild!.rootSessionId).toBe("root-session");
    expect(grandchild!.lineage).toEqual(["root-session", "child-session", "grandchild-session"]);
  });
});
