import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as fs from "fs";
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
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-daemon-recovery-"));
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

  function logLines() {
    return readFileSync(join(root, "daemon.log"), "utf8").trim().split("\n");
  }

  // Draining catches token-capture failures locally, so these exercise log()
  // independently of refresh backoff, without exporting logger internals.
  function failingTokenCapture() {
    const id = createSession();
    db.updateStatus(id, "draining");
    const now = Date.parse(db.getSession(id)!.updatedAt);
    spyOn(Date, "now").mockReturnValue(now);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    const capture = spyOn(Tmux, "capture").mockRejectedValue(new Error("token unavailable"));
    return { id, now, capture, refresh: () => daemon.refreshSessionStatuses(db, [id], now) };
  }

  test.each([10_000_000, 10_000_001])("rotates logs at %i bytes in order, dropping oldest and continuing append", async size => {
    const { refresh, capture } = failingTokenCapture();
    const path = join(root, "daemon.log");
    writeFileSync(path, "current\n");
    truncateSync(path, size);
    writeFileSync(`${path}.1`, "previous\n");
    writeFileSync(`${path}.2`, "older\n");
    writeFileSync(`${path}.3`, "oldest\n");

    await refresh();

    expect(readFileSync(`${path}.3`, "utf8")).toBe("older\n");
    expect(readFileSync(`${path}.2`, "utf8")).toBe("previous\n");
    expect(statSync(`${path}.1`).size).toBe(size);
    expect(readFileSync(`${path}.1`, "utf8").startsWith("current\n")).toBe(true);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toContain("token unavailable");
    expect(existsSync(`${path}.4`)).toBe(false);

    // Rotate again with a sparse fixture, proving the next append still works.
    truncateSync(path, 10_000_000);
    capture.mockRejectedValue(new Error("different error"));
    await refresh();
    expect(readFileSync(`${path}.3`, "utf8")).toBe("previous\n");
    expect(statSync(`${path}.2`).size).toBe(size);
    expect(statSync(`${path}.1`).size).toBe(10_000_000);
    expect(logLines()[0]).toContain("different error");
  });

  test("does not rotate below the threshold and still appends if rotation fails", async () => {
    const { refresh, capture } = failingTokenCapture();
    const path = join(root, "daemon.log");
    writeFileSync(path, "");
    truncateSync(path, 9_999_999);
    await refresh();
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(statSync(path).size).toBeGreaterThan(10_000_000);

    // A nonempty directory cannot be replaced by rename(file, directory).
    mkdirSync(`${path}.1`);
    writeFileSync(`${path}.1/keep`, "keep");
    mkdirSync(`${path}.2`);
    writeFileSync(`${path}.2/keep`, "keep");
    mkdirSync(`${path}.3`);
    writeFileSync(`${path}.3/keep`, "keep");
    capture.mockRejectedValue(new Error("rotation blocked"));
    const before = statSync(path).size;
    await expect(refresh()).resolves.toBeUndefined();
    expect(statSync(path).size).toBeGreaterThan(before);
    expect(readFileSync(path, "utf8")).toContain("rotation blocked");
  });

  test("logging tolerates a missing file and an unwritable append target", async () => {
    const { refresh, capture } = failingTokenCapture();
    await refresh(); // stat ENOENT must not prevent creation by append
    expect(logLines()[0]).toContain("token unavailable");
    spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(root); // EISDIR
    capture.mockRejectedValue(new Error("append blocked"));
    await expect(refresh()).resolves.toBeUndefined();
  });

  test("1000 identical lines produce one line and counted summaries at most once per minute", async () => {
    const { refresh, now } = failingTokenCapture();
    for (let i = 0; i < 1000; i++) await refresh();
    expect(logLines()).toHaveLength(1);
    spyOn(Date, "now").mockReturnValue(now + 59_999);
    await refresh();
    expect(logLines()).toHaveLength(1);
    spyOn(Date, "now").mockReturnValue(now + 60_000);
    await refresh();
    expect(logLines()).toHaveLength(2);
    expect(logLines()[1]).toContain(`(repeated 1001 times since ${new Date(now).toISOString()})`);
    await refresh();
    expect(logLines()).toHaveLength(2);
    spyOn(Date, "now").mockReturnValue(now + 120_000);
    await refresh();
    expect(logLines()).toHaveLength(3);
    expect(logLines()[2]).toContain(`(repeated 2 times since ${new Date(now + 60_000).toISOString()})`);
  });

  test("dedupe separates exact messages and session ids and evicts the oldest of 1000 keys", async () => {
    const { id, refresh, capture } = failingTokenCapture();
    await refresh();
    capture.mockRejectedValue(new Error("other message"));
    await refresh();
    const other = createSession();
    db.updateStatus(other, "draining");
    await daemon.refreshSessionStatuses(db, [other]);
    expect(logLines()).toHaveLength(3);
    expect(logLines()[1]).toContain(id);
    expect(logLines()[2]).toContain(other);
    for (let i = 0; i < 1000; i++) {
      capture.mockRejectedValue(new Error(`distinct-${i}`));
      await refresh();
    }
    capture.mockRejectedValue(new Error("token unavailable"));
    await refresh();
    expect(logLines().at(-1)).toContain("token unavailable");
    expect(logLines().at(-1)).not.toContain("repeated");
    expect(logLines()).toHaveLength(1004);
  });

  test("settling a missing session drops its log keys without dropping another session's keys", async () => {
    const { id, now, refresh } = failingTokenCapture();
    const other = createSession();
    db.updateStatus(other, "draining");
    await refresh();
    await daemon.refreshSessionStatuses(db, [other], now);
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    await refresh();
    expect(db.getSession(id)?.status).toBe("idle");
    db.updateStatus(id, "draining");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    await refresh();
    await daemon.refreshSessionStatuses(db, [other], now);
    expect(logLines()).toHaveLength(3);
    expect(logLines()[2]).toContain(`${id}: resume token capture failed`);
    expect(logLines()[2]).not.toContain("repeated");
  });

  test("refresh failures retry on calls 1, 2, 4, 8 while other sessions refresh every call", async () => {
    const id = createSession("codex");
    const healthy = createSession("codex");
    let call = 0;
    const attempts: number[] = [];
    spyOn(Tmux, "hasSession").mockImplementation(async sid => {
      if (sid === id) { attempts.push(call); throw new Error("tmux unavailable"); }
      return true;
    });
    const capture = spyOn(Tmux, "capture").mockResolvedValue("Working (2s • esc to interrupt)");
    for (call = 1; call <= 8; call++) await daemon.refreshSessionStatuses(db);
    // Full attempts retain recovery checks; skipped calls only probe liveness.
    expect(attempts).toEqual([1, 1, 2, 2, 3, 4, 4, 5, 6, 7, 8, 8]);
    expect(logLines()).toHaveLength(2);
    expect(capture.mock.calls.map(args => args[0])).toEqual(Array(8).fill(healthy));
    expect(db.getSession(id)?.status).toBe("running");
  });

  test("a successful refresh resets the failure sequence", async () => {
    const id = createSession("codex");
    let call = 0;
    const attempts: number[] = [];
    spyOn(Tmux, "hasSession").mockImplementation(async () => {
      attempts.push(call);
      if (call !== 4) throw new Error("tmux unavailable");
      return true;
    });
    spyOn(Tmux, "capture").mockResolvedValue("Working (2s • esc to interrupt)");
    for (call = 1; call <= 8; call++) await daemon.refreshSessionStatuses(db, [id]);
    expect(attempts).toEqual([1, 1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 8, 8]);
  });

  test("missing-session recovery clears backoff and log keys even after repeated failures", async () => {
    const id = createSession("codex");
    let call = 0;
    let recovering = false;
    spyOn(Tmux, "hasSession").mockImplementation(async () => {
      if (call === 4 && recovering) return false;
      recovering = true;
      throw new Error("tmux unavailable");
    });
    for (call = 1; call <= 4; call++) {
      recovering = false;
      await daemon.refreshSessionStatuses(db, [id]);
    }
    expect(db.getSession(id)?.status).toBe("dead");
    expect(logLines()).toHaveLength(2);
    db.updateStatus(id, "running");
    call = 5;
    await daemon.refreshSessionStatuses(db, [id]);
    expect(logLines()).toHaveLength(4);
    expect(logLines()[2]).not.toContain("repeated");
  });

  test("a completion settlement clears earlier error keys for a subsequent turn", async () => {
    const id = createSession("codex");
    const hasSession = spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    hasSession.mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP]");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("error");
    db.updateStatus(id, "running");
    hasSession.mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    expect(logLines()).toHaveLength(4);
    expect(logLines()[2]).not.toContain("repeated");
  });

  test("a vanished tmux settles on the first skipped call without logging probe errors", async () => {
    const id = createSession("codex");
    writeFileSync(layout.taskFilePath(id), "temporary task");
    await FIFO.create(layout.fifoPath(id));
    const hasSession = spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    const capture = spyOn(Tmux, "capture").mockResolvedValue("Working (2s • esc to interrupt)");
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);
    hasSession.mockResolvedValue(false);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("dead");
    expect(new Archive(join(root, "archive")).get(id)?.reason).toBe("tmux session gone");
    expect(existsSync(layout.taskFilePath(id))).toBe(false);
    expect(existsSync(layout.fifoPath(id))).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(logLines()).toHaveLength(2);
  });

  test("a settlement failure on a skipped call is logged as recovery failed", async () => {
    const id = createSession("codex");
    writeFileSync(layout.taskFilePath(id), "temporary task");
    await FIFO.create(layout.fifoPath(id));
    const hasSession = spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);
    hasSession.mockResolvedValue(false);
    // Inject the unreadable-FIFO error deterministically, including when the
    // suite runs as root (where chmod 000 would not reliably cause EACCES).
    const denied = Object.assign(new Error("EACCES: permission denied opening wakeup FIFO"), { code: "EACCES" });
    const notify = spyOn(FIFO, "tryWrite").mockRejectedValue(denied);

    await expect(daemon.refreshSessionStatuses(db, [id])).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.getSession(id)?.status).toBe("dead"); // settlement committed before notification
    expect(existsSync(layout.taskFilePath(id))).toBe(true);
    expect(existsSync(layout.fifoPath(id))).toBe(true);
    expect(logLines()).toHaveLength(3);
    expect(logLines()[2]).toContain(`${id}: recovery failed: ${denied.message}`);
  });

  test("a failed first log append retries the same message immediately", async () => {
    const { refresh } = failingTokenCapture();
    const logPath = spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(root);
    await refresh(); // EISDIR: the first occurrence was not written.
    logPath.mockReturnValue(join(root, "daemon.log"));
    await refresh();
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toContain("token unavailable");
    expect(logLines()[0]).not.toContain("repeated");
  });

  test("a failed repeat summary retains six pending repeats and reports seven on retry", async () => {
    const { refresh, now } = failingTokenCapture();
    await refresh();
    for (let i = 0; i < 5; i++) await refresh();
    spyOn(Date, "now").mockReturnValue(now + 60_000);
    const logPath = spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(root);
    await refresh(); // sixth repeat; the summary append fails with EISDIR
    logPath.mockReturnValue(join(root, "daemon.log"));
    await refresh(); // seventh repeat retries at the same clock time
    expect(logLines()).toHaveLength(2);
    expect(logLines()[1]).toContain(`(repeated 7 times since ${new Date(now).toISOString()})`);
  });

  test.each(["idle", "error", "needs_attention"] as const)("external %s settlement and a new turn reset backoff before the next capture", async status => {
    const id = createSession("codex");
    const hasSession = spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.compareAndSetStatus(id, "running", status)).toBe(true);
    const registration = db.registerTurn(id, db.getSession(id)!.version, "follow-up work");
    const delivered = db.finishTurn(registration, true)!;
    expect(db.compareAndSetStatus(id, status, "running", delivered.version)).toBe(true);
    hasSession.mockResolvedValue(true);
    const capture = spyOn(Tmux, "capture").mockResolvedValue("Working (2s • esc to interrupt)");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(capture).toHaveBeenCalledTimes(1);
    hasSession.mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    expect(logLines()).toHaveLength(4); // the old turn's exact error keys were removed too
  });

  test.each(["dead", "deleted"])("reconciles %s rows even during a refresh targeting no ids", async disposition => {
    const id = createSession("codex");
    const hasSession = spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);
    if (disposition === "dead") db.updateStatus(id, "dead");
    else db.deleteSession(id);
    await daemon.refreshSessionStatuses(db, []);
    if (disposition === "dead") db.deleteSession(id);
    // Reusing the id/version deliberately isolates absent-id pruning from
    // version-change invalidation (covered by the registerTurn test above).
    db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: root });
    await daemon.refreshSessionStatuses(db, [id]);
    expect(logLines()).toHaveLength(4);
    hasSession.mockResolvedValue(true);
    const capture = spyOn(Tmux, "capture").mockResolvedValue("Working (2s • esc to interrupt)");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  test("a skipped liveness error remains silent even after the summary interval", async () => {
    const id = createSession("codex");
    const start = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    const hasSession = spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);
    clock.mockReturnValue(start + 60_000);
    hasSession.mockRejectedValue(new Error("probe-only failure"));
    await daemon.refreshSessionStatuses(db, [id]);
    expect(logLines()).toHaveLength(2);
    expect(logLines().some(line => line.includes("probe-only failure"))).toBe(false);
    expect(db.getSession(id)?.status).toBe("running");
  });

  test("10000 actual refresh failures stay below 1 KiB and the summaries account for every failure", async () => {
    const id = createSession("codex");
    const sessions = db.listSessions();
    let call = 0;
    let lastProbeCall = 0;
    let failures = 0;
    const attempts: number[] = [];
    const start = Date.now();
    let logNow = start;
    // Exercise the real refresh loop/backoff/logger, stubbing repeated SQLite
    // reads and Archive's mkdir. The log file itself uses real filesystem IO.
    db.listSessions = () => sessions;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const now = spyOn(Date, "now").mockImplementation(() => logNow);
    const unavailable = new Error("tmux unavailable");
    const hasSession = spyOn(Tmux, "hasSession").mockImplementation(async () => {
      // Full refresh failures invoke the recovery probe in the same call;
      // skipped calls probe only once and must not count as refresh failures.
      if (lastProbeCall === call) { failures++; attempts.push(call); }
      lastProbeCall = call;
      throw unavailable;
    });
    while (failures < 10_000 && call < 1_000_000) {
      call++;
      if (failures === 9999) logNow = start + 60_000;
      await daemon.refreshSessionStatuses(db);
      if (call % 1000 === 0) {
        // No million-entry mock call ledgers: assertions use explicit counters.
        mkdir.mockClear(); now.mockClear(); hasSession.mockClear();
      }
    }
    expect(failures).toBe(10_000);
    expect(call).toBe(999_328);
    expect(attempts.slice(0, 8)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(Math.max(...attempts.slice(1).map((n, i) => n - attempts[i]!))).toBe(100);
    expect(statSync(join(root, "daemon.log")).size).toBeLessThan(1024);
    const lines = logLines();
    for (const kind of ["refresh failed", "recovery failed"]) {
      const errors = lines.filter(line => line.includes(`: ${kind}:`));
      expect(errors).toHaveLength(2);
      const counted = errors.slice(1).reduce((sum, line) => sum + Number(/repeated (\d+) times/.exec(line)![1]), 1);
      expect(counted).toBe(10_000);
    }
    expect(db.getSession(id)?.status).toBe("running");
  }, 10_000);

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
    expect(new Archive(join(root, "archive")).get(id)).toMatchObject({
      status: "idle", lastOutput: "● [AHELPA:DONE]",
    });
  });

  test("explicit kill wins while a completion capture is still pending", async () => {
    const id = createSession();
    const capturing = deferred<void>();
    const releaseCapture = deferred<string>();
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    // Only the daemon's first capture is in flight. Kill takes an independent
    // snapshot before stopping tmux; the stale daemon result must not replace it.
    spyOn(Tmux, "capture").mockResolvedValue("kill-time output").mockImplementationOnce(async () => {
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
    expect(new Archive(join(root, "archive")).get(id)).toMatchObject({
      status: "dead", lastOutput: "kill-time output",
    });
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
    expect(await wait(db, [id], false, 50)).toEqual({
      sessionId: id,
      status: "idle",
      evidence: expect.objectContaining({ summaryBytes: expect.any(Number) }),
    });
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
