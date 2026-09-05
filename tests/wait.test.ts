import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
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

  test("all preserves each settled result when another session times out", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const statuses = ["idle", "error", "needs_attention", "draining", "running"] as const;
    for (const status of statuses) {
      db.createSession({ id: status, parentId: "cli-root", agentType: "codex",
        task: "wait task", ownerToken: "test-token", projectPath: "/tmp" });
      db.updateStatus(status, status);
    }

    expect(await wait(db, [...statuses, "missing"], true, 0)).toEqual([
      { sessionId: "idle", status: "idle" },
      { sessionId: "error", status: "error" },
      { sessionId: "needs_attention", status: "needs_attention" },
      { sessionId: "draining", status: "idle" },
      { sessionId: "running", status: "still_running" },
      { sessionId: "missing", status: "dead" },
    ]);
  });
});
