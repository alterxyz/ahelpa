import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { StateDB } from "../src/state";
import { clean } from "../src/commands/session-ops";
import { RuntimeLayout } from "../src/runtime-layout";
import { Tmux } from "../src/tmux";

const TEST_DB = "/tmp/ahelpa-clean-test.db";
const TEST_TMP = "/tmp/ahelpa-clean-test-tmp";

describe("clean", () => {
  let db: StateDB;
  let layout: RuntimeLayout;

  beforeEach(() => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_TMP, { recursive: true });
    layout = new RuntimeLayout({ tmpDir: TEST_TMP });
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
  });

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    rmSync(TEST_TMP, { recursive: true, force: true });
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
  });

  test("removes dead session records and their files, keeps live ones", async () => {
    db.createSession({ id: "live-1", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.createSession({ id: "dead-1", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus("dead-1", "dead");
    writeFileSync(layout.taskFilePath("dead-1"), "stale task");

    const result = await clean(db, layout);

    expect(result.removed).toBe(1);
    expect(db.getSession("dead-1")).toBeNull();
    expect(db.getSession("live-1")).not.toBeNull();
    expect(existsSync(layout.taskFilePath("dead-1"))).toBe(false);
  });

  test("sweeps orphan pipes and task files, keeps live sessions' files", async () => {
    db.createSession({ id: "live-2", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
    writeFileSync(`${TEST_TMP}/ahelpa-task-orphan-1.md`, "stale");
    writeFileSync(`${TEST_TMP}/orphan-2.pipe`, "");
    writeFileSync(layout.taskFilePath("live-2"), "keep");

    const result = await clean(db, layout);

    expect(result.orphanFiles).toBe(2);
    expect(existsSync(`${TEST_TMP}/ahelpa-task-orphan-1.md`)).toBe(false);
    expect(existsSync(`${TEST_TMP}/orphan-2.pipe`)).toBe(false);
    expect(existsSync(layout.taskFilePath("live-2"))).toBe(true);
  });

  test("ignores files that do not follow the session file naming", async () => {
    writeFileSync(`${TEST_TMP}/unrelated.txt`, "leave me");

    const result = await clean(db, layout);

    expect(result.orphanFiles).toBe(0);
    expect(existsSync(`${TEST_TMP}/unrelated.txt`)).toBe(true);
  });

  test("removes terminal records only after tmux exits and keeps draining records", async () => {
    const sessions = [
      ["done", "idle"], ["failed", "error"], ["draining", "draining"],
      ["live-error", "error"], ["attention", "needs_attention"],
    ] as const;
    for (const [id, status] of sessions) {
      db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "/tmp" });
      db.updateStatus(id, status);
      writeFileSync(layout.taskFilePath(id), "task");
    }
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => id === "live-error");

    const result = await clean(db, layout);

    expect(result.removed).toBe(2);
    expect(db.getSession("done")).toBeNull();
    expect(db.getSession("failed")).toBeNull();
    for (const id of ["draining", "live-error", "attention"]) {
      expect(db.getSession(id)).not.toBeNull();
      expect(existsSync(layout.taskFilePath(id))).toBe(true);
    }
  });
});
