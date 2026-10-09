import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { Archive } from "../src/archive";
import { executeLaunch, planLaunch } from "../src/commands/launch";
import { clean, kill, logs } from "../src/commands/session-ops";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";

let db: StateDB;
let root: string;
let project: string;
let savedLayout: { ahelpaDir: string; tmpDir: string };
let savedParent: string | undefined;

beforeEach(() => {
  const fixtures = join(import.meta.dir, "..", ".ahelpa");
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

describe("archive before kill", () => {
  test.each([false, true])("kill tree=%s archives each pane before termination and logs reads it afterwards", async (tree) => {
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
      expect(archived).toMatchObject({ status: "dead", lastOutput: `pane-${id}` });
      expect(archived?.archivedAt).toBeString();
      order.push(id);
      alive.delete(id);
    });
    await kill(db, "root", "root-token", { tree });
    expect(order).toEqual(tree ? ["grandchild", "child", "root"] : ["root"]);
    for (const id of order) expect(await logs(db, id, `${id}-token`)).toBe(`pane-${id}`);
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
