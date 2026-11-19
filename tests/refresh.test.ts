import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { refreshSessionStatuses } from "../src/daemon";
import { Tmux } from "../src/tmux";

let TEST_DB: string;
let scratch: string;

describe("refreshSessionStatuses", () => {
  let db: StateDB;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-refresh-"));
    TEST_DB = join(scratch, "state.db");
  });

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  });

  test("retains a successful record when its native agent session can be resumed", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "resumable-idle", parentId: "p", agentType: "kimi", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateResumeId("resumable-idle", "session_abc-123");
    db.updateStatus("resumable-idle", "draining");
    spyOn(Tmux, "liveSessionNames").mockResolvedValue(new Set());

    await refreshSessionStatuses(db);

    expect(db.getSession("resumable-idle")?.status).toBe("idle");
    expect(db.getSession("resumable-idle")?.agentResumeId).toBe("session_abc-123");
  });

  test("leaves settled sessions alone while their tmux session lives", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "live-idle", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("live-idle", "idle");
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(s => s.id)));
    const captureSpy = spyOn(Tmux, "capture").mockResolvedValue("anything");

    await refreshSessionStatuses(db);

    expect(db.getSession("live-idle")?.status).toBe("idle");
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test("flags needs_attention after sustained idle (debounce = 4 polls)", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "stuck-codex", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(s => s.id)));
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

  test("settles a current-turn unsupported Codex model request as error", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "bad-model", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(s => s.id)));
    spyOn(Tmux, "capture").mockResolvedValue([
      "› Please read and complete the task described in /tmp/ahelpa/task.md.",
      "ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.\"}}",
      "› Explain this codebase",
    ].join("\n"));

    await refreshSessionStatuses(db, ["bad-model"]);

    expect(db.getSession("bad-model")?.status).toBe("error");
  });

  test("idle counter resets when agent resumes working", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "flaky", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(s => s.id)));
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
