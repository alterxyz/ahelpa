import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Tmux } from "../src/tmux";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { refreshSessionStatuses, resetLivenessSnapshotState } from "../src/daemon";

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

describe("Kimi daemon activity", () => {
  let TEST_DB: string;
  let scratch: string;
  let db: StateDB;

  beforeEach(() => {
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(session => session.id)));
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

});

describe("refresh liveness snapshot", () => {
  let db: StateDB;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-snapshot-"));
    db = new StateDB(":memory:");
    resetLivenessSnapshotState();
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
    spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(join(root, "daemon.log"));
    spyOn(defaultRuntimeLayout, "taskFilePath").mockImplementation(id => join(root, `${id}.task`));
    spyOn(defaultRuntimeLayout, "fifoPath").mockImplementation(id => join(root, `${id}.fifo`));
    spyOn(Tmux, "capture").mockResolvedValue("Working… (esc to interrupt)");
  });
  afterEach(() => {
    mock.restore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  function create(status: "running" | "idle" | "error" = "running") {
    const id = `snapshot-${crypto.randomUUID()}`;
    db.createSession({ id, parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: root });
    if (status !== "running") db.updateStatus(id, status);
    return id;
  }

  test.each([false, true])("one snapshot for ended rows and a running row (targeted=%s)", async targeted => {
    const ended = Array.from({ length: 30 }, (_, i) => create(i % 2 ? "idle" : "error"));
    const live = create();
    const snapshot = spyOn(Tmux, "liveSessionNames").mockResolvedValue(new Set([live]));
    const has = spyOn(Tmux, "hasSession").mockImplementation(async id => id === live);
    await refreshSessionStatuses(db, targeted ? [...ended, live] : undefined);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(has).not.toHaveBeenCalled();
    expect(db.getSession(live)?.status).toBe("running");
    expect(Tmux.capture).toHaveBeenCalledTimes(1);
    expect(ended.every(id => ["idle", "error"].includes(db.getSession(id)!.status))).toBe(true);
  });

  test("snapshot failure falls back to probes without killing a live running row", async () => {
    const live = create();
    const ended = create("idle");
    const snapshot = spyOn(Tmux, "liveSessionNames").mockRejectedValue(new Error("permission denied"));
    const has = spyOn(Tmux, "hasSession").mockImplementation(async id => id === live);
    await refreshSessionStatuses(db);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(has).toHaveBeenCalledTimes(2);
    expect(has).toHaveBeenCalledWith(ended);
    expect(db.getSession(live)?.status).toBe("running");
    expect(new Archive(join(root, "archive")).get(live)).toBeNull();
  });

  test.each([false, true])("absent running row settles dead (empty server=%s)", async empty => {
    const gone = create();
    const snapshot = spyOn(Tmux, "liveSessionNames").mockResolvedValue(new Set(empty ? [] : ["unrelated-live-session"]));
    const has = spyOn(Tmux, "hasSession").mockResolvedValue(true);
    await refreshSessionStatuses(db, [gone]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(has).not.toHaveBeenCalled();
    expect(db.getSession(gone)?.status).toBe("dead");
    expect(new Archive(join(root, "archive")).get(gone)?.reason).toBe("tmux session gone");
  });

  test("backoff and capture recovery reuse the same snapshot", async () => {
    const live = create();
    const snapshot = spyOn(Tmux, "liveSessionNames").mockResolvedValue(new Set([live]));
    // The failing row's own probe still finds tmux, so only the snapshot decides.
    const has = spyOn(Tmux, "hasSession").mockResolvedValue(true);
    const capture = spyOn(Tmux, "capture").mockRejectedValue(new Error("temporary capture failure"));
    await refreshSessionStatuses(db, [live]);
    await refreshSessionStatuses(db, [live]);
    expect(db.getSession(live)?.status).toBe("running");
    snapshot.mockResolvedValue(new Set());
    await refreshSessionStatuses(db, [live]);
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(has).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(db.getSession(live)?.status).toBe("dead");
  });

  test("a row inserted while the snapshot is taken is not judged dead by it", async () => {
    const live = create();
    let inserted: string | undefined;
    const snapshot = spyOn(Tmux, "liveSessionNames").mockImplementation(async () => {
      // Rows are read before the snapshot, so this row is not compared against it.
      inserted = create();
      return new Set([live]);
    });
    const has = spyOn(Tmux, "hasSession").mockResolvedValue(false);
    await refreshSessionStatuses(db);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(inserted).toBeDefined();
    expect(has).not.toHaveBeenCalled();
    expect(db.getSession(inserted!)?.status).toBe("running");
    expect(new Archive(join(root, "archive")).get(inserted!)).toBeNull();
  });

  test("logs one line per snapshot failure/recovery transition", async () => {
    const live = create();
    const snapshot = spyOn(Tmux, "liveSessionNames").mockRejectedValue(new Error("permission denied"));
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    const livenessLines = () => readFileSync(join(root, "daemon.log"), "utf8")
      .split("\n").filter(line => line.includes("liveness snapshot"));

    for (let i = 0; i < 3; i++) await refreshSessionStatuses(db, [live]);
    expect(livenessLines()).toHaveLength(1);
    expect(livenessLines()[0]).toContain("liveness snapshot failed, probing sessions individually: permission denied");

    snapshot.mockResolvedValue(new Set([live]));
    for (let i = 0; i < 3; i++) await refreshSessionStatuses(db, [live]);
    expect(livenessLines()).toHaveLength(2);
    expect(livenessLines()[1]).toContain("liveness snapshot recovered");

    snapshot.mockRejectedValue(new Error("permission denied"));
    await refreshSessionStatuses(db, [live]);
    expect(livenessLines()).toHaveLength(3);
    expect(livenessLines()[2]).toContain("liveness snapshot failed, probing sessions individually: permission denied");
  });
});
