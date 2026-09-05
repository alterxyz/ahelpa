import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import { RuntimeLayout, defaultRuntimeLayout } from "../src/runtime-layout";
import * as daemon from "../src/daemon";
import { wait } from "../src/commands/wait";
import { kill, logs } from "../src/commands/session-ops";
import { resume } from "../src/commands/launch";

describe("daemon recovery", () => {
  let db: StateDB;
  let root: string;
  let layout: RuntimeLayout;

  beforeEach(() => {
    root = mkdtempSync("/tmp/ahelpa-daemon-recovery-");
    layout = new RuntimeLayout({ homeDir: root, tmpDir: root });
    db = new StateDB(":memory:");
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
    spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(join(root, "daemon.log"));
    spyOn(defaultRuntimeLayout, "taskFilePath").mockImplementation((id) => layout.taskFilePath(id));
    spyOn(defaultRuntimeLayout, "fifoPath").mockImplementation((id) => layout.fifoPath(id));
  });

  afterEach(() => {
    mock.restore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function createSession() {
    const id = `recovery-${crypto.randomUUID()}`;
    db.createSession({ id, parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: root });
    return id;
  }

  test("completed sessions retain their result, logs, and authorized resume after runtime cleanup", async () => {
    const id = createSession();
    let alive = true;
    spyOn(Tmux, "hasSession").mockImplementation(async () => alive);
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    const capture = spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:DONE]");
    spyOn(Tmux, "kill").mockImplementation(async () => { alive = false; });
    writeFileSync(layout.taskFilePath(id), "temporary task");
    await FIFO.create(layout.fifoPath(id));

    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("draining");
    capture.mockResolvedValue("Resume this session with:\nclaude --resume 12345678-1234-1234-1234-123456789abc");
    spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await daemon.refreshSessionStatuses(db, [id]);

    expect(alive).toBe(false);
    expect(existsSync(layout.fifoPath(id))).toBe(false);
    expect(existsSync(layout.taskFilePath(id))).toBe(false);
    expect(db.getSession(id)?.status).toBe("idle");
    expect(db.listActiveSessions()).toHaveLength(0);
    expect(new Archive(join(root, "archive")).get(id)?.status).toBe("idle");
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    expect(await wait(db, [id], false, 50)).toEqual({ sessionId: id, status: "idle" });
    expect(await logs(db, id, "tok")).toBe("[AHELPA:DONE]");

    const create = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    const result = await resume({ db, sessionId: id, ownerToken: "tok" });
    expect(result.resumedFrom).toBe(id);
    expect(create.mock.calls[0]?.[1]).toContain("12345678-1234-1234-1234-123456789abc");
    await expect(resume({ db, sessionId: id, ownerToken: "wrong" })).rejects.toThrow("Invalid token");
  });

  test("a fresh monitor honors the recorded drain start time", async () => {
    const id = createSession();
    db.updateStatus(id, "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("exiting");
    const kill = spyOn(Tmux, "kill").mockResolvedValue();

    await daemon.refreshSessionStatuses(db, [id]);

    expect(kill).not.toHaveBeenCalled();
    expect(db.getSession(id)?.status).toBe("draining");
  });

  test("a disappearing pane settles dead without skipping another session", async () => {
    createSession();
    createSession();
    const [lost, healthy] = db.listSessions();
    let vanished = false;
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => id !== lost!.id || !vanished);
    spyOn(Tmux, "capture").mockImplementation(async (id) => {
      if (id === lost!.id) {
        vanished = true;
        throw new Error("cannot find pane");
      }
      return "[AHELPA:DONE]";
    });
    spyOn(Tmux, "sendKeys").mockResolvedValue();

    await daemon.refreshSessionStatuses(db);

    expect(db.getSession(lost!.id)?.status).toBe("dead");
    expect(db.getSession(healthy!.id)?.status).toBe("draining");
    expect(new Archive(join(root, "archive")).get(lost!.id)?.reason).toBe("tmux session gone");
    expect(readFileSync(join(root, "daemon.log"), "utf8")).toContain(`${lost!.id}: refresh failed: cannot find pane`);
  });

  test("a transient capture failure retries next poll and does not block other sessions", async () => {
    createSession();
    createSession();
    const [flaky, healthy] = db.listSessions();
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    const capture = spyOn(Tmux, "capture").mockImplementation(async (id) => {
      if (id === flaky!.id) throw new Error("temporary capture failure");
      return "[AHELPA:DONE]";
    });
    spyOn(Tmux, "sendKeys").mockResolvedValue();

    await daemon.refreshSessionStatuses(db);
    expect(db.getSession(flaky!.id)?.status).toBe("running");
    expect(db.getSession(healthy!.id)?.status).toBe("draining");

    capture.mockResolvedValue("[AHELPA:DONE]");
    await daemon.refreshSessionStatuses(db, [flaky!.id]);
    expect(db.getSession(flaky!.id)?.status).toBe("draining");
  });

  test("a terminal disappearing during drain kill preserves successful settlement", async () => {
    const id = createSession();
    db.updateStatus(id, "draining");
    new Archive(join(root, "archive")).save(id, { status: "idle", lastOutput: "done" });
    let vanished = false;
    spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    spyOn(Tmux, "hasSession").mockImplementation(async () => !vanished);
    spyOn(Tmux, "capture").mockResolvedValue("exited");
    spyOn(Tmux, "kill").mockImplementation(async () => {
      vanished = true;
      throw new Error("cannot find session");
    });

    await daemon.refreshSessionStatuses(db, [id]);

    expect(db.getSession(id)?.status).toBe("idle");
    expect(new Archive(join(root, "archive")).get(id)?.status).toBe("idle");
  });

  test("kill remains valid after the daemon reclaimed a terminal", async () => {
    const id = createSession();
    db.updateStatus(id, "idle");
    spyOn(Tmux, "kill").mockRejectedValue(new Error("cannot find session"));
    spyOn(Tmux, "hasSession").mockResolvedValue(false);

    await kill(db, id, "tok");

    expect(db.getSession(id)?.status).toBe("dead");
  });

  test("kill propagates failures when the terminal remains alive", async () => {
    const id = createSession();
    spyOn(Tmux, "kill").mockRejectedValue(new Error("temporary kill failure"));
    spyOn(Tmux, "hasSession").mockResolvedValue(true);

    await expect(kill(db, id, "tok")).rejects.toThrow("temporary kill failure");

    expect(db.getSession(id)?.status).toBe("running");
  });
});
