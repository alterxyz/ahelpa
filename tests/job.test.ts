import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { StateDB } from "../src/state";
import { findWriterConflicts, planLaunch, resolveJobId } from "../src/commands/launch";
import { check, status } from "../src/commands/session-ops";
import { resolveWaitTargets, runCli } from "../src/command-contract";

const TEST_DB = "/tmp/ahelpa-job-test.db";
const TEST_PROJECT = "/tmp/ahelpa-job-test-project";

describe("jobs and writer conflicts", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  function session(id: string, extra: Partial<Parameters<StateDB["createSession"]>[0]> = {}) {
    return db.createSession({ id, parentId: "cli", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT, ...extra });
  }

  test("job id precedence: explicit, then --after's job, then the inherited environment", () => {
    db = new StateDB(TEST_DB);
    session("impl", { jobId: "parser-fix" });
    session("loose");

    expect(resolveJobId(db, "explicit", "impl", { AHELPA_JOB_ID: "env" })).toBe("explicit");
    expect(resolveJobId(db, undefined, "impl", { AHELPA_JOB_ID: "env" })).toBe("parser-fix");
    expect(resolveJobId(db, undefined, "loose", { AHELPA_JOB_ID: "env" })).toBe("env");
    expect(resolveJobId(db, undefined, undefined, { AHELPA_JOB_ID: "" })).toBeNull();
    expect(resolveJobId(db, undefined, undefined, {})).toBeNull();
  });

  test("job ids must be filename-safe", () => {
    db = new StateDB(TEST_DB);
    for (const bad of ["../x", "a/b", ".hidden", "-x", "x".repeat(65), "has space"]) {
      expect(() => resolveJobId(db, bad, undefined, {})).toThrow(/Invalid job id/);
    }
    expect(resolveJobId(db, "fix-42.parser_v2", undefined, {})).toBe("fix-42.parser_v2");
  });

  test("planLaunch records the job and exports it to the helper, empty when there is none", () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    const saved = process.env.AHELPA_JOB_ID;
    process.env.AHELPA_JOB_ID = "inherited-from-host-shell";
    try {
      const withJob = planLaunch({ db, agentType: "codex", task: "t", projectPath: TEST_PROJECT, parentId: "cli", job: "j1" });
      expect(withJob.jobId).toBe("j1");
      expect(withJob.launchCmd).toContain("AHELPA_JOB_ID=");
      expect(withJob.launchCmd).toMatch(/AHELPA_JOB_ID='?j1'?[; ]/);

      delete process.env.AHELPA_JOB_ID;
      const noJob = planLaunch({ db, agentType: "codex", task: "t", projectPath: TEST_PROJECT, parentId: "cli" });
      expect(noJob.jobId).toBeNull();
      expect(noJob.launchCmd).toContain("AHELPA_JOB_ID=''");
      expect(noJob.launchCmd).not.toContain("unset");
    } finally {
      if (saved === undefined) delete process.env.AHELPA_JOB_ID; else process.env.AHELPA_JOB_ID = saved;
    }
  });

  test("check --job lists only that job and reports jobId; status shows a JOB column", () => {
    db = new StateDB(TEST_DB);
    session("a1", { jobId: "alpha" });
    session("a2", { jobId: "alpha", parentId: "a1" });
    session("b1", { jobId: "beta" });
    session("none");

    expect(check(db, undefined, "alpha").map((s) => s.id).sort()).toEqual(["a1", "a2"]);
    expect(check(db, "a1", "alpha").map((s) => s.id)).toEqual(["a2"]);
    expect(check(db).find((s) => s.id === "b1")?.jobId).toBe("beta");
    expect(check(db).find((s) => s.id === "none")?.jobId).toBeNull();

    const view = status(db, true);
    expect(view).toContain("JOB");
    expect(view).toContain("alpha");
  });

  test("wait --job resolves to the job's running sessions and rejects mixing ids with --job", () => {
    db = new StateDB(TEST_DB);
    session("r1", { jobId: "j" });
    session("r2", { jobId: "j" });
    session("done", { jobId: "j" });
    db.updateStatus("done", "idle");
    session("other", { jobId: "k" });

    expect(resolveWaitTargets(db, [], "j").sort()).toEqual(["r1", "r2"]);
    expect(resolveWaitTargets(db, ["x"], undefined)).toEqual(["x"]);
    expect(() => resolveWaitTargets(db, ["r1"], "j")).toThrow(/not both/);
    expect(() => resolveWaitTargets(db, [], undefined)).toThrow(/Usage/);
    db.updateStatus("other", "idle");
    expect(() => resolveWaitTargets(db, [], "k")).toThrow(/no running sessions/);
  });

  test("wait with neither ids nor --job is a usage error at the CLI", async () => {
    db = new StateDB(TEST_DB);
    const errors: string[] = [];
    const code = await runCli(db, ["wait"], { print: () => {}, printError: (text) => errors.push(text) });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--job");
  });

  test("writer conflicts: same, enclosing, or enclosed tree, unless both sides are reviewers", () => {
    db = new StateDB(TEST_DB);
    session("w-same", { role: "worker" });
    session("w-sub", { role: "worker", projectPath: `${TEST_PROJECT}/pkg` });
    session("w-sibling", { role: "worker", projectPath: `${TEST_PROJECT}-worktrees/x` });
    session("rev", { role: "reviewer" });
    session("w-done", { role: "worker" });
    db.updateStatus("w-done", "idle");
    session("w-draining", { role: "worker" });
    db.updateStatus("w-draining", "draining");
    session("w-attn", { role: "worker" });
    db.updateStatus("w-attn", "needs_attention");

    const forWorker = findWriterConflicts(db, TEST_PROJECT, "worker").map((c) => c.sessionId).sort();
    expect(forWorker).toEqual(["rev", "w-attn", "w-same", "w-sub"]);

    const forReviewer = findWriterConflicts(db, TEST_PROJECT, "reviewer").map((c) => c.sessionId).sort();
    expect(forReviewer).toEqual(["w-attn", "w-same", "w-sub"]);

    const inSubdir = findWriterConflicts(db, `${TEST_PROJECT}/pkg/deep`, "worker").map((c) => c.sessionId).sort();
    expect(inSubdir).toEqual(["rev", "w-attn", "w-same", "w-sub"]);
  });

  test("planLaunch reports writer conflicts but still plans; --worktree has none", () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    session("busy", { role: "worker" });

    const plan = planLaunch({ db, agentType: "codex", task: "t", projectPath: TEST_PROJECT, parentId: "cli" });
    expect(plan.writerConflict).toEqual([{ sessionId: "busy", role: "worker", status: "running", projectPath: TEST_PROJECT }]);

    const isolated = planLaunch({ db, agentType: "codex", task: "t", projectPath: TEST_PROJECT, parentId: "cli", worktree: true });
    expect(isolated.writerConflict).toEqual([]);
  });

  test("the launching helper is not reported as its own child's writer conflict", () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    session("delegator", { role: "worker" });
    session("bystander", { role: "worker" });

    const plan = planLaunch({ db, agentType: "codex", task: "t", projectPath: TEST_PROJECT, parentId: "delegator" });
    expect(plan.writerConflict.map((c) => c.sessionId)).toEqual(["bystander"]);
  });

  test("a database created before jobs migrates to a null job", () => {
    db = new StateDB(TEST_DB);
    session("legacy");
    db.close();
    const raw = new Database(TEST_DB);
    raw.exec("ALTER TABLE sessions DROP COLUMN job_id");
    raw.close();

    db = new StateDB(TEST_DB);
    expect(db.getSession("legacy")?.jobId).toBeNull();
    expect(db.listJobSessions("anything")).toEqual([]);
    session("after-migration", { jobId: "j" });
    expect(db.listJobSessions("j").map((s) => s.id)).toEqual(["after-migration"]);
  });
});
