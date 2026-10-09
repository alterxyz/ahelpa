import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Archive } from "../src/archive";
import { executeLaunch, planLaunch } from "../src/commands/launch";
import { clean, kill, logs, send, sendTask } from "../src/commands/session-ops";
import * as daemon from "../src/daemon";
import { getDriver } from "../src/drivers/registry";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { settle } from "../src/settle";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";

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
  const fixtures = join(import.meta.dir, "..", ".ahelpa");
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
