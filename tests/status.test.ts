import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StateDB } from "../src/state";
import { status } from "../src/commands/session-ops";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TEST_DB: string;
let scratch: string;

describe("status", () => {
  let db: StateDB;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-status-"));
    TEST_DB = join(scratch, "state.db");
    db = new StateDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
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
      role: "worker",
    });

    const output = status(db, true);

    expect(output).toContain("DEPTH");
    expect(output).toContain("ROLE");
    expect(output).toContain("worker");
    expect(output).toContain("PARENT");
    expect(output).toContain("child-session");
    expect(output).toContain("root-session");
    expect(output).toContain("nested");
  });
});
