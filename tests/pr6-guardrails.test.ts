import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { StateDB, type CreateSessionInput } from "../src/state";
import { executeLaunch, findWriterConflicts, launch, planLaunch, resolveJobId, resume } from "../src/commands/launch";
import { clean } from "../src/commands/session-ops";
import { wait } from "../src/commands/wait";
import { runCli } from "../src/command-contract";
import { listActiveSessionsInTree } from "../src/nesting";
import { getDriver } from "../src/drivers/registry";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import * as daemon from "../src/daemon";

const agentTypes = ["claude-code", "codex", "kimi"] as const;
const envKeys = ["AHELPA_JOB_ID", "AHELPA_PARENT_ID", "AHELPA_MAX_ACTIVE_PER_TREE", "AHELPA_MAX_NESTING_DEPTH"] as const;
let root: string;
let project: string;
let db: StateDB;
let secondDB: StateDB | undefined;
let savedEnv: (string | undefined)[];
let savedLayout: { ahelpaDir: string; tmpDir: string };

beforeEach(() => {
  // These probes never write state, task files, or archives outside this checkout.
  const scratch = join(import.meta.dir, "../.ahelpa/codex-ff0259cdaf82/artifacts");
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "regression-"));
  project = join(root, "project");
  mkdirSync(project);
  savedEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) delete process.env[key];
  savedLayout = { ahelpaDir: defaultRuntimeLayout.ahelpaDir, tmpDir: defaultRuntimeLayout.tmpDir };
  Object.assign(defaultRuntimeLayout, { ahelpaDir: join(root, "state"), tmpDir: join(root, "runtime") });
  db = new StateDB(join(root, "state.db"));
});

afterEach(() => {
  mock.restore();
  secondDB?.close();
  secondDB = undefined;
  db.close();
  Object.assign(defaultRuntimeLayout, savedLayout);
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  rmSync(root, { recursive: true, force: true });
});

// Direct records are used only for job/path fixtures and explicit legacy cases.
function record(id: string, extra: Partial<CreateSessionInput> = {}) {
  return db.createSession({ id, parentId: "host", agentType: "claude-code", task: "fixture", ownerToken: "tok", projectPath: project, role: "worker", ...extra });
}

function stubRuntime() {
  spyOn(Tmux, "create").mockResolvedValue();
  spyOn(Tmux, "kill").mockResolvedValue();
  spyOn(Tmux, "capture").mockResolvedValue("");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(Tmux, "hasSession").mockResolvedValue(false);
  spyOn(FIFO, "create").mockResolvedValue();
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  for (const name of agentTypes) {
    const driver = getDriver(name);
    spyOn(driver, "buildLaunchCommand").mockReturnValue("true");
    spyOn(driver, "buildResumeCommand").mockReturnValue("true");
    spyOn(driver, "prepareForTask").mockResolvedValue();
    spyOn(driver, "prepareForResume").mockResolvedValue();
    spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
  }
}

function start(parentId = "host", extra: Partial<Parameters<typeof launch>[0]> = {}) {
  return launch({ db, agentType: "claude-code", task: "bounded test task", projectPath: project, parentId, ...extra });
}

async function fullTree() {
  const parent = await start();
  const children = [];
  for (let index = 0; index < 7; index++) children.push(await start(parent.sessionId));
  return { parent, children };
}

describe("PR6 caller identity and jobs", () => {
  test("host launch ignores a stale job and an unknown parent environment", () => {
    process.env.AHELPA_JOB_ID = "foreign-host-job";
    process.env.AHELPA_PARENT_ID = "missing-helper";
    expect(planLaunch({ db, agentType: "claude-code", task: "t", projectPath: project, parentId: "host" }).jobId).toBeNull();
  });

  test("job precedence is explicit > after > actual caller's stored job > stale environment", () => {
    record("caller", { jobId: "stored" });
    record("previous", { jobId: "after-job" });
    record("unlabelled");
    const env = { AHELPA_PARENT_ID: "caller", AHELPA_JOB_ID: "stale" };
    expect(resolveJobId(db, "explicit", "previous", env)).toBe("explicit");
    expect(resolveJobId(db, undefined, "previous", env)).toBe("after-job");
    expect(resolveJobId(db, undefined, "unlabelled", env)).toBe("stored");
    expect(resolveJobId(db, undefined, undefined, env)).toBe("stored");
  });

  test("a helper with no stored job does not inherit stale environment", () => {
    record("caller");
    expect(resolveJobId(db, undefined, undefined, { AHELPA_PARENT_ID: "caller", AHELPA_JOB_ID: "stale" })).toBeNull();
  });

  test("every selected job source is validated", () => {
    record("caller", { jobId: "../bad-caller" });
    record("previous", { jobId: "../bad-after" });
    expect(() => resolveJobId(db, "../bad-explicit", undefined, {})).toThrow(/Invalid job id/);
    expect(() => resolveJobId(db, undefined, "previous", {})).toThrow(/Invalid job id/);
    expect(() => resolveJobId(db, undefined, undefined, { AHELPA_PARENT_ID: "caller" })).toThrow(/Invalid job id/);
  });

  test("reviewer CLI --parent host cannot bypass the actual caller rule", async () => {
    stubRuntime();
    const reviewer = await start("host", { role: "reviewer" });
    process.env.AHELPA_PARENT_ID = reviewer.sessionId;
    const errors: string[] = [];
    const creates = spyOn(Tmux, "create").mockResolvedValue();
    creates.mockClear();
    const code = await runCli(db, ["launch", "claude-code", "--task", "child", "--project", project, "--parent", "host"], { print: () => {}, printError: (text) => errors.push(text) });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/reviewer/);
    expect(creates).not.toHaveBeenCalled();
  });

  test("a helper cannot override its parent into another tree", async () => {
    stubRuntime();
    const own = await start();
    const other = await start();
    process.env.AHELPA_PARENT_ID = own.sessionId;
    await expect(start(other.sessionId)).rejects.toThrow(/tree|parent/i);
  });

  test("an allowed same-tree parent override cannot reduce the actual caller's depth", async () => {
    stubRuntime();
    const ancestor = await start();
    const child = await start(ancestor.sessionId);
    const grandchild = await start(child.sessionId);
    const deepest = await start(grandchild.sessionId);
    process.env.AHELPA_PARENT_ID = deepest.sessionId;
    await expect(start(ancestor.sessionId)).rejects.toThrow(/nesting depth/);
  });

  test("a host still may choose an explicit parent", async () => {
    stubRuntime();
    const parent = await start();
    const child = await start(parent.sessionId);
    expect(db.getSession(child.sessionId)).toMatchObject({ parentId: parent.sessionId, depth: 2 });
  });
});

describe("PR6 atomic launch reservation", () => {
  test("a launching reviewer is registered before tmux creation and before task delivery", async () => {
    stubRuntime();
    spyOn(Tmux, "create").mockImplementation(async (id) => {
      expect(db.getSession(id)).toMatchObject({ role: "reviewer", launchPid: process.pid });
      expect(existsSync(defaultRuntimeLayout.taskFilePath(id))).toBe(false);
    });
    spyOn(Tmux, "sendKeys").mockImplementation(async (id) => {
      expect(db.getSession(id)).not.toBeNull();
      expect(() => planLaunch({ db, agentType: "claude-code", task: "nested", projectPath: project, parentId: id })).toThrow(/reviewer/);
    });
    const result = await start("host", { role: "reviewer" });
    expect(db.getSession(result.sessionId)).toMatchObject({ launchPid: null });
  });

  test("two preplanned launches through separate database connections reserve only the last slot", async () => {
    stubRuntime();
    const parent = await start();
    for (let index = 0; index < 6; index++) await start(parent.sessionId);
    secondDB = new StateDB(join(root, "state.db"));
    const plans = [db, secondDB].map((connection) => planLaunch({ db: connection, agentType: "claude-code", task: "race", projectPath: project, parentId: parent.sessionId }));
    const results = await Promise.allSettled(plans.map(executeLaunch));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(listActiveSessionsInTree(db, parent.sessionId)).toHaveLength(8);
  });

  test("reservation is made while SQLite holds a write transaction", async () => {
    stubRuntime();
    const originalCreate = db.createSession.bind(db);
    const observer = new Database(join(root, "state.db"));
    observer.exec("PRAGMA busy_timeout = 0");
    spyOn(db, "createSession").mockImplementation((input) => {
      let acquired = false;
      try { observer.exec("BEGIN IMMEDIATE"); acquired = true; } catch {}
      if (acquired) observer.exec("ROLLBACK");
      expect(acquired).toBe(false);
      return originalCreate(input);
    });
    try { await start(); } finally { observer.close(); }
  });

  test("inline refresh and bounded wait preserve the live launch window before tmux exists", async () => {
    stubRuntime();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
    spyOn(daemon, "startDaemon").mockImplementation(() => {});
    spyOn(Tmux, "create").mockImplementation(async (id) => {
      expect(db.getSession(id)).not.toBeNull();
      await daemon.refreshSessionStatuses(db, [id]);
      expect(db.getSession(id)?.status).toBe("running");
      expect(await wait(db, [id], false, 0)).toMatchObject({ sessionId: id, status: "still_running" });
    });
    await start();
  });

  test("a failed startup rolls its early reservation back and preserves unrelated rows", async () => {
    stubRuntime();
    record("untouched");
    let failedId = "";
    spyOn(Tmux, "create").mockImplementation(async (id) => {
      failedId = id;
      expect(db.getSession(id)).not.toBeNull();
      throw new Error("startup failed");
    });
    await expect(start()).rejects.toThrow("startup failed");
    expect(db.getSession(failedId)).toBeNull();
    expect(db.listSessions().map((session) => session.id)).toEqual(["untouched"]);
    expect(existsSync(defaultRuntimeLayout.taskFilePath(failedId))).toBe(false);
    expect(existsSync(defaultRuntimeLayout.fifoPath(failedId))).toBe(false);
  });

  test("refresh recovers a reservation whose launching process has exited", async () => {
    stubRuntime();
    const exited = Bun.spawn(["bash", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    await exited.exited;
    spyOn(Tmux, "create").mockImplementation(async (id) => {
      expect(db.getSession(id)).not.toBeNull();
      const raw = new Database(join(root, "state.db"));
      try { raw.query("UPDATE sessions SET launch_pid = ? WHERE id = ?").run(exited.pid, id); } finally { raw.close(); }
      await daemon.refreshSessionStatuses(db, [id]);
      expect(db.getSession(id)).toMatchObject({ status: "dead", launchPid: null });
      throw new Error("launcher exited");
    });
    await expect(start()).rejects.toThrow("launcher exited");
    expect(db.listSessions()).toEqual([]);
  });
});

describe("PR6 retained lineage and resume", () => {
  test.each(["reviewer", "cross-tree", "depth"])("resume enforces the actual caller's %s guard", async (scenario) => {
    stubRuntime();
    const old = await start();
    let caller;
    if (scenario === "reviewer") caller = await start(old.sessionId, { role: "reviewer" });
    else if (scenario === "cross-tree") caller = await start();
    else {
      const child = await start(old.sessionId);
      const grandchild = await start(child.sessionId);
      caller = await start(grandchild.sessionId);
    }
    db.updateStatus(old.sessionId, "dead");
    db.updateResumeId(old.sessionId, "native-resume");
    process.env.AHELPA_PARENT_ID = caller.sessionId;
    const creates = spyOn(Tmux, "create").mockResolvedValue();
    creates.mockClear();
    const expected = scenario === "reviewer" ? /reviewer/ : scenario === "cross-tree" ? /tree/ : /nesting depth/;
    await expect(resume({ db, sessionId: old.sessionId, ownerToken: old.ownerToken })).rejects.toThrow(expected);
    expect(creates).not.toHaveBeenCalled();
  });

  test("resume refuses a full tree before tmux creation", async () => {
    stubRuntime();
    const { parent, children } = await fullTree();
    const settled = children[0]!;
    db.updateStatus(settled.sessionId, "dead");
    db.updateResumeId(settled.sessionId, "native-resume");
    await start(parent.sessionId);
    const creates = spyOn(Tmux, "create").mockResolvedValue();
    creates.mockClear();
    await expect(resume({ db, sessionId: settled.sessionId, ownerToken: settled.ownerToken })).rejects.toThrow(/active helpers per tree/);
    expect(creates).not.toHaveBeenCalled();
  });

  test("concurrent resumes through separate connections reserve only one remaining tree slot", async () => {
    stubRuntime();
    const { parent, children } = await fullTree();
    const old = children[0]!;
    db.updateStatus(old.sessionId, "dead");
    db.updateResumeId(old.sessionId, "native-resume");
    secondDB = new StateDB(join(root, "state.db"));
    const outcomes = await Promise.allSettled([db, secondDB].map((connection) => resume({ db: connection, sessionId: old.sessionId, ownerToken: old.ownerToken })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(listActiveSessionsInTree(db, parent.sessionId)).toHaveLength(8);
  });

  test("resume reserves its row before creating the terminal and rolls it back on failure", async () => {
    stubRuntime();
    const old = await start();
    db.updateStatus(old.sessionId, "dead");
    db.updateResumeId(old.sessionId, "native-resume");
    let resumedId = "";
    spyOn(Tmux, "create").mockImplementation(async (id) => {
      resumedId = id;
      expect(db.getSession(id)).toMatchObject({ resumedFrom: old.sessionId, launchPid: process.pid });
      throw new Error("resume startup failed");
    });
    await expect(resume({ db, sessionId: old.sessionId, ownerToken: old.ownerToken })).rejects.toThrow("resume startup failed");
    expect(db.getSession(resumedId)).toBeNull();
    expect(db.getSession(old.sessionId)).toMatchObject({ status: "dead", agentResumeId: "native-resume" });
  });

  test("wait during resume FIFO preparation sees a running launch until completion", async () => {
    stubRuntime();
    const old = await start();
    db.updateStatus(old.sessionId, "dead");
    db.updateResumeId(old.sessionId, "native-resume");
    spyOn(FIFO, "create").mockImplementation(async () => {
      const pending = db.listSessions().find((session) => session.resumedFrom === old.sessionId);
      expect(pending).toMatchObject({ status: "running", launchPid: process.pid });
      expect(await wait(db, [pending!.id], false, 0)).toMatchObject({ sessionId: pending!.id, status: "still_running" });
    });
    const result = await resume({ db, sessionId: old.sessionId, ownerToken: old.ownerToken });
    expect(db.getSession(result.sessionId)).toMatchObject({ status: "needs_attention", launchPid: null });
  });

  test("clean retains a settled root while active branches still need its quota", async () => {
    stubRuntime();
    const { parent, children } = await fullTree();
    db.updateStatus(parent.sessionId, "idle");
    await start(children[0]!.sessionId);
    expect((await clean(db)).removed).toBe(0);
    expect(db.getSession(parent.sessionId)).not.toBeNull();
    expect(listActiveSessionsInTree(db, parent.sessionId)).toHaveLength(8);
    await expect(start(children[1]!.sessionId)).rejects.toThrow(/active helpers per tree/);
  });

  test("resume after clean retains the original tree's full quota", async () => {
    stubRuntime();
    const { parent, children } = await fullTree();
    const old = children[0]!;
    db.updateStatus(parent.sessionId, "idle");
    db.updateStatus(old.sessionId, "dead");
    db.updateResumeId(old.sessionId, "native-resume");
    // Retain the resumable row while cleaning only its settled ancestor.
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => id === old.sessionId);
    await clean(db);
    expect(db.getSession(parent.sessionId)).not.toBeNull();
    await start(children[1]!.sessionId);
    await start(children[2]!.sessionId);
    const creates = spyOn(Tmux, "create").mockResolvedValue();
    creates.mockClear();
    await expect(resume({ db, sessionId: old.sessionId, ownerToken: old.ownerToken })).rejects.toThrow(/active helpers per tree/);
    expect(creates).not.toHaveBeenCalled();
  });

  test("a successful child resume retains its original lineage", async () => {
    stubRuntime();
    const parent = await start();
    const old = await start(parent.sessionId);
    db.updateStatus(old.sessionId, "dead");
    db.updateResumeId(old.sessionId, "native-resume");
    const result = await resume({ db, sessionId: old.sessionId, ownerToken: old.ownerToken });
    expect(db.getSession(result.sessionId)).toMatchObject({ parentId: parent.sessionId, launchPid: null });
    expect(listActiveSessionsInTree(db, parent.sessionId).map((session) => session.id).sort()).toEqual([parent.sessionId, result.sessionId].sort());
  });

  test("legacy rows continue to count by lineage", () => {
    record("legacy-root");
    record("legacy-child", { parentId: "legacy-root", depth: 2 });
    record("other-root");
    expect(listActiveSessionsInTree(db, "legacy-root").map((session) => session.id).sort()).toEqual(["legacy-child", "legacy-root"]);
  });

  test("an old schema migrates the launch marker column idempotently", () => {
    record("legacy");
    db.close();
    const raw = new Database(join(root, "state.db"));
    const columns = raw.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (columns.some((column) => column.name === "launch_pid")) raw.exec("ALTER TABLE sessions DROP COLUMN launch_pid");
    raw.close();
    for (let index = 0; index < 2; index++) {
      db = new StateDB(join(root, "state.db"));
      expect(db.getSession("legacy")).toMatchObject({ launchPid: null });
      if (index === 0) db.close();
    }
  });

  test("clean retains a settled middle ancestor until its active grandchild settles", async () => {
    stubRuntime();
    const parent = await start();
    const middle = await start(parent.sessionId);
    const grandchild = await start(middle.sessionId);
    db.updateStatus(middle.sessionId, "idle");
    expect((await clean(db)).removed).toBe(0);
    expect(db.getSession(middle.sessionId)).not.toBeNull();
    expect(listActiveSessionsInTree(db, parent.sessionId).map((session) => session.id).sort()).toEqual([parent.sessionId, grandchild.sessionId].sort());
    db.updateStatus(parent.sessionId, "idle");
    db.updateStatus(grandchild.sessionId, "dead");
    expect((await clean(db)).removed).toBe(3);
    expect(db.listSessions()).toEqual([]);
  });

  test("clean rechecks active descendants reserved while its terminal check awaits", async () => {
    stubRuntime();
    const parent = await start();
    db.updateStatus(parent.sessionId, "idle");
    let childId = "";
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => {
      if (id === parent.sessionId && !childId) childId = (await start(parent.sessionId)).sessionId;
      return false;
    });
    expect((await clean(db)).removed).toBe(0);
    expect(db.getSession(parent.sessionId)).not.toBeNull();
    expect(listActiveSessionsInTree(db, parent.sessionId).map((session) => session.id)).toEqual([childId]);
  });

  test("native root resume shares the quota with the original root's active descendants", async () => {
    stubRuntime();
    const { parent, children } = await fullTree();
    db.updateStatus(parent.sessionId, "dead");
    db.updateResumeId(parent.sessionId, "native-root-resume");
    const resumed = await resume({ db, sessionId: parent.sessionId, ownerToken: parent.ownerToken });
    expect(db.getSession(resumed.sessionId)).toMatchObject({ parentId: "host", depth: 1, resumedFrom: parent.sessionId });
    expect(listActiveSessionsInTree(db, parent.sessionId)).toHaveLength(8);
    await expect(start(children[0]!.sessionId)).rejects.toThrow(/active helpers per tree/);
    await expect(start(resumed.sessionId)).rejects.toThrow(/active helpers per tree/);
    expect((await clean(db)).removed).toBe(0);
    expect(db.getSession(parent.sessionId)).not.toBeNull();
  });
});

describe("PR6 physical writer paths", () => {
  test("symlink aliases of an existing project conflict", () => {
    record("writer");
    const alias = join(root, "alias");
    symlinkSync(project, alias);
    expect(findWriterConflicts(db, alias, "worker").map((conflict) => conflict.sessionId)).toEqual(["writer"]);
  });

  test("filesystem root encloses the project", () => {
    record("root-writer", { projectPath: "/" });
    expect(findWriterConflicts(db, project, "worker").map((conflict) => conflict.sessionId)).toEqual(["root-writer"]);
  });

  test("macOS temporary directory aliases compare physically", () => {
    record("tmp-writer", { projectPath: "/tmp" });
    expect(findWriterConflicts(db, realpathSync("/tmp"), "worker").map((conflict) => conflict.sessionId)).toEqual(["tmp-writer"]);
  });

  test("missing descendants fall back through the real existing parent", () => {
    const alias = join(root, "alias");
    symlinkSync(project, alias);
    record("missing-writer", { projectPath: join(alias, "deleted", "pkg") });
    expect(findWriterConflicts(db, join(project, "deleted"), "worker").map((conflict) => conflict.sessionId)).toEqual(["missing-writer"]);
  });

  test("case aliases conflict only where the filesystem resolves them to the same directory", () => {
    const lower = join(project, "case-probe");
    const upper = join(project, "CASE-PROBE");
    mkdirSync(lower);
    record("case-writer", { projectPath: lower });
    if (existsSync(upper)) {
      expect(findWriterConflicts(db, upper, "worker").map((conflict) => conflict.sessionId)).toEqual(["case-writer"]);
    } else {
      mkdirSync(upper);
      expect(findWriterConflicts(db, upper, "worker")).toEqual([]);
    }
  });
});

describe("M4 shell job exports", () => {
  test.each([...agentTypes])("%s launch and resume commands explicitly export both populated and empty jobs", async (agentType) => {
    stubRuntime();
    const driver = getDriver(agentType);
    spyOn(driver, "buildLaunchCommand").mockReturnValue('printf "%s" "$AHELPA_JOB_ID"');
    spyOn(driver, "buildResumeCommand").mockReturnValue('printf "%s" "$AHELPA_JOB_ID"');
    const creates = spyOn(Tmux, "create").mockResolvedValue();
    for (const job of ["job-42", undefined]) {
      const old = await start("host", { agentType, job });
      const launchCommand = creates.mock.calls.at(-1)![1];
      db.updateStatus(old.sessionId, "dead");
      db.updateResumeId(old.sessionId, "native-resume");
      await resume({ db, sessionId: old.sessionId, ownerToken: old.ownerToken });
      const resumeCommand = creates.mock.calls.at(-1)![1];
      for (const command of [launchCommand, resumeCommand]) {
        const proc = Bun.spawn(["bash", "-c", command], { env: { ...process.env, AHELPA_JOB_ID: "stale-server-job" }, stdout: "pipe", stderr: "pipe" });
        expect(await new Response(proc.stdout).text()).toBe(job ?? "");
        expect(await proc.exited).toBe(0);
      }
    }
  });
});
