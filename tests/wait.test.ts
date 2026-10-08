import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "fs";
import { StateDB } from "../src/state";
import { wait } from "../src/commands/wait";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";

const TEST_DB = "/tmp/ahelpa-wait-test.db";

describe("wait", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
  });

  test("falls back to inline session refresh when the daemon is not running", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "wait-session",
      parentId: "cli-root",
      agentType: "claude-code",
      task: "wait task",
      ownerToken: "tok-wait",
      projectPath: "/tmp",
    });

    spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:DONE]");
    spyOn(Tmux, "sendKeys").mockResolvedValue();

    const result = await wait(db, ["wait-session"], false, 50);

    expect(result).toEqual({
      sessionId: "wait-session",
      status: "idle",
      evidence: expect.objectContaining({ summaryBytes: 0 }),
    });
    expect(db.getSession("wait-session")?.status).toBe("draining");
  });

  test("returns dead for a missing (reaped) session immediately", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    const result = await wait(db, ["missing-session"], false, 50000);

    expect(result).toEqual({
      sessionId: "missing-session",
      status: "dead",
    });
  });

  test("evidence checks share the wait deadline instead of extending it", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    for (const id of ["slow-a", "slow-b"]) {
      db.createSession({ id, parentId: "cli-root", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp", checkCmd: "sleep 5" });
      db.updateStatus(id, "idle");
    }
    const started = Date.now();

    const results = await wait(db, ["slow-a", "slow-b"], true, 400) as Array<{ evidence?: { check?: { timedOut: boolean } } }>;

    expect(Date.now() - started).toBeLessThan(3000);
    expect(results.map((result) => result.evidence?.check?.timedOut)).toEqual([true, true]);
  });

  test("a single-session wait is bounded by its own timeout even when the check is slow", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    db.createSession({ id: "slow-one", parentId: "cli-root", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp", checkCmd: "sleep 5" });
    db.updateStatus("slow-one", "idle");
    const started = Date.now();

    const result = await wait(db, ["slow-one"], false, 400) as { evidence?: { check?: { timedOut: boolean } } };

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.evidence?.check?.timedOut).toBe(true);
  });

  test("identical checks for sessions in one project run once and each session gets its own log", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const project = "/tmp/ahelpa-wait-shared-check";
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    for (const id of ["twin-a", "twin-b"]) {
      db.createSession({ id, parentId: "cli-root", agentType: "codex", task: "t", ownerToken: "tok", projectPath: project, checkCmd: "echo run >> runs.txt" });
      db.updateStatus(id, "idle");
    }

    const results = await wait(db, ["twin-a", "twin-b"], true, 5000) as Array<{ evidence?: { check?: { exitCode: number | null; logPath: string } } }>;

    expect(readFileSync(`${project}/runs.txt`, "utf-8")).toBe("run\n");
    expect(results.map((r) => r.evidence?.check?.exitCode)).toEqual([0, 0]);
    expect(results.map((r) => r.evidence?.check?.logPath)).toEqual([`${project}/.ahelpa/twin-a/check.log`, `${project}/.ahelpa/twin-b/check.log`]);
    expect(existsSync(`${project}/.ahelpa/twin-b/check.log`)).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  test("all preserves each settled result when another session times out", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const statuses = ["idle", "error", "needs_attention", "draining", "running"] as const;
    for (const status of statuses) {
      db.createSession({ id: status, parentId: "cli-root", agentType: "codex",
        task: "wait task", ownerToken: "test-token", projectPath: "/tmp" });
      db.updateStatus(status, status);
    }

    const settled = { evidence: expect.objectContaining({ summaryBytes: 0 }) };
    expect(await wait(db, [...statuses, "missing"], true, 0)).toEqual([
      { sessionId: "idle", status: "idle", ...settled },
      { sessionId: "error", status: "error", ...settled },
      { sessionId: "needs_attention", status: "needs_attention", ...settled },
      { sessionId: "draining", status: "idle", ...settled },
      { sessionId: "running", status: "still_running" },
      { sessionId: "missing", status: "dead" },
    ]);
  });
});
