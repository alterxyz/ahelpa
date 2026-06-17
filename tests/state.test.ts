import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StateDB } from "../src/state";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/ahelpa-test.db";

describe("StateDB", () => {
  let db: StateDB;

  beforeEach(() => {
    db = new StateDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  test("creates session and retrieves it", () => {
    const session = db.createSession({
      id: "claude-abc12345",
      parentId: "parent-1",
      agentType: "claude-code",
      task: "Refactor auth module",
      ownerToken: "tok-abcdef1234567890",
      projectPath: "/tmp/project",
      label: "auth-refactor",
    });
    expect(session.id).toBe("claude-abc12345");
    expect(session.status).toBe("running");

    const found = db.getSession("claude-abc12345");
    expect(found).not.toBeNull();
    expect(found!.task).toBe("Refactor auth module");
  });

  test("updates session status", () => {
    db.createSession({
      id: "claude-abc12345", parentId: "parent-1", agentType: "claude-code",
      task: "Test task",
      ownerToken: "tok-abcdef1234567890", projectPath: "/tmp/project",
    });
    db.updateStatus("claude-abc12345", "idle");
    const s = db.getSession("claude-abc12345");
    expect(s!.status).toBe("idle");
  });

  test("lists sessions by parent", () => {
    db.createSession({ id: "s1", parentId: "p1", agentType: "claude-code", task: "t1", ownerToken: "tok1", projectPath: "/tmp" });
    db.createSession({ id: "s2", parentId: "p2", agentType: "codex", task: "t2", ownerToken: "tok2", projectPath: "/tmp" });
    expect(db.listSessions("p1")).toHaveLength(1);
    expect(db.listSessions()).toHaveLength(2);
  });

  test("lists active sessions (running status only)", () => {
    db.createSession({ id: "s1", parentId: "p1", agentType: "claude-code", task: "t1", ownerToken: "tok1", projectPath: "/tmp" });
    db.createSession({ id: "s2", parentId: "p1", agentType: "codex", task: "t2", ownerToken: "tok2", projectPath: "/tmp" });
    db.updateStatus("s2", "dead");
    const active = db.listActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("s1");
  });

  test("lists sessions most recently updated first", async () => {
    db.createSession({ id: "older", parentId: "p1", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.createSession({ id: "newer", parentId: "p1", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    await Bun.sleep(5);
    db.updateStatus("older", "idle");

    expect(db.listSessions().map((session) => session.id)).toEqual(["older", "newer"]);
  });

  test("deletes sessions by status", () => {
    db.createSession({ id: "s1", parentId: "p1", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.createSession({ id: "s2", parentId: "p1", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("s2", "dead");

    expect(db.deleteSessionsByStatus("dead")).toBe(1);
    expect(db.getSession("s2")).toBeNull();
    expect(db.getSession("s1")).not.toBeNull();
  });

  test("drops the legacy tmux_session column from existing databases", () => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }

    const legacy = new Database(TEST_DB);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        tmux_session TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        owner_token TEXT NOT NULL,
        project_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        label TEXT
      )
    `);
    legacy.exec(`
      INSERT INTO sessions (id, parent_id, agent_type, tmux_session, task, status, owner_token, project_path, created_at, updated_at)
      VALUES ('old-1', 'p1', 'codex', 'old-1', 't', 'running', 'tok', '/tmp', '2026-01-01', '2026-01-01')
    `);
    legacy.close();

    db = new StateDB(TEST_DB);
    expect(db.getSession("old-1")?.id).toBe("old-1");
    db.createSession({ id: "new-1", parentId: "p1", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    expect(db.getSession("new-1")).not.toBeNull();
  });
});
