import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Archive } from "../src/archive";
import { send } from "../src/commands/session-ops";
import * as daemon from "../src/daemon";
import { getDriver } from "../src/drivers/registry";
import { defaultRuntimeLayout, RuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("settle observed row version", () => {
  let root: string;
  let layout: RuntimeLayout;
  let db: StateDB;
  let hostDb: StateDB | undefined;
  const id = "aba-session";
  const frozenNow = Date.parse("2026-01-01T00:00:00.999Z");

  beforeEach(() => {
    root = mkdtempSync(join(process.cwd(), ".ahelpa-aba-test-"));
    layout = new RuntimeLayout({ ahelpaDir: join(root, "state"), tmpDir: join(root, "runtime") });
    spyOn(defaultRuntimeLayout, "ahelpaHomeDir").mockReturnValue(layout.ahelpaHomeDir());
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(layout.archiveDir());
    spyOn(defaultRuntimeLayout, "needHelpLedgerPath").mockReturnValue(layout.needHelpLedgerPath());
    spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(layout.daemonLogPath());
    spyOn(defaultRuntimeLayout, "taskFilePath").mockImplementation((sid) => layout.taskFilePath(sid));
    spyOn(defaultRuntimeLayout, "fifoPath").mockImplementation((sid) => layout.fifoPath(sid));
    mkdirSync(layout.tmpDir, { recursive: true });
    setSystemTime(frozenNow);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(getDriver("codex"), "afterTaskSubmitted").mockResolvedValue(true);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(defaultWakeup, "prepare").mockResolvedValue();
    spyOn(defaultWakeup, "notify").mockResolvedValue();
    spyOn(defaultWakeup, "cleanup").mockReturnValue();
    db = new StateDB(join(root, "state.db"));
    db.createSession({ id, parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
  });

  afterEach(() => {
    mock.restore();
    setSystemTime();
    hostDb?.close();
    hostDb = undefined;
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function ledgerLines(): string[] {
    return existsSync(layout.needHelpLedgerPath())
      ? readFileSync(layout.needHelpLedgerPath(), "utf8").trim().split("\n")
      : [];
  }

  for (const separateConnection of [false, true]) {
    test(`stale capture cannot settle after intervention rearm (${separateConnection ? "separate connections" : "same connection"})`, async () => {
      if (separateConnection) hostDb = new StateDB(join(root, "state.db"));
      const interveningDb = hostDb ?? db;
      const original = db.getSession(id)!;
      const capturing = deferred<void>();
      const staleCapture = deferred<string>();
      const needHelp = "[AHELPA:NEED_HELP:review]";
      let captures = 0;
      const capture = spyOn(Tmux, "capture").mockImplementation(async () => {
        if (++captures === 1) {
          capturing.resolve();
          return staleCapture.promise;
        }
        return needHelp;
      });
      const save = spyOn(Archive.prototype, "save");
      const delayedRefresh = daemon.refreshSessionStatuses(db, [id]);
      let rearmed = original;
      let firstLines: string[] = [];
      try {
        await capturing.promise;
        await daemon.refreshSessionStatuses(interveningDb, [id]);
        const settled = interveningDb.getSession(id)!;
        expect(settled.status).toBe("error");
        expect(settled.version).toBe(original.version + 1);
        expect(Date.parse(settled.updatedAt)).toBe(frozenNow);
        firstLines = ledgerLines();
        expect(firstLines).toHaveLength(1);

        // Exercise the actual send intervention path, with all helper I/O stubbed.
        await send(interveningDb, id, "tok", "Missing detail");
        rearmed = interveningDb.getSession(id)!;
        expect(rearmed.status).toBe("running");
        expect(rearmed.version).toBe(original.version + 2);
        expect(Date.parse(rearmed.updatedAt)).toBe(frozenNow);
        expect(defaultWakeup.prepare).toHaveBeenCalledTimes(1);
      } finally {
        staleCapture.resolve(needHelp);
        await delayedRefresh;
      }

      expect(db.getSession(id)).toEqual(rearmed);
      expect(save).toHaveBeenCalledTimes(1);
      expect(new Archive(layout.archiveDir()).get(id)?.lastOutput).toBe(needHelp);
      expect(defaultWakeup.notify).toHaveBeenCalledTimes(1);
      expect(defaultWakeup.cleanup).toHaveBeenCalledTimes(1);
      expect(ledgerLines()).toEqual(firstLines);

      // The next turn's fresh snapshot still settles and records its own event.
      capture.mockResolvedValue("[AHELPA:NEED_HELP:input]");
      await daemon.refreshSessionStatuses(db, [id]);
      expect(db.getSession(id)?.status).toBe("error");
      expect(save).toHaveBeenCalledTimes(2);
      expect(defaultWakeup.notify).toHaveBeenCalledTimes(2);
      expect(ledgerLines().map((line) => JSON.parse(line).tags)).toEqual([["review"], ["input"]]);
    });
  }

  test("missing-session settle rejects a delayed liveness result after intervention rearm", async () => {
    hostDb = new StateDB(join(root, "state.db"));
    const checking = deferred<void>();
    const staleLiveness = deferred<boolean>();
    let checks = 0;
    spyOn(Tmux, "hasSession").mockImplementation(async () => {
      if (++checks === 1) {
        checking.resolve();
        return staleLiveness.promise;
      }
      return true;
    });
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP:review]");
    const save = spyOn(Archive.prototype, "save");
    const original = db.getSession(id)!;
    const delayedRefresh = daemon.refreshSessionStatuses(db, [id]);
    let rearmed = original;
    let firstLines: string[] = [];
    try {
      await checking.promise;
      await daemon.refreshSessionStatuses(hostDb, [id]);
      expect(hostDb.getSession(id)?.status).toBe("error");
      firstLines = ledgerLines();
      await send(hostDb, id, "tok", "Missing detail");
      rearmed = hostDb.getSession(id)!;
      expect(rearmed.status).toBe("running");
      expect(rearmed.version).toBe(original.version + 2);
      // Mark resources owned by the rearmed turn; a stale result cannot reclaim them.
      writeFileSync(layout.taskFilePath(id), "new turn task");
      writeFileSync(layout.fifoPath(id), "new turn pipe marker");
    } finally {
      staleLiveness.resolve(false);
      await delayedRefresh;
    }

    expect(db.getSession(id)).toEqual(rearmed);
    expect(save).toHaveBeenCalledTimes(1);
    expect(new Archive(layout.archiveDir()).get(id)?.status).toBe("error");
    expect(defaultWakeup.notify).toHaveBeenCalledTimes(1);
    expect(defaultWakeup.cleanup).toHaveBeenCalledTimes(1);
    expect(ledgerLines()).toEqual(firstLines);
    expect(existsSync(layout.taskFilePath(id))).toBe(true);
    expect(readFileSync(layout.taskFilePath(id), "utf8")).toBe("new turn task");
    expect(existsSync(layout.fifoPath(id))).toBe(true);
  });

  test("a normal refresh settles, archives, notifies and records exactly once", async () => {
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP]");
    const save = spyOn(Archive.prototype, "save");

    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);

    expect(db.getSession(id)?.status).toBe("error");
    expect(save).toHaveBeenCalledTimes(1);
    expect(defaultWakeup.notify).toHaveBeenCalledTimes(1);
    expect(defaultWakeup.cleanup).toHaveBeenCalledTimes(1);
    expect(ledgerLines()).toHaveLength(1);
  });

  test("all row writes advance the version across connections and a backwards clock", () => {
    hostDb = new StateDB(join(root, "state.db"));
    let previous = db.getSession(id)!.version;
    const expectAdvance = () => {
      const current = db.getSession(id)!.version;
      expect(current).toBe(previous + 1);
      previous = current;
    };

    db.updateStatus(id, "error");
    expectAdvance();
    setSystemTime(frozenNow - 60_000);
    expect(hostDb.compareAndSetStatus(id, "error", "running", previous)).toBe(true);
    expectAdvance();
    db.updateResumeId(id, "resume-token");
    expectAdvance();
    hostDb.updateModel(id, "updated-model", "high");
    expectAdvance();
    db.updateStatus(id, "running");
    expectAdvance();

    const rearmed = db.getSession(id);
    expect(hostDb.compareAndSetStatus(id, "error", "idle", previous)).toBe(false);
    expect(hostDb.compareAndSetStatus(id, "running", "error", 0)).toBe(false);
    expect(db.getSession(id)).toEqual(rearmed);
    expect(Date.parse(rearmed!.updatedAt)).toBe(frozenNow - 60_000);

    setSystemTime(frozenNow + 60_000);
    db.updateStatus(id, "error");
    expectAdvance();
    expect(Date.parse(db.getSession(id)!.updatedAt)).toBe(frozenNow + 60_000);
  });

  test("cold monitor reclaims a completed session after clock rollback without delaying drain", async () => {
    const beforeRollback = Date.parse("2026-01-01T01:00:00.000Z");
    const afterRollback = beforeRollback - 3_600_000;
    const sid = "cold-drain";
    setSystemTime(beforeRollback);
    db.createSession({ id: sid, parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
    setSystemTime(afterRollback);
    db.updateStatus(sid, "idle");
    expect(db.compareAndSetStatus(sid, "idle", "draining")).toBe(true);
    db.updateResumeId(sid, "synthetic-resume");
    const draining = db.getSession(sid)!;
    expect(draining.version).toBe(3);
    expect(draining.updatedAt).toBe(new Date(afterRollback).toISOString());
    const kill = spyOn(Tmux, "kill").mockResolvedValue();

    // This session has never been polled, so the monitor uses persisted wall time.
    await daemon.refreshSessionStatuses(db, [sid], afterRollback + 14_000);
    expect(kill).not.toHaveBeenCalled();
    expect(db.getSession(sid)?.status).toBe("draining");
    await daemon.refreshSessionStatuses(db, [sid], afterRollback + 16_000);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(sid);
    expect(db.getSession(sid)?.status).toBe("idle");
    expect(db.getSession(sid)?.version).toBe(4);
    await daemon.refreshSessionStatuses(db, [sid], afterRollback + 32_000);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
