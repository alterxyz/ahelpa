import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { clean, kill } from "../src/commands/session-ops";
import { getDriver } from "../src/drivers/registry";
import { listActiveDescendants } from "../src/nesting";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";
import * as daemon from "../src/daemon";

let db: StateDB;
let root: string;
let project: string;
let savedLayout: { ahelpaDir: string; tmpDir: string };
let savedParent: string | undefined;
let alive: Set<string>;

beforeEach(() => {
  const fixtures = join(import.meta.dir, "..", ".ahelpa");
  mkdirSync(fixtures, { recursive: true });
  root = mkdtempSync(join(fixtures, "kill-tree-rollback-"));
  project = join(root, "project");
  mkdirSync(project);
  db = new StateDB(":memory:");
  savedLayout = { ahelpaDir: defaultRuntimeLayout.ahelpaDir, tmpDir: defaultRuntimeLayout.tmpDir };
  Object.assign(defaultRuntimeLayout, { ahelpaDir: join(root, "state"), tmpDir: join(root, "runtime") });
  savedParent = process.env.AHELPA_PARENT_ID;
  delete process.env.AHELPA_PARENT_ID;
  alive = new Set();
  spyOn(Tmux, "create").mockImplementation(async (id) => { alive.add(id); });
  spyOn(Tmux, "kill").mockImplementation(async (id) => { alive.delete(id); });
  spyOn(Tmux, "capture").mockResolvedValue("working");
  spyOn(Tmux, "hasSession").mockImplementation(async (id) => alive.has(id));
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(defaultWakeup, "prepare").mockResolvedValue();
  spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  spyOn(getDriver("claude-code"), "prepareForResume").mockResolvedValue();
});

afterEach(() => {
  mock.restore();
  db.close();
  Object.assign(defaultRuntimeLayout, savedLayout);
  if (savedParent === undefined) delete process.env.AHELPA_PARENT_ID;
  else process.env.AHELPA_PARENT_ID = savedParent;
  rmSync(root, { recursive: true, force: true });
});

function session(id: string, parentId = "host", resumedFrom?: string) {
  return db.createSession({ id, parentId, resumedFrom, agentType: "claude-code", task: "fixture", ownerToken: `${id}-token`, projectPath: project });
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function launchPlan(parentId: string) {
  const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", parentId, projectPath: project });
  plan.driver = { ...plan.driver, prepareForTask: async () => {}, afterTaskSubmitted: async () => true };
  return plan;
}

for (const kind of ["launch", "resume"] as const) {
  test(`${kind} rollback retains a late child's ancestor until the next tree pass kills it`, async () => {
    session("root");
    alive.add("root");
    process.env.AHELPA_PARENT_ID = "root";
    let childId = "";
    const childAtPublish = gate();
    const childPublish = gate();
    const grandchildAtPublish = gate();
    const grandchildPublish = gate();
    let grandchildId = "";
    let grandchildCancelled: Promise<Error | null> | undefined;
    let childCancelled!: Promise<Error | null>;
    let inserted = false;
    let tombstoneObserved = false;
    spyOn(defaultWakeup, "prepare").mockImplementation(async (id) => {
      if (!childId) childId = id;
      if (id === childId) { childAtPublish.release(); await childPublish.promise; }
      else if (id === grandchildId) { grandchildAtPublish.release(); await grandchildPublish.promise; }
    });
    spyOn(Tmux, "capture").mockImplementation(async (id) => {
      if (id === "root" && inserted) {
        // Force rollback before tree kill's next enumeration, reproducing the
        // review probe's lineage-breaking schedule without timing sleeps.
        childPublish.release();
        expect((await childCancelled)?.message).toMatch(/Launch cancelled/);
        expect(db.getSession(childId)).toMatchObject({ status: "dead", launchPid: null, parentId: "root" });
        expect(listActiveDescendants(db, "root").map((s) => s.id)).toEqual([grandchildId]);
        tombstoneObserved = true;
      }
      return "working";
    });
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      if (id === childId && !inserted) {
        inserted = true;
        process.env.AHELPA_PARENT_ID = childId;
        const grandchild = launchPlan(childId);
        grandchildId = grandchild.sessionId;
        grandchildCancelled = executeLaunch(grandchild).then(() => null, (error: Error) => error);
        await grandchildAtPublish.promise;
        process.env.AHELPA_PARENT_ID = "root";
      }
      alive.delete(id);
    });
    if (kind === "launch") {
      const child = launchPlan("root");
      childId = child.sessionId;
      childCancelled = executeLaunch(child).then(() => null, (error: Error) => error);
    } else {
      session("old", "root");
      db.updateStatus("old", "dead");
      db.updateResumeId("old", "native-resume-token");
      childCancelled = resume({ db, sessionId: "old", ownerToken: "old-token" }).then(() => null, (error: Error) => error);
    }
    await childAtPublish.promise;
    try {
      expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: [childId, "root", grandchildId], missed: [] });
      expect(tombstoneObserved).toBe(true);
      expect(alive.size).toBe(0);
      expect(db.getSession(childId)).toMatchObject({ status: "dead", launchPid: null });
    } finally {
      childPublish.release();
      grandchildPublish.release();
      await childCancelled;
      await grandchildCancelled;
    }
    expect(db.getSession(grandchildId)).toBeNull();
    await clean(db);
    expect(db.getSession(childId)).toBeNull();
  });

  test(`${kind} failure retains active resume ancestry without a direct child`, async () => {
    let failedId = "";
    const failure = new Error("startup failed after nested resume registered");
    const retainResume = async (id: string) => {
      failedId = id;
      session("active-resume", "host", id);
      throw failure;
    };
    if (kind === "launch") {
      const plan = launchPlan("host");
      plan.driver.prepareForTask = retainResume;
      await expect(executeLaunch(plan)).rejects.toThrow(failure.message);
    } else {
      session("old");
      db.updateStatus("old", "dead");
      db.updateResumeId("old", "native-resume-token");
      spyOn(getDriver("claude-code"), "prepareForResume").mockImplementation(retainResume);
      await expect(resume({ db, sessionId: "old", ownerToken: "old-token" })).rejects.toThrow(failure.message);
    }
    expect(db.listSessions(failedId)).toEqual([]);
    expect(db.getSession(failedId)).toMatchObject({ status: "dead", launchPid: null });
    expect(alive.has(failedId)).toBe(false);
    await clean(db);
    expect(db.getSession(failedId)).not.toBeNull();
    db.updateStatus("active-resume", "dead");
    await clean(db);
    expect(db.getSession(failedId)).toBeNull();
  });
}

test("failed launch retains a settled direct child then clean reclaims both", async () => {
  const plan = launchPlan("host");
  plan.driver.prepareForTask = async () => {
    session("settled-child", plan.sessionId);
    db.updateStatus("settled-child", "idle");
    throw new Error("startup failed");
  };
  await expect(executeLaunch(plan)).rejects.toThrow("startup failed");
  expect(db.getSession(plan.sessionId)).toMatchObject({ status: "dead", launchPid: null });
  expect(await clean(db)).toEqual({ removed: 2, orphanFiles: 0 });
  expect(db.listSessions()).toEqual([]);
});
