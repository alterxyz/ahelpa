import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";

describe("state schema migrations", () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/ahelpa-state-migration-");
    dbPath = join(root, "state.db");
  });

  afterEach(() => {
    mock.restore();
    rmSync(root, { recursive: true, force: true });
  });

  function createLegacyDatabase(): void {
    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          tmux_session TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_token TEXT NOT NULL,
          project_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          label TEXT
        )
      `);
      legacy.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("legacy", "parent", "codex", "legacy-terminal", "synthetic saved task", "idle", "test-token", root,
          "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "saved label");
    } finally {
      legacy.close();
    }
  }

  test.each(["new", "legacy"])("concurrent processes initialize a %s database without losing records", async (kind) => {
    if (kind === "legacy") createLegacyDatabase();
    const workers = 8;
    const gatePath = join(root, "start");
    const modulePath = join(import.meta.dir, "../src/state.ts");
    const children = Array.from({ length: workers }, (_, index) => Bun.spawn([process.execPath, "-e", `
      import { existsSync, writeFileSync } from "fs";
      import { StateDB } from ${JSON.stringify(modulePath)};
      writeFileSync(${JSON.stringify(join(root, `ready-${index}`))}, "ready");
      const deadline = Date.now() + 10000;
      while (!existsSync(${JSON.stringify(gatePath)})) {
        if (Date.now() >= deadline) throw new Error("Migration test barrier timed out");
        await Bun.sleep(5);
      }
      const db = new StateDB(${JSON.stringify(dbPath)});
      try {
        db.createSession({
          id: "worker-${index}", parentId: "parent", agentType: "codex",
          task: "synthetic concurrent task", ownerToken: "test-token",
          projectPath: ${JSON.stringify(root)}, role: "worker", model: "test-model", effort: "high", safe: true,
        });
      } finally {
        db.close();
      }
    `], { stdout: "pipe", stderr: "pipe" }));
    const outcomes = children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    });

    try {
      const deadline = Date.now() + 5000;
      while (!children.every((_, index) => existsSync(join(root, `ready-${index}`)))) {
        if (Date.now() >= deadline) throw new Error("Migration workers did not become ready");
        await Bun.sleep(5);
      }
      writeFileSync(gatePath, "start");
      expect(await Promise.all(outcomes)).toEqual(Array.from({ length: workers }, () => ({
        exitCode: 0, stdout: "", stderr: "",
      })));
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.allSettled(outcomes);
    }

    const db = new StateDB(dbPath);
    try {
      expect(db.listSessions()).toHaveLength(workers + (kind === "legacy" ? 1 : 0));
      for (let index = 0; index < workers; index++) {
        expect(db.getSession(`worker-${index}`)).toMatchObject({ role: "worker", model: "test-model", effort: "high", safe: true, depth: 1, version: 0 });
      }
      if (kind === "legacy") {
        expect(db.getSession("legacy")).toMatchObject({
          task: "synthetic saved task", status: "idle", ownerToken: "test-token", projectPath: root,
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", label: "saved label",
          depth: 1, agentResumeId: null, resumedFrom: null, role: null, model: null, effort: null, safe: false, version: 0,
        });
      }
    } finally {
      db.close();
    }
  }, 15000);

  test("adding role to an existing modern schema preserves its saved model and permission settings", () => {
    const previous = new StateDB(dbPath);
    previous.createSession({ id: "saved", parentId: "p", agentType: "codex", task: "original task", ownerToken: "tok", projectPath: root,
      model: "saved-model", effort: "low", safe: true, depth: 2 });
    previous.updateResumeId("saved", "saved-resume-token");
    const original = previous.getSession("saved");
    previous.close();
    const legacy = new Database(dbPath);
    legacy.exec("ALTER TABLE sessions DROP COLUMN role");
    legacy.close();

    const migrated = new StateDB(dbPath);
    try {
      expect(migrated.getSession("saved")).toEqual(original);
      expect(migrated.getSession("saved")?.role).toBeNull();
    } finally {
      migrated.close();
    }
  });

  test("adding a version preserves existing records and reopening preserves subsequent increments", () => {
    const previous = new StateDB(dbPath);
    previous.createSession({ id: "saved", parentId: "p", agentType: "codex", task: "original task", ownerToken: "tok", projectPath: root,
      role: "worker", model: "saved-model", effort: "low", safe: true });
    previous.updateStatus("saved", "error");
    const original = previous.getSession("saved")!;
    previous.close();
    const legacy = new Database(dbPath);
    legacy.exec("ALTER TABLE sessions DROP COLUMN version");
    legacy.close();

    const migrated = new StateDB(dbPath);
    try {
      expect(migrated.getSession("saved")).toEqual({ ...original, version: 0 });
      expect(migrated.compareAndSetStatus("saved", "error", "running", 0)).toBe(true);
      expect(migrated.getSession("saved")?.version).toBe(1);
    } finally {
      migrated.close();
    }
    const reopened = new StateDB(dbPath);
    try {
      expect(reopened.getSession("saved")?.version).toBe(1);
      expect(reopened.compareAndSetStatus("saved", "running", "error", 0)).toBe(false);
      expect(reopened.compareAndSetStatus("saved", "running", "error", 1)).toBe(true);
      expect(reopened.getSession("saved")?.version).toBe(2);
    } finally {
      reopened.close();
    }
  });

  test("failed migration rolls back earlier schema changes and closes its database handle", () => {
    createLegacyDatabase();
    const execute = Database.prototype.exec;
    const failure = new Error("synthetic migration failure");
    spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("ADD COLUMN resumed_from")) throw failure;
      return execute.call(this, sql);
    });
    const close = spyOn(Database.prototype, "close");

    expect(() => new StateDB(dbPath)).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
    mock.restore();

    const legacy = new Database(dbPath);
    try {
      const columns = legacy.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("tmux_session");
      expect(columns.map((column) => column.name)).not.toContain("depth");
      expect(legacy.prepare("SELECT task FROM sessions WHERE id = ?").get("legacy"))
        .toEqual({ task: "synthetic saved task" });
    } finally {
      legacy.close();
    }
  });
});
