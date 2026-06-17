import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { StateDB } from "../src/state";
import { requireAuthorizedSession, SessionAccessError } from "../src/session-access";

const TEST_DB = "/tmp/ahelpa-session-access-test.db";

describe("session access", () => {
  let db: StateDB;

  beforeEach(() => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "session-1",
      parentId: "parent",
      agentType: "codex",
      task: "task",
      ownerToken: "correct",
      projectPath: "/tmp",
    });
  });

  afterEach(() => {
    db.close();
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
  });

  test("returns the session for the owner token", () => {
    const session = requireAuthorizedSession(db, "session-1", "correct");
    expect(session.id).toBe("session-1");
  });

  test("rejects invalid tokens with one error code", () => {
    expect(() => requireAuthorizedSession(db, "session-1", "wrong")).toThrow(SessionAccessError);

    try {
      requireAuthorizedSession(db, "session-1", "wrong");
    } catch (error) {
      expect((error as SessionAccessError).code).toBe("INVALID_TOKEN");
    }
  });

  test("rejects missing sessions with one error code", () => {
    try {
      requireAuthorizedSession(db, "missing", "correct");
    } catch (error) {
      expect((error as SessionAccessError).code).toBe("SESSION_NOT_FOUND");
    }
  });
});
