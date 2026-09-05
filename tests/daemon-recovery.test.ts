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

  function createSession(agentType = "claude-code", safe = false) {
    const id = `recovery-${crypto.randomUUID()}`;
    db.createSession({ id, parentId: "p", agentType, task: "t", ownerToken: "tok", projectPath: root, safe });
    return id;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  test("explicit kill wins while graceful exit is still awaiting completion", async () => {
    db.close();
    const dbPath = join(root, "concurrent.db");
    db = new StateDB(dbPath);
    const hostDb = new StateDB(dbPath);
    const id = createSession("kimi");
    const exiting = deferred<void>();
    const releaseExit = deferred<void>();
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("● [AHELPA:DONE]");
    spyOn(Tmux, "sendKeys").mockImplementation(async () => {
      exiting.resolve();
      await releaseExit.promise;
    });
    spyOn(Tmux, "kill").mockResolvedValue();
    const refreshing = daemon.refreshSessionStatuses(db, [id]);
    try {
      await exiting.promise;
      expect(hostDb.getSession(id)?.status).toBe("idle");
      await kill(hostDb, id, "tok");
      expect(hostDb.getSession(id)?.status).toBe("dead");
    } finally {
      releaseExit.resolve();
      await refreshing;
      hostDb.close();
    }

    expect(db.getSession(id)?.status).toBe("dead");
    expect(db.listActiveSessions()).toHaveLength(0);
    expect(new Archive(join(root, "archive")).get(id)?.status).toBe("idle");
  });

  test("explicit kill wins while a completion capture is still pending", async () => {
    const id = createSession();
    const capturing = deferred<void>();
    const releaseCapture = deferred<string>();
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockImplementation(async () => {
      capturing.resolve();
      return releaseCapture.promise;
    });
    const exitSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "kill").mockResolvedValue();

    const refreshing = daemon.refreshSessionStatuses(db, [id]);
    await capturing.promise;
    await kill(db, id, "tok");
    releaseCapture.resolve("[AHELPA:DONE]");
    await refreshing;

    expect(db.getSession(id)?.status).toBe("dead");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(new Archive(join(root, "archive")).get(id)).toBeNull();
  });

  test("explicit kill wins while the daemon is reclaiming a draining terminal", async () => {
    const id = createSession();
    db.updateStatus(id, "draining");
    db.updateResumeId(id, "resume-token");
    new Archive(join(root, "archive")).save(id, { status: "idle", lastOutput: "done" });
    const reclaiming = deferred<void>();
    const releaseReclaim = deferred<void>();
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    let killCalls = 0;
    spyOn(Tmux, "kill").mockImplementation(async () => {
      if (++killCalls === 1) {
        reclaiming.resolve();
        await releaseReclaim.promise;
      }
    });

    const refreshing = daemon.refreshSessionStatuses(db, [id], Date.now() + 16_000);
    await reclaiming.promise;
    await kill(db, id, "tok");
    releaseReclaim.resolve();
    await refreshing;

    expect(db.getSession(id)?.status).toBe("dead");
    expect(db.getSession(id)?.agentResumeId).toBe("resume-token");
    expect(new Archive(join(root, "archive")).get(id)?.status).toBe("idle");
  });

  test.each(["claude-code", "codex", "kimi"])("%s retains its result, logs, safe posture, and authorized resume after runtime cleanup", async (agentType) => {
    const id = createSession(agentType, true);
    const resumeId = agentType === "kimi"
      ? "session_12345678-1234-1234-1234-123456789abc"
      : "12345678-1234-1234-1234-123456789abc";
    const exitOutput = agentType === "claude-code"
      ? `Resume this session with:\nclaude --resume ${resumeId}`
      : agentType === "codex"
        ? `To continue this session, run codex resume ${resumeId}`
        : `To resume this session: kimi -r ${resumeId}`;
    const readyOutput = agentType === "claude-code"
      ? "❯ Earlier task\n[AHELPA:DONE]\n0 tokens\n❯"
      : agentType === "codex"
        ? "› Earlier task\n[AHELPA:DONE]\n› Explain this codebase"
        : `│ Session: ${resumeId} │\n✨ Earlier task\n● [AHELPA:DONE]\n│ > │`;
    let alive = true;
    spyOn(Tmux, "hasSession").mockImplementation(async () => alive);
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    const capture = spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:DONE]");
    spyOn(Tmux, "kill").mockImplementation(async () => { alive = false; });
    writeFileSync(layout.taskFilePath(id), "temporary task");
    await FIFO.create(layout.fifoPath(id));

    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("draining");
    capture.mockResolvedValue(exitOutput);
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

    const create = spyOn(Tmux, "create").mockImplementation(async () => { alive = true; });
    capture.mockResolvedValue(readyOutput);
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    const result = await resume({ db, sessionId: id, ownerToken: "tok" });
    expect(result.resumedFrom).toBe(id);
    expect(create.mock.calls[0]?.[1]).toContain(resumeId);
    expect(db.getSession(result.sessionId)?.safe).toBe(true);
    expect(db.getSession(result.sessionId)?.agentResumeId).toBe(resumeId);
    expect(db.getSession(result.sessionId)?.status).toBe("needs_attention");
    const capturesAfterResume = capture.mock.calls.length;
    await daemon.refreshSessionStatuses(db, [result.sessionId]);
    expect(capture.mock.calls).toHaveLength(capturesAfterResume);
    expect(db.getSession(result.sessionId)?.status).toBe("needs_attention");
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
