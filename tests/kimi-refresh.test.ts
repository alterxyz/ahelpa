import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { refreshSessionStatuses } from "../src/daemon";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";

let TEST_DB: string;
let scratch: string;
const TASK = "Please read and complete the task described in /tmp/ahelpa-task-kimi.md.";

describe("Kimi daemon activity", () => {
  let db: StateDB;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-kimi-refresh-"));
    TEST_DB = join(scratch, "state.db");
  });

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
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
