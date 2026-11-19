import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { StateDB } from "../src/state";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TEST_DB: string;
let scratch: string;

describe("StateDB", () => {
  let db: StateDB;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-state-"));
    TEST_DB = join(scratch, "state.db");
    db = new StateDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
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
    expect(session.safe).toBe(false);

    const found = db.getSession("claude-abc12345");
    expect(found).not.toBeNull();
    expect(found!.task).toBe("Refactor auth module");
  });

  test("persists safe posture", () => {
    const session = db.createSession({
      id: "kimi-safe",
      parentId: "parent-1",
      agentType: "kimi",
      task: "Safe task",
      ownerToken: "tok-safe",
      projectPath: "/tmp/project",
      safe: true,
    });

    expect(session.safe).toBe(true);
    expect(db.getSession("kimi-safe")?.safe).toBe(true);
  });

  test("persists an explicit helper role without inventing one for other sessions", () => {
    db.createSession({ id: "advisor", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp", role: "advisor" });
    db.createSession({ id: "unknown", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    expect(db.getSession("advisor")?.role).toBe("advisor");
    expect(db.getSession("unknown")?.role).toBeNull();
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

});

describe("state schema migrations", () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-state-migration-"));
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
          depth: 1, agentResumeId: null, resumedFrom: null, role: null, model: null, effort: null, safe: false, version: 0, scope: null,
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

  test("adding delivery_root keeps saved sessions in their project and stores a root for new ones", () => {
    const previous = new StateDB(dbPath);
    previous.createSession({ id: "saved", parentId: "p", agentType: "codex", task: "original task", ownerToken: "tok", projectPath: root, role: "worker" });
    const original = previous.getSession("saved");
    previous.close();
    const legacy = new Database(dbPath);
    legacy.exec("ALTER TABLE sessions DROP COLUMN delivery_root");
    legacy.close();

    const migrated = new StateDB(dbPath);
    try {
      expect(migrated.getSession("saved")).toEqual(original);
      expect(migrated.getSession("saved")?.deliveryRoot).toBeNull();
      migrated.createSession({ id: "relocated", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: join(root, "worktree"), deliveryRoot: join(root, "main") });
      expect(migrated.getSession("relocated")).toMatchObject({ projectPath: join(root, "worktree"), deliveryRoot: join(root, "main") });
    } finally {
      migrated.close();
    }
    const reopened = new StateDB(dbPath);
    try {
      expect(reopened.getSession("relocated")?.deliveryRoot).toBe(join(root, "main"));
      expect(reopened.getSession("saved")?.deliveryRoot).toBeNull();
    } finally {
      reopened.close();
    }
  });

  test("adding scope leaves saved sessions without one and stores a scope for new ones", () => {
    const previous = new StateDB(dbPath);
    previous.createSession({ id: "saved", parentId: "p", agentType: "codex", task: "original task", ownerToken: "tok", projectPath: root, role: "worker" });
    const original = previous.getSession("saved");
    previous.close();
    const legacy = new Database(dbPath);
    legacy.exec("ALTER TABLE sessions DROP COLUMN scope");
    legacy.close();

    const migrated = new StateDB(dbPath);
    try {
      expect(migrated.getSession("saved")).toEqual(original);
      expect(migrated.getSession("saved")?.scope).toBeNull();
      migrated.createSession({ id: "scoped", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: root, scope: "src/**,tests/**" });
      expect(migrated.getSession("scoped")?.scope).toBe("src/**,tests/**");
    } finally {
      migrated.close();
    }
    const reopened = new StateDB(dbPath);
    try {
      expect(reopened.getSession("scoped")?.scope).toBe("src/**,tests/**");
      expect(reopened.getSession("saved")?.scope).toBeNull();
    } finally {
      reopened.close();
    }
    const raw = new Database(dbPath);
    try {
      expect((raw.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some((column) => column.name === "scope")).toBe(true);
    } finally {
      raw.close();
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

describe("cross-process row versions", () => {
  let root: string;
  let dbPath: string;
  let db: StateDB;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-version-test-"));
    dbPath = join(root, "state.db");
    db = new StateDB(dbPath);
    db.createSession({ id: "shared", parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function raceWriters(phase: "update" | "cas", expectedVersion: number) {
    const count = 4;
    const gatePath = join(root, `${phase}-gate`);
    const children = Array.from({ length: count }, (_, index) => Bun.spawn([process.execPath, "-e", `
      import { Database } from "bun:sqlite";
      import { existsSync, writeFileSync } from "fs";
      import { StateDB } from ${JSON.stringify(join(import.meta.dir, "../src/state.ts"))};
      const db = new StateDB(${JSON.stringify(dbPath)});
      const prepare = Database.prototype.prepare;
      Database.prototype.prepare = function(sql) {
        if (sql.startsWith("UPDATE sessions SET status =")) {
          // Stop immediately before UPDATE, after any erroneous JS-side read/increment.
          writeFileSync(${JSON.stringify(join(root, `${phase}-ready-${index}`))}, "ready");
          const started = performance.now();
          while (!existsSync(${JSON.stringify(gatePath)})) {
            if (performance.now() - started > 10000) throw new Error("Writer barrier timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          }
        }
        return prepare.call(this, sql);
      };
      try {
        let result;
        // Hold the write lock through reading our version, so a later writer
        // cannot hide an intermediate version from the assertion.
        db.transaction(() => {
          const changed = ${phase === "update"
            ? '(db.updateStatus("shared", "running"), true)'
            : `db.compareAndSetStatus("shared", "running", "running", ${expectedVersion})`};
          result = { changed, version: db.getSession("shared").version };
        });
        console.log(JSON.stringify(result));
      } finally {
        db.close();
      }
    `], { stdout: "pipe", stderr: "pipe" }));
    const outcomes = children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    });

    try {
      const started = performance.now();
      while (!children.every((_, index) => existsSync(join(root, `${phase}-ready-${index}`)))) {
        if (performance.now() - started > 8000) throw new Error("Writers did not reach UPDATE barrier");
        await Bun.sleep(2);
      }
      writeFileSync(gatePath, "go");
      const results = await Promise.all(outcomes);
      expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr })))
        .toEqual(Array.from({ length: count }, () => ({ exitCode: 0, stderr: "" })));
      return results.map(({ stdout }) => JSON.parse(stdout) as { changed: boolean; version: number });
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.allSettled(outcomes);
    }
  }

  test("barrier-released concurrent UPDATEs yield distinct versions and exactly one version CAS winner", async () => {
    const originalVersion = db.getSession("shared")!.version;
    const writes = await raceWriters("update", originalVersion);
    expect(writes.every(({ changed }) => changed)).toBe(true);
    expect(writes.map(({ version }) => version).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4].map((offset) => originalVersion + offset));
    const observedVersion = db.getSession("shared")!.version;
    expect(observedVersion).toBe(originalVersion + writes.length);

    // The status remains running even after a win, so only the version
    // predicate can reject the other writers with the same observed row.
    const attempts = await raceWriters("cas", observedVersion);
    expect(attempts.filter(({ changed }) => changed)).toHaveLength(1);
    expect(attempts.map(({ version }) => version)).toEqual(Array(4).fill(observedVersion + 1));
    expect(db.getSession("shared")?.version).toBe(observedVersion + 1);
  }, 20000);
});
