import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Archive } from "../src/archive";
import { runCli } from "../src/command-contract";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { MAX_TREE_KILL_PASSES, capture, clean, kill, logs, send, sendTask } from "../src/commands/session-ops";
import * as daemon from "../src/daemon";
import { getDriver } from "../src/drivers/registry";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import type { SessionStatus } from "../src/session-lifecycle";
import { settle } from "../src/settle";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";

describe("kill --tree", () => {
  let db: StateDB;
  let stopped: string[];

  function session(id: string, parentId = "host", status: SessionStatus = "running") {
    db.createSession({ id, parentId, agentType: "codex", task: "test", ownerToken: `${id}-token`, projectPath: import.meta.dir });
    if (status !== "running") db.updateStatus(id, status);
  }

  beforeEach(() => {
    db = new StateDB(":memory:");
    stopped = [];
    spyOn(Tmux, "kill").mockImplementation(async (id) => { stopped.push(id); });
    spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    db.close();
  });

  test("CLI kills three levels leaves first, returns JSON, and leaves sibling trees alone", async () => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    session("sibling");
    session("sibling-child", "sibling");
    const out: string[] = [];
    const err: string[] = [];
    expect(await runCli(db, ["kill", "root", "--token", "root-token", "--tree"], {
      print: (s) => out.push(s), printError: (s) => err.push(s),
    })).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0])).toEqual({ killed: ["grandchild", "child", "root"], missed: [] });
    expect(stopped).toEqual(["grandchild", "child", "root"]);
    for (const id of stopped) {
      expect(db.getSession(id)?.status).toBe("dead");
      expect(defaultWakeup.cleanup).toHaveBeenCalledWith(id);
    }
    expect(db.getSession("sibling")?.status).toBe("running");
    expect(db.getSession("sibling-child")?.status).toBe("running");
  });

  test("a nested target sweeps only its subtree, not its ancestor or siblings", async () => {
    session("ancestor");
    session("root", "ancestor");
    session("child", "root");
    session("sibling", "ancestor");
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
    expect(stopped).toEqual(["child", "root"]);
    expect(db.getSession("ancestor")?.status).toBe("running");
    expect(db.getSession("sibling")?.status).toBe("running");
  });

  test("re-enumeration catches a late spawn below a parent killed in the previous pass", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "root") session("late", "child");
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root", "late"], missed: [] });
    expect(stopped).toEqual(["child", "root", "late"]);
    expect(db.getSession("late")?.status).toBe("dead");
  });

  test("four passes bound continual late spawns and report the final unseen descendant", async () => {
    expect(MAX_TREE_KILL_PASSES).toBe(4);
    session("root");
    session("late-0", "root");
    let next = 1;
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id !== "root") session(`late-${next++}`, "root");
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({
      killed: ["late-0", "root", "late-1", "late-2", "late-3"], missed: ["late-4"],
    });
    expect(next).toBe(5);
    expect(db.getSession("late-4")?.status).toBe("running");
  });

  test("wrong root token stops nothing, including the root", async () => {
    session("root");
    session("child", "root");
    await expect(Promise.resolve().then(() => kill(db, "root", "wrong", { tree: true }))).rejects.toThrow("Invalid token");
    expect(stopped).toEqual([]);
    expect(defaultWakeup.cleanup).not.toHaveBeenCalled();
    expect(db.getSession("root")?.status).toBe("running");
    expect(db.getSession("child")?.status).toBe("running");
  });

  test("plain kill still stops exactly one session and prints its existing text", async () => {
    session("root");
    session("child", "root");
    const out: string[] = [];
    expect(await runCli(db, ["kill", "root", "--token", "root-token"], {
      print: (s) => out.push(s), printError: () => {},
    })).toBe(0);
    expect(out).toEqual(["killed"]);
    expect(stopped).toEqual(["root"]);
    expect(db.getSession("child")?.status).toBe("running");
  });

  test("a dead root still sweeps active descendants through settled intermediate parents", async () => {
    session("root", "host", "dead");
    session("idle", "root", "idle");
    session("dead", "root", "dead");
    session("error", "root", "error");
    session("child", "idle");
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child"], missed: [] });
    expect(stopped).toEqual(["child"]);
    expect(db.getSession("idle")?.status).toBe("idle");
  });

  test.each(["draining", "needs_attention"] as const)("%s descendants are active and get stopped", async (status) => {
    session("root");
    session("child", "root", status);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
    expect(stopped).toEqual(["child", "root"]);
  });

  test("failed descendant kills are missed, without blocking other descendants or retrying forever", async () => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "grandchild") throw new Error("kill failed");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: ["grandchild"] });
    expect(stopped).toEqual(["grandchild", "child", "root"]);
    expect(db.getSession("grandchild")?.status).toBe("running");
    expect(defaultWakeup.cleanup).not.toHaveBeenCalledWith("grandchild");
  });

  test("an already vanished descendant is stopped even if tmux kill throws", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "child") throw new Error("cannot find session");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
    expect(db.getSession("child")?.status).toBe("dead");
  });

  test("an unobservable descendant after a tmux failure is missed", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "child") throw new Error("kill failed");
    });
    spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["root"], missed: ["child"] });
    expect(db.getSession("child")?.status).toBe("running");
  });

  test("root failures still reject after attempting descendants", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "root") throw new Error("root kill failed");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    await expect(kill(db, "root", "root-token", { tree: true })).rejects.toThrow("root kill failed");
    expect(stopped).toEqual(["child", "root"]);
    expect(db.getSession("root")?.status).toBe("running");
    expect(db.getSession("child")?.status).toBe("dead");
  });

  test("a descendant settling before its turn is skipped", async () => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "grandchild") db.updateStatus("child", "idle");
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["grandchild", "root"], missed: [] });
    expect(stopped).toEqual(["grandchild", "root"]);
    expect(db.getSession("child")?.status).toBe("idle");
  });

  test("a failed descendant that subsequently settles is not missed", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "child") throw new Error("kill failed");
      db.updateStatus("child", "idle");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["root"], missed: [] });
  });

  test("explicit descendant kill invalidates a concurrent settle's row version", async () => {
    session("root");
    session("child", "root");
    const observed = db.getSession("child")!;
    await kill(db, "root", "root-token", { tree: true });
    expect(db.compareAndSetStatus("child", observed.status, "idle", observed.version)).toBe(false);
    expect(db.getSession("child")?.status).toBe("dead");
  });

  test.each(["send", "task", "logs", "capture", "resume"])("root token cannot %s a grandchild", async (op) => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    const operation = async () => {
      switch (op) {
        case "send": return send(db, "grandchild", "root-token", "hello");
        case "task": return sendTask(db, "grandchild", "root-token", "/missing-task.md");
        case "logs": return logs(db, "grandchild", "root-token");
        case "capture": return capture(db, "grandchild", "root-token");
        default: return resume({ db, sessionId: "grandchild", ownerToken: "root-token" });
      }
    };
    await expect(operation()).rejects.toThrow("Invalid token");
    expect(stopped).toEqual([]);
    expect(db.getSession("grandchild")?.status).toBe("running");
  });
});

describe("kill rework: launch reservations, clean and archive", () => {
  let db: StateDB;
  let root: string;
  let project: string;
  let savedLayout: { ahelpaDir: string; tmpDir: string };
  let savedParent: string | undefined;

  beforeEach(() => {
    const fixtures = realpathSync(tmpdir());
    mkdirSync(fixtures, { recursive: true });
    root = mkdtempSync(join(fixtures, "kill-tree-rework-"));
    project = join(root, "project");
    mkdirSync(project);
    db = new StateDB(":memory:");
    savedLayout = { ahelpaDir: defaultRuntimeLayout.ahelpaDir, tmpDir: defaultRuntimeLayout.tmpDir };
    Object.assign(defaultRuntimeLayout, { ahelpaDir: join(root, "state"), tmpDir: join(root, "runtime") });
    mkdirSync(defaultRuntimeLayout.tmpDir);
    savedParent = process.env.AHELPA_PARENT_ID;
    delete process.env.AHELPA_PARENT_ID;
    spyOn(Tmux, "capture").mockResolvedValue("last pane output");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  });

  afterEach(() => {
    mock.restore();
    db.close();
    Object.assign(defaultRuntimeLayout, savedLayout);
    if (savedParent === undefined) delete process.env.AHELPA_PARENT_ID;
    else process.env.AHELPA_PARENT_ID = savedParent;
    rmSync(root, { recursive: true, force: true });
  });

  function session(id: string, parentId = "host") {
    return db.createSession({ id, parentId, agentType: "claude-code", task: "fixture", ownerToken: `${id}-token`, projectPath: project });
  }

  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  describe("kill launch reservations", () => {
    for (const tree of [false, true]) {
      for (const boundary of ["tmux creation", "publication"] as const) {
        test(`${tree ? "tree" : "plain"} kill cancels a live launcher at ${boundary} with no terminal`, async () => {
          session("root");
          session("child", "root");
          const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", parentId: "child", projectPath: project });
          plan.driver = { ...plan.driver, prepareForTask: async () => {}, afterTaskSubmitted: async () => true };
          const reached = gate();
          const paused = gate();
          let alive = false;
          let killedReservation = false;
          const complete = spyOn(db, "completeLaunch");
          spyOn(Tmux, "capture").mockImplementation(async (id) => {
            if (id === plan.sessionId && !alive) throw new Error("no pane yet");
            return "last pane output";
          });
          spyOn(Tmux, "sendKeys").mockResolvedValue();
          spyOn(Tmux, "hasSession").mockImplementation(async (id) => id === plan.sessionId && alive);
          spyOn(Tmux, "kill").mockImplementation(async (id) => {
            if (id === plan.sessionId) {
              killedReservation = true;
              if (!alive) throw new Error("cannot find session");
              alive = false;
            }
          });
          spyOn(Tmux, "create").mockImplementation(async () => {
            if (boundary === "tmux creation") {
              reached.release();
              await paused.promise;
            }
            alive = true;
          });
          spyOn(FIFO, "create").mockImplementation(async (path) => {
            if (boundary === "publication") {
              // The terminal disappeared while startup was still unpublished.
              alive = false;
              reached.release();
              await paused.promise;
            }
            expect(await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
          });
          const launching = executeLaunch(plan);
          // Attach rejection handling before releasing the launch continuation.
          const cancelled = launching.then(() => null, (error: Error) => error);
          await reached.promise;
          let cancellation: Error | null;
          try {
            expect(db.getSession(plan.sessionId)).toMatchObject({ launchPid: process.pid, status: "running", parentId: "child" });
            expect(alive).toBe(false);
            const result = await kill(db, tree ? "root" : plan.sessionId, tree ? "root-token" : plan.ownerToken, { tree });
            if (tree) expect(result).toEqual({ killed: [plan.sessionId, "child", "root"], missed: [] });
            expect(killedReservation).toBe(true);
            expect(db.getSession(plan.sessionId)?.status).toBe("dead");
            expect(db.completeLaunch(plan.sessionId, process.pid)).toBe(false);
          } finally {
            paused.release();
            cancellation = await cancelled;
          }
          expect(cancellation?.message).toMatch(/Launch cancelled/);
          if (boundary === "publication") expect(complete.mock.results.at(-1)?.value).toBe(false);
          expect(alive).toBe(false);
          expect(db.getSession(plan.sessionId)).toBeNull();
          expect(existsSync(defaultRuntimeLayout.fifoPath(plan.sessionId))).toBe(false);
          expect(existsSync(plan.fileHandoff.taskFilePath)).toBe(false);
          expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
          if (tree) expect(db.listActiveSessions()).toEqual([]);
          else expect(db.listActiveSessions().map((s) => s.id).sort()).toEqual(["child", "root"]);
        });
      }
    }
  });

  test("clean retains a settled middle ancestor so tree kill still reaches its active grandchild", async () => {
    session("root");
    session("middle", "root");
    db.updateStatus("middle", "dead");
    session("grandchild", "middle");
    expect(await clean(db)).toEqual({ removed: 0, orphanFiles: 0 });
    expect(db.getSession("middle")?.status).toBe("dead");
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["grandchild", "root"], missed: [] });
    expect(db.listActiveSessions()).toEqual([]);
    expect(Tmux.kill).toHaveBeenNthCalledWith(1, "grandchild");
    expect(Tmux.kill).toHaveBeenNthCalledWith(2, "root");
  });

  describe("capture before kill, archive after termination", () => {
    test.each([false, true])("kill tree=%s captures each pane before termination and logs reads its archive afterwards", async (tree) => {
      session("root");
      session("child", "root");
      session("grandchild", "child");
      db.updateResumeId("root", "native-root");
      const alive = new Set(["root", "child", "grandchild"]);
      spyOn(Tmux, "hasSession").mockImplementation(async (id) => alive.has(id));
      spyOn(Tmux, "capture").mockImplementation(async (id) => {
        expect(alive.has(id)).toBe(true);
        return `pane-${id}`;
      });
      const order: string[] = [];
      spyOn(Tmux, "kill").mockImplementation(async (id) => {
        const archived = new Archive(defaultRuntimeLayout.archiveDir()).get(id);
        expect(Tmux.capture).toHaveBeenCalledWith(id, 500);
        expect(archived).toBeNull();
        order.push(id);
        alive.delete(id);
      });
      await kill(db, "root", "root-token", { tree });
      expect(order).toEqual(tree ? ["grandchild", "child", "root"] : ["root"]);
      for (const id of order) {
        const archived = new Archive(defaultRuntimeLayout.archiveDir()).get(id);
        expect(archived).toMatchObject({ status: "dead", lastOutput: `pane-${id}` });
        expect(archived?.archivedAt).toBeString();
        expect(await logs(db, id, `${id}-token`)).toBe(`pane-${id}`);
      }
      expect(new Archive(defaultRuntimeLayout.archiveDir()).get("root")?.agentResumeId).toBe("native-root");
      if (!tree) expect(alive).toEqual(new Set(["child", "grandchild"]));
    });

    for (const tree of [false, true]) {
      test.each(["capture", "save"] as const)(`kill tree=${tree} continues when %s fails`, async (failure) => {
        session("root");
        session("child", "root");
        if (failure === "capture") spyOn(Tmux, "capture").mockRejectedValue(new Error("no pane"));
        else spyOn(Archive.prototype, "save").mockImplementation(() => { throw new Error("disk full"); });
        const result = await kill(db, "root", "root-token", { tree });
        if (tree) expect(result).toEqual({ killed: ["child", "root"], missed: [] });
        expect(Tmux.capture).toHaveBeenCalledWith("root", 500);
        if (failure === "save") expect(Archive.prototype.save).toHaveBeenCalledWith("root", expect.objectContaining({ status: "dead", lastOutput: "last pane output" }));
        expect(db.getSession("root")?.status).toBe("dead");
        expect(Tmux.kill).toHaveBeenCalledWith("root");
        expect(db.getSession("child")?.status).toBe(tree ? "dead" : "running");
      });
    }

    test("an unavailable pane preserves a previous settlement archive", async () => {
      session("root");
      const archive = new Archive(defaultRuntimeLayout.archiveDir());
      archive.save("root", { status: "idle", lastOutput: "settled output" });
      spyOn(Tmux, "capture").mockRejectedValue(new Error("gone"));
      await kill(db, "root", "root-token");
      expect(await logs(db, "root", "root-token")).toBe("settled output");
    });
  });
});

describe("kill archive races", () => {
  let db: StateDB;
  let archive: Archive;
  let root: string;
  let alive: Set<string>;

  function gate<T>() {
    let release!: (value: T) => void;
    const promise = new Promise<T>((resolve) => { release = resolve; });
    return { promise, release };
  }

  beforeEach(() => {
    const fixtures = realpathSync(tmpdir());
    mkdirSync(fixtures, { recursive: true });
    root = mkdtempSync(join(fixtures, "kill-archive-races-"));
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
    db = new StateDB(":memory:");
    archive = new Archive(defaultRuntimeLayout.archiveDir());
    for (const [id, parentId] of [["root", "host"], ["child", "root"]]) {
      db.createSession({ id, parentId, agentType: "codex", task: "fixture", ownerToken: `${id}-token`, projectPath: root });
    }
    alive = new Set(["root", "child"]);
    spyOn(defaultWakeup, "notify").mockResolvedValue();
    spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => alive.has(id));
    spyOn(Tmux, "capture").mockImplementation(async (id) => `kill snapshot ${id}`);
    spyOn(Tmux, "kill").mockImplementation(async (id) => { alive.delete(id); });
  });

  afterEach(() => {
    mock.restore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const status of ["idle", "error", "needs_attention", "draining"] as const) {
    test(`tree skips a child that settles to ${status} during kill capture`, async () => {
      const entered = gate<void>();
      const captured = gate<string>();
      const initial = db.getSession("child")!;
      spyOn(Tmux, "capture").mockImplementation(async (id) => {
        if (id === "child") { entered.release(); return captured.promise; }
        return "root output";
      });
      const pending = kill(db, "root", "root-token", { tree: true });
      await entered.promise;
      let result;
      try {
        expect(await settle(db, archive, defaultWakeup, "child", status,
          { status, lastOutput: "successful final output [AHELPA:DONE]" }, "running", initial.version)).toBe(true);
      } finally {
        captured.release("old output before completion");
        result = await pending;
      }
      expect(result).toEqual({ killed: ["root"], missed: status === "needs_attention" || status === "draining" ? ["child"] : [] });
      expect(Tmux.kill).not.toHaveBeenCalledWith("child");
      expect(alive.has("child")).toBe(true);
      expect(db.getSession("child")?.status).toBe(status);
      expect(archive.get("child")).toMatchObject({ status, lastOutput: "successful final output [AHELPA:DONE]" });
      alive.delete("child");
      expect(await logs(db, "child", "child-token")).toBe("successful final output [AHELPA:DONE]");
    });
  }

  test("plain kill preserves the settlement that wins during capture", async () => {
    const entered = gate<void>();
    const captured = gate<string>();
    const initial = db.getSession("root")!;
    spyOn(Tmux, "capture").mockImplementation(async () => { entered.release(); return captured.promise; });
    const pending = kill(db, "root", "root-token");
    await entered.promise;
    try {
      expect(await settle(db, archive, defaultWakeup, "root", "idle",
        { status: "idle", lastOutput: "DONE output" }, "running", initial.version)).toBe(true);
    } finally {
      captured.release("old pane output");
      await pending;
    }
    expect(alive.has("root")).toBe(false);
    expect(db.getSession("root")?.status).toBe("idle");
    expect(archive.get("root")).toMatchObject({ status: "idle", lastOutput: "DONE output" });
    expect(await logs(db, "root", "root-token")).toBe("DONE output");
  });

  test("settle wins during tmux kill without a premature dead snapshot", async () => {
    const entered = gate<void>();
    const releaseKill = gate<void>();
    const initial = db.getSession("root")!;
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      entered.release();
      await releaseKill.promise;
      alive.delete(id);
    });
    const pending = kill(db, "root", "root-token");
    await entered.promise;
    try {
      expect(archive.get("root")).toBeNull();
      expect(db.getSession("root")).toEqual(initial);
      expect(await settle(db, archive, defaultWakeup, "root", "idle",
        { status: "idle", lastOutput: "settled DONE output" }, "running", initial.version)).toBe(true);
    } finally {
      releaseKill.release();
      await pending;
    }
    expect(db.getSession("root")?.status).toBe("idle");
    expect(archive.get("root")).toMatchObject({ status: "idle", lastOutput: "settled DONE output" });
    expect(await logs(db, "root", "root-token")).toBe("settled DONE output");
  });

  test("kill commits after termination and rejects a delayed settle", async () => {
    const initial = db.getSession("root")!;
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      expect(archive.get(id)).toBeNull();
      expect(db.getSession(id)).toEqual(initial);
      alive.delete(id);
    });
    await kill(db, "root", "root-token");
    expect(await settle(db, archive, defaultWakeup, "root", "idle",
      { status: "idle", lastOutput: "stale daemon DONE output" }, "running", initial.version)).toBe(false);
    expect(db.getSession("root")?.status).toBe("dead");
    expect(archive.get("root")).toMatchObject({ status: "dead", lastOutput: "kill snapshot root" });
  });

  for (const status of ["running", "idle"] as const) {
    test(`failed kill of ${status} session leaves its row and archive untouched`, async () => {
      if (status === "idle") {
        db.updateStatus("root", status);
        archive.save("root", { status, lastOutput: "successful settled output" });
      }
      const initial = db.getSession("root");
      const previousArchive = archive.get("root");
      spyOn(Tmux, "kill").mockRejectedValue(new Error("permission denied"));
      await expect(kill(db, "root", "root-token")).rejects.toThrow("permission denied");
      expect(db.getSession("root")).toEqual(initial);
      expect(archive.get("root")).toEqual(previousArchive);
      expect(defaultWakeup.cleanup).not.toHaveBeenCalled();
    });
  }

  for (const status of ["idle", "draining", "error", "needs_attention", "dead"] as const) {
    test(`explicit kill of ${status} with a live terminal keeps the existing DONE archive`, async () => {
      db.updateStatus("root", status);
      archive.save("root", { status: "idle", lastOutput: "successful settled output [AHELPA:DONE]" });
      const previousArchive = archive.get("root");
      spyOn(Tmux, "capture").mockResolvedValue("shell prompt after /exit");
      await kill(db, "root", "root-token");
      expect(alive.has("root")).toBe(false);
      expect(db.getSession("root")?.status).toBe("dead");
      expect(archive.get("root")).toEqual(previousArchive);
      expect(await logs(db, "root", "root-token")).toBe("successful settled output [AHELPA:DONE]");
    });
  }
});

describe("kill non-settle races", () => {
  let db: StateDB;
  let archive: Archive;
  let root: string;
  let alive: Set<string>;
  let savedParent: string | undefined;

  function gate<T>() {
    let release!: (value: T) => void;
    const promise = new Promise<T>((resolve) => { release = resolve; });
    return { promise, release };
  }

  beforeEach(() => {
    const fixtures = realpathSync(tmpdir());
    mkdirSync(fixtures, { recursive: true });
    root = mkdtempSync(join(fixtures, "kill-nonsettle-"));
    savedParent = process.env.AHELPA_PARENT_ID;
    delete process.env.AHELPA_PARENT_ID;
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
    spyOn(defaultRuntimeLayout, "fifoPath").mockImplementation((id) => join(root, `${id}.pipe`));
    spyOn(defaultRuntimeLayout, "taskFilePath").mockImplementation((id) => join(root, `${id}.md`));
    db = new StateDB(":memory:");
    archive = new Archive(defaultRuntimeLayout.archiveDir());
    alive = new Set(["root", "child"]);
    for (const [id, parentId] of [["root", "host"], ["child", "root"]]) {
      db.createSession({ id, parentId, agentType: "claude-code", task: "fixture", ownerToken: `${id}-token`, projectPath: root });
    }
    spyOn(Tmux, "capture").mockImplementation(async (id) => `captured output ${id}`);
    spyOn(Tmux, "kill").mockImplementation(async (id) => { alive.delete(id); });
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => alive.has(id));
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(defaultWakeup, "notify").mockResolvedValue();
  });

  afterEach(() => {
    mock.restore();
    db.close();
    if (savedParent === undefined) delete process.env.AHELPA_PARENT_ID;
    else process.env.AHELPA_PARENT_ID = savedParent;
    rmSync(root, { recursive: true, force: true });
  });

  for (const tree of [false, true]) {
    for (const writer of ["updateModel", "markNudged", "updateResumeId"] as const) {
      test(`${tree ? "tree" : "plain"} kill commits despite ${writer} during capture`, async () => {
        const target = tree ? "child" : "root";
        const entered = gate<void>();
        const captured = gate<string>();
        await defaultWakeup.prepare(target);
        spyOn(Tmux, "capture").mockImplementation(async (id) => {
          if (id === target) { entered.release(); return captured.promise; }
          return `captured output ${id}`;
        });
        const pending = kill(db, "root", "root-token", { tree });
        await entered.promise;
        try {
          if (writer === "updateModel") db.updateModel(target, "new-model", null);
          if (writer === "markNudged") db.markNudged(target);
          if (writer === "updateResumeId") db.updateResumeId(target, "native-token");
        } finally {
          captured.release(`captured output ${target}`);
        }
        const result = await pending;
        if (tree) expect(result).toEqual({ killed: ["child", "root"], missed: [] });
        expect(db.getSession(target)?.status).toBe("dead");
        expect(archive.get(target)).toMatchObject({ status: "dead", lastOutput: `captured output ${target}` });
        if (writer === "updateResumeId") expect(archive.get(target)?.agentResumeId).toBe("native-token");
        expect(existsSync(defaultRuntimeLayout.fifoPath(target))).toBe(false);
        expect(alive.has(target)).toBe(false);
        expect(await logs(db, target, `${target}-token`)).toBe(`captured output ${target}`);
      });
    }
  }

  for (const confirmed of [false, true]) {
    test(`actual launch publication during capture (confirmed=${confirmed}) is cancelled by kill`, async () => {
      process.env.AHELPA_PARENT_ID = "root";
      const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", parentId: "root", projectPath: root });
      plan.driver = { ...plan.driver, prepareForTask: async () => {}, afterTaskSubmitted: async () => confirmed };
      spyOn(Tmux, "create").mockImplementation(async (id) => { alive.add(id); });
      const atPublication = gate<void>();
      const publish = gate<void>();
      const killCapture = gate<void>();
      const captured = gate<string>();
      const realPrepare = defaultWakeup.prepare.bind(defaultWakeup);
      spyOn(defaultWakeup, "prepare").mockImplementation(async (id) => {
        atPublication.release();
        await publish.promise;
        await realPrepare(id);
      });
      spyOn(Tmux, "capture").mockImplementation(async (id, lines) => {
        if (id === plan.sessionId && lines === 500) { killCapture.release(); return captured.promise; }
        return `Please read and complete the task described in ${plan.fileHandoff.taskFilePath}.`;
      });
      const launching = executeLaunch(plan);
      await atPublication.promise;
      expect(db.getSession(plan.sessionId)?.launchPid).toBe(process.pid);
      const pending = kill(db, "root", "root-token", { tree: true });
      await killCapture.promise;
      try {
        publish.release();
        await launching;
        expect(db.getSession(plan.sessionId)?.launchPid).toBeNull();
      } finally {
        captured.release("live task output");
      }
      expect(await pending).toEqual({ killed: ["child", plan.sessionId, "root"], missed: [] });
      expect(db.getSession(plan.sessionId)?.status).toBe("dead");
      expect(archive.get(plan.sessionId)?.lastOutput).toBe("live task output");
      expect(existsSync(defaultRuntimeLayout.fifoPath(plan.sessionId))).toBe(false);
      expect(alive.has(plan.sessionId)).toBe(false);
    });
  }

  for (const tree of [false, true]) {
    for (const operation of ["send", "task"] as const) {
      test(`${operation} re-arms monitoring during ${tree ? "tree" : "plain"} kill`, async () => {
        const target = tree ? "child" : "root";
        db.updateStatus(target, "needs_attention");
        archive.save(target, { status: "needs_attention", lastOutput: "previous turn output" });
        const previousArchive = archive.get(target);
        spyOn(getDriver("claude-code"), "afterTaskSubmitted").mockResolvedValue(true);
        const entered = gate<void>();
        const releaseKill = gate<void>();
        spyOn(Tmux, "kill").mockImplementation(async (id) => {
          if (id === target) { entered.release(); await releaseKill.promise; }
          alive.delete(id);
        });
        const pending = kill(db, "root", "root-token", { tree });
        await entered.promise;
        try {
          if (operation === "send") await send(db, target, `${target}-token`, "answer and continue");
          else {
            const taskPath = join(root, "follow-up.md");
            writeFileSync(taskPath, "continue the task");
            await sendTask(db, target, `${target}-token`, taskPath);
          }
          expect(db.getSession(target)?.status).toBe("running");
        } finally { releaseKill.release(); }
        const result = await pending;
        if (tree) expect(result).toEqual({ killed: ["child", "root"], missed: [] });
        expect(db.getSession(target)?.status).toBe("dead");
        expect(existsSync(defaultRuntimeLayout.fifoPath(target))).toBe(false);
        expect(archive.get(target)).toEqual(previousArchive);
      });
    }
  }

  for (const status of ["draining", "needs_attention"] as const) {
    test(`tree kills ${status} with a metadata bump and no newer settlement archive`, async () => {
      db.updateStatus("child", status);
      await defaultWakeup.prepare("child");
      spyOn(Tmux, "capture").mockImplementation(async (id) => {
        if (id === "child") db.markNudged(id);
        return `captured output ${id}`;
      });
      expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
      expect(db.getSession("child")?.status).toBe("dead");
      expect(archive.get("child")?.lastOutput).toBe("captured output child");
      expect(existsSync(defaultRuntimeLayout.fifoPath("child"))).toBe(false);
    });
  }

  for (const status of ["idle", "error", "needs_attention", "draining", "dead"] as const) {
    test(`settle to ${status} during termination keeps its result and avoids killed/missed overlap`, async () => {
      await defaultWakeup.prepare("child");
      spyOn(Tmux, "kill").mockImplementation(async (id) => {
        if (id === "child") {
          const current = db.getSession(id)!;
          expect(await settle(db, archive, defaultWakeup, id, status,
            { status, lastOutput: "settled output" }, current.status, current.version)).toBe(true);
        }
        alive.delete(id);
      });
      expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
      expect(db.getSession("child")?.status).toBe(status);
      expect(archive.get("child")).toMatchObject({ status, lastOutput: "settled output" });
    });
  }

  test("a same-millisecond identical settle archive is still a settlement winner", async () => {
    spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-09T00:00:00.000Z");
    archive.save("root", { status: "needs_attention", lastOutput: "same output" });
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      const current = db.getSession(id)!;
      await settle(db, archive, defaultWakeup, id, "needs_attention",
        { status: "needs_attention", lastOutput: "same output" }, current.status, current.version);
      alive.delete(id);
    });
    await kill(db, "root", "root-token");
    expect(db.getSession("root")?.status).toBe("needs_attention");
    expect(archive.get("root")?.lastOutput).toBe("same output");
  });

  test("clean deletes a row during termination without resurrection or archive overwrite", async () => {
    db.updateStatus("root", "idle");
    archive.save("root", { status: "idle", lastOutput: "settled DONE" });
    const previousArchive = archive.get("root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      alive.delete(id);
      db.updateStatus("child", "dead");
      alive.delete("child");
      expect((await clean(db)).removed).toBe(2);
    });
    await kill(db, "root", "root-token");
    expect(db.getSession("root")).toBeNull();
    expect(archive.get("root")).toEqual(previousArchive);
  });

  test("a second version conflict is retried without recapturing or killing again", async () => {
    await defaultWakeup.prepare("root");
    const realCAS = db.compareAndSetStatus.bind(db);
    let conflicts = 0;
    spyOn(db, "compareAndSetStatus").mockImplementation((id, expected, status, version) => {
      if (id === "root" && conflicts++ < 2) db.markNudged(id);
      return realCAS(id, expected, status, version);
    });
    await kill(db, "root", "root-token");
    expect(conflicts).toBe(3);
    expect(db.getSession("root")?.status).toBe("dead");
    expect(archive.get("root")?.lastOutput).toBe("captured output root");
    expect(existsSync(defaultRuntimeLayout.fifoPath("root"))).toBe(false);
    expect(Tmux.capture).toHaveBeenCalledTimes(1);
    expect(Tmux.kill).toHaveBeenCalledTimes(1);
  });

  test("a reservation with a metadata bump and no terminal is cancelled", async () => {
    db.createSession({ id: "reserved", parentId: "root", agentType: "codex", task: "fixture",
      ownerToken: "reserved-token", projectPath: root, launchPid: process.pid });
    spyOn(Tmux, "capture").mockImplementation(async (id) => {
      db.markNudged(id);
      throw new Error("no pane yet");
    });
    spyOn(Tmux, "kill").mockRejectedValue(new Error("no terminal yet"));
    await kill(db, "reserved", "reserved-token");
    expect(db.getSession("reserved")?.status).toBe("dead");
    expect(db.completeLaunch("reserved", process.pid)).toBe(false);
  });

  test("archive failure after a version bump still commits dead and cleans the FIFO", async () => {
    await defaultWakeup.prepare("root");
    spyOn(Tmux, "capture").mockImplementation(async (id) => {
      db.markNudged(id);
      return "captured output";
    });
    spyOn(Archive.prototype, "save").mockImplementation(() => { throw new Error("disk full"); });
    await kill(db, "root", "root-token");
    expect(db.getSession("root")?.status).toBe("dead");
    expect(existsSync(defaultRuntimeLayout.fifoPath("root"))).toBe(false);
    expect(archive.get("root")).toBeNull();
  });

  test("exhausted retries report a descendant as missed without claiming it was committed", async () => {
    const realCAS = db.compareAndSetStatus.bind(db);
    let conflicts = 0;
    spyOn(db, "compareAndSetStatus").mockImplementation((id, expected, status, version) => {
      if (id === "child") { conflicts++; db.markNudged(id); }
      return realCAS(id, expected, status, version);
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["root"], missed: ["child"] });
    expect(conflicts).toBe(3);
    expect(archive.get("child")).toBeNull();
    expect(Tmux.kill).toHaveBeenCalledTimes(2);
  });

  test("plain kill reports exhausted retries instead of returning success", async () => {
    const realCAS = db.compareAndSetStatus.bind(db);
    let conflicts = 0;
    spyOn(db, "compareAndSetStatus").mockImplementation((id, expected, status, version) => {
      conflicts++;
      db.markNudged(id);
      return realCAS(id, expected, status, version);
    });
    await expect(kill(db, "root", "root-token")).rejects.toThrow("changed repeatedly after termination");
    expect(conflicts).toBe(3);
  });
});
