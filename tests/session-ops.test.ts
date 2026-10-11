import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { send, sendTask, kill } from "../src/commands/session-ops";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";
import { getDriver } from "../src/drivers/registry";
import { defaultWakeup } from "../src/wakeup";
import { defaultRuntimeLayout } from "../src/runtime-layout";

const TEST_DB = "/tmp/ahelpa-session-ops-test.db";
const TEST_TASK = "/tmp/ahelpa-session-ops-task.md";
const TEST_PROJECT = "/tmp/ahelpa-session-ops-project";

describe("session operations", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    try { if (existsSync(TEST_TASK)) unlinkSync(TEST_TASK); } catch {}
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  test("sending a follow-up resumes daemon monitoring", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "codex-follow-up",
      parentId: "p",
      agentType: "codex",
      task: "(resumed)",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    db.updateStatus("codex-follow-up", "needs_attention");
    const sendSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      return captures === 1 ? "› Earlier turn" : "› Continue the review\nWorking (1s)";
    });
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    await send(db, "codex-follow-up", "tok", "Continue the review");

    expect(sendSpy).toHaveBeenCalledWith("codex-follow-up", "Continue the review");
    expect(db.getSession("codex-follow-up")?.status).toBe("running");
  });

  test.each(["codex", "kimi"])("%s keeps attention when follow-up reveals only historical DONE", async (agentType) => {
    db = new StateDB(TEST_DB);
    const id = `${agentType}-unchanged-history`;
    db.createSession({ id, parentId: "p", agentType, task: "(resumed)", ownerToken: "tok", projectPath: "/tmp" });
    db.updateStatus(id, "needs_attention");
    const oldTurn = agentType === "kimi"
      ? "│ Session: session_old-123 │\n✨ Earlier task\n● [AHELPA:DONE]\n│ > │"
      : "› Earlier task\n[AHELPA:DONE]\n› Explain this codebase";
    spyOn(Tmux, "capture").mockResolvedValue(oldTurn);
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();
    const fifoSpy = spyOn(FIFO, "create").mockResolvedValue();
    const daemonSpy = spyOn(daemon, "startDaemon").mockImplementation(() => {});

    await expect(send(db, id, "tok", "Follow-up task")).rejects.toThrow("did not expose a new turn");

    expect(db.getSession(id)?.status).toBe("needs_attention");
    expect(fifoSpy).not.toHaveBeenCalled();
    expect(daemonSpy).not.toHaveBeenCalled();
  });

  test("answering a Kimi approval resumes monitoring within the same turn", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "kimi-approval-answer",
      parentId: "p",
      agentType: "kimi",
      task: "inspect repository",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    db.updateStatus("kimi-approval-answer", "needs_attention");
    const waiting = [
      "│  Session:   session_abc-123   │",
      "✨ Inspect the repository",
      "▶ Run this command?",
      "1. Approve once",
    ].join("\n");
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      return captures === 1 ? waiting : `${waiting}\n⠏ working...`;
    });
    const sendSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    const fifoSpy = spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    await send(db, "kimi-approval-answer", "tok", "1");

    expect(sendSpy).toHaveBeenCalledWith("kimi-approval-answer", "1");
    expect(fifoSpy).toHaveBeenCalled();
    expect(db.getSession("kimi-approval-answer")?.status).toBe("running");
  });

  test("sending after NEED_HELP restores FIFO monitoring and restarts the daemon", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "codex-needs-help",
      parentId: "p",
      agentType: "codex",
      task: "blocked task",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    db.updateStatus("codex-needs-help", "error");
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      return captures === 1
        ? "› Blocked task\n[AHELPA:NEED_HELP]"
        : "› Here is the missing detail\nWorking (1s)";
    });
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    const fifoSpy = spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
    const startSpy = spyOn(daemon, "startDaemon").mockImplementation(() => {});

    await send(db, "codex-needs-help", "tok", "Here is the missing detail");

    expect(fifoSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(db.getSession("codex-needs-help")?.status).toBe("running");
  });

  test("sending a task file can recover an attention state", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "codex-task-follow-up",
      parentId: "p",
      agentType: "codex",
      task: "first task",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
    });
    db.updateStatus("codex-task-follow-up", "needs_attention");
    writeFileSync(TEST_TASK, "Follow-up task body");
    const sendSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      return captures === 1
        ? "› First task"
        : "› Please read and complete the task described in a file.\nWorking (1s)";
    });
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    await sendTask(db, "codex-task-follow-up", "tok", TEST_TASK);

    expect(sendSpy.mock.calls[0]?.[1]).toContain("Please read and complete the task described in");
    expect(db.getSession("codex-task-follow-up")?.status).toBe("running");
  });

  test.each(["empty", "directory", "missing"])("sendTask rejects a %s input before replacing the handoff or typing a message", async (kind) => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    const id = `invalid-task-${kind}`;
    db.createSession({ id, parentId: "p", agentType: "codex", task: "original", ownerToken: "tok", projectPath: TEST_PROJECT });
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
    const handoff = defaultRuntimeLayout.taskFilePath(id);
    writeFileSync(handoff, "previous task");
    writeFileSync(TEST_TASK, " \n ");
    const filePath = kind === "directory" ? TEST_PROJECT : kind === "missing" ? `${TEST_PROJECT}/missing.md` : TEST_TASK;
    const send = spyOn(Tmux, "sendKeys").mockResolvedValue();

    try {
      await expect(sendTask(db, id, "tok", filePath)).rejects.toThrow();

      expect(send).not.toHaveBeenCalled();
      expect(readFileSync(handoff, "utf8")).toBe("previous task");
      expect(db.getSession(id)?.status).toBe("running");
      expect(existsSync(`${TEST_PROJECT}/.ahelpa`)).toBe(false);
    } finally {
      unlinkSync(handoff);
    }
  });

  test("sendTask rejects a legacy relative project instead of writing results under the caller directory", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "relative-project", parentId: "p", agentType: "codex", task: "original", ownerToken: "tok", projectPath: "." });
    writeFileSync(TEST_TASK, "Follow-up task");
    const send = spyOn(Tmux, "sendKeys").mockResolvedValue();

    await expect(sendTask(db, "relative-project", "tok", TEST_TASK))
      .rejects.toThrow("original working directory is unknown");

    expect(send).not.toHaveBeenCalled();
    expect(db.getSession("relative-project")?.projectPath).toBe(".");
  });

  test.each(["send", "sendTask"])("%s cannot revive a session killed while preparing its wakeup pipe", async (operation) => {
    db = new StateDB(TEST_DB);
    const id = `killed-during-${operation}`;
    db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT });
    db.updateStatus(id, "needs_attention");
    writeFileSync(TEST_TASK, "Follow-up task body");
    spyOn(Tmux, "capture").mockResolvedValue("synthetic turn");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(getDriver("codex"), "afterTaskSubmitted").mockResolvedValue(true);
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    spyOn(FIFO, "create").mockImplementation(async () => {
      started();
      await paused;
    });
    const cleanup = spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
    const startDaemon = spyOn(daemon, "startDaemon").mockImplementation(() => {});
    const sending = operation === "send"
      ? send(db, id, "tok", "Follow-up task")
      : sendTask(db, id, "tok", TEST_TASK);

    await preparing;
    await kill(db, id, "tok");
    expect(db.getSession(id)?.status).toBe("dead");
    release();
    await expect(sending).rejects.toThrow("monitoring was not resumed");

    expect(db.getSession(id)?.status).toBe("dead");
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(startDaemon).not.toHaveBeenCalled();
  });

  test("a confirmed delivery can share an independently rearmed row and keeps its wakeup pipe", async () => {
    db = new StateDB(TEST_DB);
    const id = "concurrent-intervention";
    db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT });
    db.updateStatus(id, "needs_attention");
    spyOn(Tmux, "capture").mockResolvedValue("synthetic turn");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(getDriver("codex"), "afterTaskSubmitted").mockResolvedValue(true);
    spyOn(FIFO, "create").mockImplementation(async () => {
      db.updateStatus(id, "running");
    });
    const cleanup = spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    await send(db, id, "tok", "Follow-up task");

    expect(db.getSession(id)?.status).toBe("running");
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("another running row cannot confirm a delivery whose driver saw no new turn", async () => {
    db = new StateDB(TEST_DB);
    const id = "unconfirmed-intervention";
    db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT });
    db.updateStatus(id, "needs_attention");
    spyOn(Tmux, "capture").mockResolvedValue("historical output");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(getDriver("codex"), "afterTaskSubmitted").mockImplementation(async () => {
      db.updateStatus(id, "running");
      return false;
    });
    const prepare = spyOn(defaultWakeup, "prepare").mockResolvedValue();
    await expect(send(db, id, "tok", "new message")).rejects.toThrow("did not expose a new turn");
    expect(prepare).not.toHaveBeenCalled();
    expect(db.getSession(id)?.status).toBe("running");
  });
});
