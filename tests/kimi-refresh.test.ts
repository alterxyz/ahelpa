import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { refreshSessionStatuses } from "../src/daemon";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";

const TEST_DB = "/tmp/ahelpa-kimi-refresh-test.db";
const TASK = "Please read and complete the task described in /tmp/ahelpa-task-kimi.md.";

describe("Kimi daemon activity", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
  });

  test("keeps a Kimi session running while its submitted task is active", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "kimi-working",
      parentId: "p",
      agentType: "kimi",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(
      `│ >   │\n🌕\ncontext: 0%`,
    );

    for (let i = 0; i < 5; i++) {
      await refreshSessionStatuses(db, ["kimi-working"]);
    }

    expect(db.getSession("kimi-working")?.status).toBe("running");
  });

  test("flags a sustained Kimi approval prompt as needs_attention", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "kimi-approval",
      parentId: "p",
      agentType: "kimi",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(
      `${TASK}\n▶ Run this command?\n1. Approve once\n2. Approve for this session\n↵ confirm`,
    );

    for (let i = 0; i < 3; i++) {
      await refreshSessionStatuses(db, ["kimi-approval"]);
      expect(db.getSession("kimi-approval")?.status).toBe("running");
    }
    await refreshSessionStatuses(db, ["kimi-approval"]);

    expect(db.getSession("kimi-approval")?.status).toBe("needs_attention");
  });
});
