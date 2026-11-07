import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Tmux } from "../src/tmux";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { refreshSessionStatuses, resetLivenessSnapshotState } from "../src/daemon";

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
    const has = spyOn(Tmux, "hasSession").mockResolvedValue(false);
    const capture = spyOn(Tmux, "capture").mockRejectedValue(new Error("temporary capture failure"));
    await refreshSessionStatuses(db, [live]);
    await refreshSessionStatuses(db, [live]);
    expect(db.getSession(live)?.status).toBe("running");
    snapshot.mockResolvedValue(new Set());
    await refreshSessionStatuses(db, [live]);
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(has).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(db.getSession(live)?.status).toBe("dead");
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
