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

  test("retains a dead record when its native agent session can be resumed", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "resumable-idle", parentId: "p", agentType: "kimi", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateResumeId("resumable-idle", "session_abc-123");
    db.updateStatus("resumable-idle", "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);

    await refreshSessionStatuses(db);

    expect(db.getSession("resumable-idle")?.status).toBe("dead");
    expect(db.getSession("resumable-idle")?.agentResumeId).toBe("session_abc-123");
  });

  test("retains a token captured in the same draining refresh that reclaims tmux", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "fresh-token", parentId: "p", agentType: "kimi", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("fresh-token", "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(
      "To resume this session: kimi -r session_fresh-123",
    );
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    const drainStartedAt = Date.parse(db.getSession("fresh-token")!.updatedAt);

    await refreshSessionStatuses(db, ["fresh-token"], drainStartedAt + 16_000);

    expect(killSpy).toHaveBeenCalledWith("fresh-token");
    expect(db.getSession("fresh-token")?.status).toBe("dead");
    expect(db.getSession("fresh-token")?.agentResumeId).toBe("session_fresh-123");
  });

  test("does not reclaim a recent draining session after daemon restart", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "recent-drain", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("recent-drain", "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("Exiting…");
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    const drainStartedAt = Date.parse(db.getSession("recent-drain")!.updatedAt);

    await refreshSessionStatuses(db, ["recent-drain"], drainStartedAt + 1_000);

    expect(killSpy).not.toHaveBeenCalled();
    expect(db.getSession("recent-drain")?.status).toBe("draining");
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
});
