import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB, type CreateSessionInput } from "../src/state";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { clean, kill, send } from "../src/commands/session-ops";
import { getDriver } from "../src/drivers/registry";
import { getSessionNestingInfo, listActiveSessionsInTree } from "../src/nesting";
import { planFileHandoff } from "../src/file-handoff";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";

const envKeys = ["AHELPA_PARENT_ID", "AHELPA_JOB_ID", "AHELPA_MAX_NESTING_DEPTH", "AHELPA_MAX_ACTIVE_PER_TREE"] as const;
let db: StateDB;
let root: string;
let project: string;
let savedEnv: (string | undefined)[];
let savedLayout: { ahelpaDir: string; tmpDir: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ahelpa-reservation-"));
  project = join(root, "project");
  mkdirSync(project);
  db = new StateDB(join(root, "state.db"));
  savedEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) delete process.env[key];
  savedLayout = { ahelpaDir: defaultRuntimeLayout.ahelpaDir, tmpDir: defaultRuntimeLayout.tmpDir };
  Object.assign(defaultRuntimeLayout, { ahelpaDir: join(root, "state"), tmpDir: join(root, "runtime") });
  mkdirSync(defaultRuntimeLayout.tmpDir);
  spyOn(Tmux, "create").mockResolvedValue();
  spyOn(Tmux, "kill").mockResolvedValue();
  spyOn(Tmux, "hasSession").mockResolvedValue(false);
  spyOn(Tmux, "capture").mockResolvedValue("");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  // Use a real isolated pipe so cleanup assertions verify a created resource.
  spyOn(FIFO, "create").mockImplementation(async (path) => {
    expect(await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  });
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  const driver = getDriver("claude-code");
  spyOn(driver, "buildLaunchCommand").mockReturnValue("true");
  spyOn(driver, "buildResumeCommand").mockReturnValue("true");
  spyOn(driver, "prepareForTask").mockResolvedValue();
  spyOn(driver, "prepareForResume").mockResolvedValue();
  spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
  spyOn(driver, "gracefulExit").mockResolvedValue();
});

afterEach(() => {
  mock.restore();
  db.close();
  Object.assign(defaultRuntimeLayout, savedLayout);
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  rmSync(root, { recursive: true, force: true });
});

function record(id: string, extra: Partial<CreateSessionInput> = {}) {
  return db.createSession({ id, parentId: "host", agentType: "claude-code", task: "fixture", ownerToken: "tok", projectPath: project, ...extra });
}

function resumable(id = "old", extra: Partial<CreateSessionInput> = {}) {
  record(id, extra);
  db.updateStatus(id, "dead");
  db.updateResumeId(id, "native-resume-id");
}

function fullTree(id = "root") {
  record(id);
  for (let index = 0; index < 7; index++) record(`${id}-child-${index}`, { parentId: id, depth: 2 });
}

async function initializeFixtureRepository() {
  await $`git -C ${project} init -q`.quiet();
  await $`git -C ${project} -c user.name=fixture -c user.email=fixture@example.invalid commit --allow-empty -qm initial`.quiet();
}

async function expectWorktreeRemoved(path: string, id: string) {
  expect(existsSync(path)).toBe(false);
  expect(await $`git -C ${project} worktree list`.text()).not.toContain(id);
  expect((await $`git -C ${project} branch --list ${`ahelpa/${id}`}`.text()).trim()).toBe("");
}

describe("PR6 resume reservation ancestry", () => {
  test("refuses a source removed by clean before reserving and cannot evade the original quota", async () => {
    fullTree();
    resumable("old", { parentId: "root", depth: 2 });
    db.updateStatus("old", "idle");
    let cleaning = false;
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => {
      if (id === "old" && !cleaning) {
        cleaning = true;
        await clean(db);
      }
      return false;
    });
    await expect(resume({ db, sessionId: "old", ownerToken: "tok" })).rejects.toThrow();
    expect(db.getSession("old")).toBeNull();
    expect(listActiveSessionsInTree(db, "root")).toHaveLength(8);
    expect(Tmux.create).not.toHaveBeenCalled();
  });

  test("checks current resume ancestry inside the reservation transaction", async () => {
    fullTree();
    resumable("former-root");
    resumable("old", { resumedFrom: "former-root" });
    const transaction = db.immediateTransaction.bind(db);
    spyOn(db, "immediateTransaction").mockImplementation((fn) => {
      // A different connection changes lineage after resume planned its command.
      const writer = new Database(join(root, "state.db"));
      try {
        writer.run("DELETE FROM sessions WHERE id = 'former-root'");
        writer.run("UPDATE sessions SET resumed_from = 'root' WHERE id = 'old'");
      }
      finally { writer.close(); }
      return transaction(fn);
    });
    await expect(resume({ db, sessionId: "old", ownerToken: "tok" })).rejects.toThrow(/Max active helpers per tree/);
    expect(listActiveSessionsInTree(db, "root")).toHaveLength(8);
    expect(Tmux.create).not.toHaveBeenCalled();
  });
});

describe("PR6 launch cancellation", () => {
  for (const kind of ["launch", "resume"] as const) {
    for (const boundary of ["tmux creation", "final publication"] as const) {
      test(`kill during ${kind} ${boundary} wins and reclaims owned resources`, async () => {
        if (kind === "resume") resumable();
        else await initializeFixtureRepository();
        const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", projectPath: project, parentId: "host", worktree: kind === "launch" });
        let id = "";
        let alive = false;
        spyOn(Tmux, "hasSession").mockImplementation(async () => alive);
        spyOn(Tmux, "kill").mockImplementation(async () => { alive = false; });
        spyOn(Tmux, "create").mockImplementation(async (createdId) => {
          id = createdId;
          if (boundary === "tmux creation") {
            await kill(db, id, db.getSession(id)!.ownerToken);
            expect(db.getSession(id)?.status).toBe("dead");
          }
          // The terminal appears only after the early kill has returned.
          alive = true;
        });
        if (boundary === "final publication") {
          spyOn(FIFO, "create").mockImplementation(async (path) => {
            await kill(db, id, db.getSession(id)!.ownerToken);
            // Creation finishes after kill cleaned up its not-yet-existing FIFO.
            expect(await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
          });
        }
        const operation = kind === "launch"
          ? executeLaunch(plan)
          : resume({ db, sessionId: "old", ownerToken: "tok" });
        await expect(operation).rejects.toThrow(/cancelled/i);
        expect(alive).toBe(false);
        expect(db.getSession(id)).toBeNull();
        expect(existsSync(defaultRuntimeLayout.fifoPath(id))).toBe(false);
        const handoff = planFileHandoff(kind === "launch" ? plan.input.projectPath : project, id);
        expect(existsSync(handoff.taskFilePath)).toBe(false);
        expect(existsSync(handoff.sessionDeliveryDir)).toBe(false);
        if (boundary === "tmux creation") {
          expect(getDriver("claude-code").prepareForTask).not.toHaveBeenCalled();
          expect(getDriver("claude-code").prepareForResume).not.toHaveBeenCalled();
        }
        if (kind === "resume") expect(db.getSession("old")).toMatchObject({ status: "dead", agentResumeId: "native-resume-id" });
        else await expectWorktreeRemoved(plan.input.projectPath, id);
      });
    }

    test(`removing a ${kind} reservation before publication also cancels it`, async () => {
      if (kind === "resume") resumable();
      else await initializeFixtureRepository();
      const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", projectPath: project, parentId: "host", worktree: kind === "launch" });
      let id = "";
      let alive = false;
      spyOn(Tmux, "create").mockImplementation(async (createdId) => { id = createdId; alive = true; });
      spyOn(Tmux, "kill").mockImplementation(async () => { alive = false; });
      spyOn(FIFO, "create").mockImplementation(async (path) => {
        db.deleteSession(id);
        expect(await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
      });
      await expect(kind === "launch" ? executeLaunch(plan) : resume({ db, sessionId: "old", ownerToken: "tok" })).rejects.toThrow(/cancelled/i);
      expect(alive).toBe(false);
      expect(existsSync(defaultRuntimeLayout.fifoPath(id))).toBe(false);
      expect(existsSync(planFileHandoff(kind === "launch" ? plan.input.projectPath : project, id).sessionDeliveryDir)).toBe(false);
      if (kind === "launch") await expectWorktreeRemoved(plan.input.projectPath, id);
    });
  }
});

describe("PR6 launch publication compare-and-set", () => {
  test("a foreign launcher cannot publish a running reservation", () => {
    const before = record("pending", { launchPid: process.pid });
    expect(db.completeLaunch("pending", process.pid + 1, "foreign-commit", "needs_attention")).toBe(false);
    expect(db.getSession("pending")).toEqual(before);
  });

  test("the owning launcher publishes once and cannot publish again after clearing the marker", () => {
    const before = record("pending", { launchPid: process.pid });
    expect(db.completeLaunch("pending", process.pid, "base-commit", "needs_attention")).toBe(true);
    const published = db.getSession("pending");
    expect(published).toMatchObject({ launchPid: null, baseCommit: "base-commit", status: "needs_attention", version: before.version + 1 });
    expect(db.completeLaunch("pending", process.pid, "later-commit")).toBe(false);
    expect(db.getSession("pending")).toEqual(published);
  });

  test("a killed reservation cannot be republished by its original launcher", () => {
    record("pending", { launchPid: process.pid });
    db.updateStatus("pending", "dead");
    const killed = db.getSession("pending");
    expect(db.completeLaunch("pending", process.pid, "base-commit", "needs_attention")).toBe(false);
    expect(db.getSession("pending")).toEqual(killed);
  });

  test("a removed reservation cannot be published", () => {
    record("pending", { launchPid: process.pid });
    db.deleteSession("pending");
    expect(db.completeLaunch("pending", process.pid)).toBe(false);
    expect(db.getSession("pending")).toBeNull();
  });
});

describe("PR6 clean retains surviving terminals' ancestry", () => {
  test("retains error terminals' parent and resume ancestors through reactivation, then removes them after exit", async () => {
    record("root");
    db.updateStatus("root", "idle");
    resumable("source", { parentId: "root", depth: 2 });
    record("child", { parentId: "host", resumedFrom: "source", depth: 2 });
    db.updateStatus("child", "error");
    let alive = true;
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => id === "child" && alive);
    expect((await clean(db)).removed).toBe(0);
    expect(getSessionNestingInfo(db, "child").rootSessionId).toBe("root");
    await send(db, "child", "tok", "next task");
    expect(db.getSession("child")?.status).toBe("running");
    expect(getSessionNestingInfo(db, "child").rootSessionId).toBe("root");
    alive = false;
    db.updateStatus("child", "dead");
    await clean(db);
    expect(db.listSessions()).toHaveLength(0);
  });

  test("retains an idle child's ancestor while graceful exit awaits before draining", async () => {
    record("root");
    record("child", { parentId: "root", depth: 2 });
    db.updateStatus("root", "idle");
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => id === "child");
    spyOn(Tmux, "capture").mockResolvedValue("⏺ [AHELPA:DONE]");
    spyOn(getDriver("claude-code"), "gracefulExit").mockImplementation(async () => {
      expect(db.getSession("child")?.status).toBe("idle");
      await clean(db);
      expect(db.getSession("root")).not.toBeNull();
    });
    await daemon.refreshSessionStatuses(db, ["child"]);
    expect(db.getSession("child")?.status).toBe("draining");
    expect(getSessionNestingInfo(db, "child").rootSessionId).toBe("root");
  });
});

describe("PR6 crashed startup reconciliation", () => {
  test("a crashed resume waits for a new task despite old native DONE output", async () => {
    resumable();
    record("pending", { resumedFrom: "old", launchPid: process.pid });
    spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue("❯ old completed task\n⏺ [AHELPA:DONE]\n❯");
    await daemon.refreshSessionStatuses(db, ["pending"]);
    expect(db.getSession("pending")).toMatchObject({ status: "needs_attention", launchPid: null });
    expect(getDriver("claude-code").gracefulExit).not.toHaveBeenCalled();
  });

  for (const age of ["fresh", "expired"] as const) {
    for (const pidState of ["live", "EPERM", "ESRCH"] as const) {
      test(`${age} startup lease with ${pidState} PID reconciles at the intended boundary`, async () => {
        record("pending", { launchPid: process.pid });
        const createdAt = Date.parse(db.getSession("pending")!.createdAt);
        spyOn(process, "kill").mockImplementation(() => {
          if (pidState !== "live") throw Object.assign(new Error(pidState), { code: pidState });
          return true;
        });
        // Keep a fallback for running the identical probe against the base that
        // predates this constant; assertions cover the behavior, not its spelling.
        const leaseMs = daemon.LAUNCH_STARTUP_LEASE_MS ?? 180_000;
        await daemon.refreshSessionStatuses(db, ["pending"], createdAt + (age === "expired" ? leaseMs + 1 : 0));
        const crashed = age === "expired" || pidState === "ESRCH";
        expect(db.getSession("pending")).toMatchObject({ status: crashed ? "dead" : "running", launchPid: crashed ? null : process.pid });
        if (!crashed) expect(Tmux.hasSession).not.toHaveBeenCalled();
      });
    }
  }
});
