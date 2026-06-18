import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { StateDB } from "../src/state";
import { refreshSessionStatuses } from "../src/daemon";
import { Tmux } from "../src/tmux";

const TEST_DB = "/tmp/ahelpa-refresh-test.db";

describe("refreshSessionStatuses", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
  });

  test("reconciles settled sessions whose tmux session has gone away", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "stale-idle", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("stale-idle", "idle");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);

    await refreshSessionStatuses(db);

    expect(db.getSession("stale-idle")?.status).toBe("dead");
  });

  test("leaves settled sessions alone while their tmux session lives", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "live-idle", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("live-idle", "idle");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    const captureSpy = spyOn(Tmux, "capture").mockResolvedValue("anything");

    await refreshSessionStatuses(db);

    expect(db.getSession("live-idle")?.status).toBe("idle");
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test("captures agent resume token after graceful exit enters draining", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "done-claude", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      return captures === 1
        ? "[AHELPA:DONE]"
        : "Resume this session with:\n  claude --resume dc8ca9c2-766b-4d52-9623-1ff9d44b2075";
    });

    await refreshSessionStatuses(db, ["done-claude"]);
    await refreshSessionStatuses(db, ["done-claude"]);

    expect(db.getSession("done-claude")?.agentResumeId).toBe("dc8ca9c2-766b-4d52-9623-1ff9d44b2075");
  });
});
