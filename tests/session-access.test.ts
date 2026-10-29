import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { requireAuthorizedSession, SessionAccessError } from "../src/session-access";

let TEST_DB: string;
let scratch: string;

describe("session access", () => {
  let db: StateDB;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-session-access-"));
    TEST_DB = join(scratch, "state.db");
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
    rmSync(scratch, { recursive: true, force: true });
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
