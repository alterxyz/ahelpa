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

  test("reaps settled sessions whose tmux session has gone away", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "stale-idle", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("stale-idle", "idle");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);

    await refreshSessionStatuses(db);

    expect(db.getSession("stale-idle")).toBeNull();
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

  test("flags needs_attention after sustained idle (debounce = 4 polls)", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "stuck-codex", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(
      "Press enter to view hooks; esc to close\nSubagentStart hooks\nesc to go back",
    );

    // Polls 1-3: debounce accumulating, stays running
    for (let i = 0; i < 3; i++) {
      await refreshSessionStatuses(db, ["stuck-codex"]);
      expect(db.getSession("stuck-codex")?.status).toBe("running");
    }

    // Poll 4: debounce met, transitions to needs_attention
    await refreshSessionStatuses(db, ["stuck-codex"]);
    expect(db.getSession("stuck-codex")?.status).toBe("needs_attention");
  });

  test("idle counter resets when agent resumes working", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "flaky", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    let callCount = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      callCount++;
      // 2 idle polls then agent starts working
      if (callCount <= 2) return "Press enter to view hooks; esc to close";
      return "Working (2s)\n• Reading file src/cli.ts";
    });

    await refreshSessionStatuses(db, ["flaky"]);
    await refreshSessionStatuses(db, ["flaky"]);
    await refreshSessionStatuses(db, ["flaky"]);
    // Even after 3 total polls, still running because working signal reset the counter
    await refreshSessionStatuses(db, ["flaky"]);

    expect(db.getSession("flaky")?.status).toBe("running");
  });

  test("settles Dead and notifies when a draining session's tmux exits cleanly", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "drain-clean",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
      notifyTmux: "ahelpa-test-drain-clean-target",
    });
    db.updateStatus("drain-clean", "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "hasTarget").mockResolvedValue(true);
    const sendLiteralSpy = spyOn(Tmux, "sendLiteral").mockResolvedValue();

    await refreshSessionStatuses(db);

    expect(sendLiteralSpy).toHaveBeenCalledWith(
      "ahelpa-test-drain-clean-target",
      expect.stringContaining("dead"),
    );
    expect(db.getSession("drain-clean")).toBeNull();
  });

  test("settles Dead and notifies on drain timeout", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "drain-timeout",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
      notifyTmux: "ahelpa-test-drain-timeout-target",
    });
    db.updateStatus("drain-timeout", "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("anything");
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(Tmux, "hasTarget").mockResolvedValue(true);
    const sendLiteralSpy = spyOn(Tmux, "sendLiteral").mockResolvedValue();

    // This session never passed through the in-process Running->Draining
    // transition, so the daemon's drainingAt map has no start time recorded
    // for it — the very first poll is treated as already timed out.
    await refreshSessionStatuses(db, ["drain-timeout"]);

    expect(killSpy).toHaveBeenCalledWith("drain-timeout");
    expect(sendLiteralSpy).toHaveBeenCalledWith(
      "ahelpa-test-drain-timeout-target",
      expect.stringContaining("dead"),
    );
    expect(db.getSession("drain-timeout")).toBeNull();
  });

  test("does not re-settle or double-notify a session that already reaped as Dead", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "already-dead",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
      notifyTmux: "ahelpa-test-already-dead-target",
    });
    db.updateStatus("already-dead", "dead");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "hasTarget").mockResolvedValue(true);
    const sendLiteralSpy = spyOn(Tmux, "sendLiteral").mockResolvedValue();

    await refreshSessionStatuses(db);

    // Dead sessions are filtered out before the loop runs, so no second
    // settle/notify happens for a session that's already terminal.
    expect(sendLiteralSpy).not.toHaveBeenCalled();
  });
});
