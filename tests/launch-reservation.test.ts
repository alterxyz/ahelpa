import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB, type CreateSessionInput } from "../src/state";
import { executeLaunch, findWriterConflicts, launch, planLaunch, resolveJobId, resume } from "../src/commands/launch";
import { clean, kill, send } from "../src/commands/session-ops";
import { wait } from "../src/commands/wait";
import { runCli } from "../src/command-contract";
import { getSessionNestingInfo, listActiveDescendants, listActiveSessionsInTree } from "../src/nesting";
import { getDriver } from "../src/drivers/registry";
import { planFileHandoff } from "../src/file-handoff";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { defaultWakeup } from "../src/wakeup";
import * as daemon from "../src/daemon";

describe("launch guardrails", () => {
  const agentTypes = ["claude-code", "codex", "kimi"] as const;
  const envKeys = ["AHELPA_JOB_ID", "AHELPA_PARENT_ID", "AHELPA_MAX_ACTIVE_PER_TREE", "AHELPA_MAX_NESTING_DEPTH"] as const;
  let root: string;
  let project: string;
  let db: StateDB;
  let secondDB: StateDB | undefined;
  let savedEnv: (string | undefined)[];
  let savedLayout: { ahelpaDir: string; tmpDir: string };

  beforeEach(() => {
    // These liveness/lease races exercise per-row fallback probes.
    spyOn(Tmux, "liveSessionNames").mockRejectedValue(new Error("snapshot unavailable"));
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-pr6-"));
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
});

describe("launch reservation edges", () => {
  const envKeys = ["AHELPA_PARENT_ID", "AHELPA_JOB_ID", "AHELPA_MAX_NESTING_DEPTH", "AHELPA_MAX_ACTIVE_PER_TREE"] as const;
  let db: StateDB;
  let root: string;
  let project: string;
  let savedEnv: (string | undefined)[];
  let savedLayout: { ahelpaDir: string; tmpDir: string };

  beforeEach(() => {
    // These liveness/lease races exercise per-row fallback probes.
    spyOn(Tmux, "liveSessionNames").mockRejectedValue(new Error("snapshot unavailable"));
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-reservation-"));
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
    test("reviewer resume reserves its native review baseline and options before terminal startup", async () => {
      const fingerprint = { head: "original-review-head", treeHash: "original-review-tree" };
      const originalDir = planFileHandoff(project, "old").sessionDeliveryDir;
      resumable("old", { role: "reviewer", targetFingerprint: fingerprint, targetResultDirs: [originalDir], unblind: true });
      let resumedId = "";
      spyOn(Tmux, "create").mockImplementation(async (id) => {
        resumedId = id;
        expect(db.getSession(id)).toMatchObject({ launchPid: process.pid, targetFingerprint: fingerprint, targetResultDirs: [originalDir, planFileHandoff(project, id).sessionDeliveryDir], unblind: true });
      });
      const result = await resume({ db, sessionId: "old", ownerToken: "tok" });
      expect(result.sessionId).toBe(resumedId);
      expect(db.getSession(resumedId)).toMatchObject({ launchPid: null, targetFingerprint: fingerprint, status: "needs_attention", unblind: true });
    });

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
    test("reviewer reserves known options before startup and publishes its fingerprint with the launch", async () => {
      await initializeFixtureRepository();
      const plan = planLaunch({ db, agentType: "claude-code", task: "review this tree", projectPath: project, parentId: "host", role: "reviewer", unblind: true });
      spyOn(Tmux, "create").mockImplementation(async (id) => {
        expect(db.getSession(id)).toMatchObject({ launchPid: process.pid, unblind: true, targetResultDirs: [plan.fileHandoff.sessionDeliveryDir], targetFingerprint: null, baseCommit: null });
      });
      spyOn(getDriver("claude-code"), "prepareForTask").mockImplementation(async (id) => {
        expect(db.getSession(id)?.targetFingerprint).toBeNull();
        expect(existsSync(plan.fileHandoff.askPath)).toBe(true);
        expect(readFileSync(plan.fileHandoff.taskCopyPath, "utf8")).toContain(plan.handoffContext.targetFingerprint!.treeHash!);
      });
      await executeLaunch(plan);
      expect(db.getSession(plan.sessionId)).toMatchObject({ launchPid: null, targetFingerprint: plan.handoffContext.targetFingerprint, baseCommit: plan.handoffContext.targetFingerprint!.head });
    });

    for (const boundary of ["tmux creation", "task preparation", "final publication"] as const) {
      test(`cancelled reviewer at ${boundary} leaves no fingerprint, ask, or owned handoff behind`, async () => {
        await initializeFixtureRepository();
        const plan = planLaunch({ db, agentType: "claude-code", task: "review this tree", projectPath: project, parentId: "host", role: "reviewer" });
        const cancel = async () => {
          expect(db.getSession(plan.sessionId)).toMatchObject({ launchPid: process.pid, targetFingerprint: null, targetResultDirs: [plan.fileHandoff.sessionDeliveryDir] });
          if (boundary !== "tmux creation") {
            expect(readFileSync(plan.fileHandoff.askPath, "utf8")).toBe("review this tree");
            expect(readFileSync(plan.fileHandoff.taskCopyPath, "utf8")).toContain(plan.handoffContext.targetFingerprint!.treeHash!);
          }
          await kill(db, plan.sessionId, plan.ownerToken);
          const killed = db.getSession(plan.sessionId);
          expect(killed?.status).toBe("dead");
          expect(db.completeLaunch(plan.sessionId, process.pid, "cancelled-base", undefined, plan.handoffContext.targetFingerprint)).toBe(false);
          expect(db.getSession(plan.sessionId)).toEqual(killed);
        };
        if (boundary === "tmux creation") spyOn(Tmux, "create").mockImplementation(cancel);
        else if (boundary === "task preparation") spyOn(getDriver("claude-code"), "prepareForTask").mockImplementation(cancel);
        else {
          spyOn(FIFO, "create").mockImplementation(async (path) => {
            await cancel();
            expect(await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
          });
        }
        await expect(executeLaunch(plan)).rejects.toThrow(/cancelled/i);
        expect(db.getSession(plan.sessionId)).toBeNull();
        expect(existsSync(plan.fileHandoff.askPath)).toBe(false);
        expect(existsSync(plan.fileHandoff.taskCopyPath)).toBe(false);
        expect(existsSync(plan.fileHandoff.taskFilePath)).toBe(false);
        expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
        expect(existsSync(defaultRuntimeLayout.fifoPath(plan.sessionId))).toBe(false);
        expect(Tmux.kill).toHaveBeenCalledWith(plan.sessionId);
      });
    }

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
          // A --worktree launch keeps its results in the source repository, not in
          // the worktree that the rollback removes: look where they were planned.
          const handoff = kind === "launch" ? plan.fileHandoff : planFileHandoff(project, id);
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
        expect(existsSync((kind === "launch" ? plan.fileHandoff : planFileHandoff(project, id)).sessionDeliveryDir)).toBe(false);
        if (kind === "launch") await expectWorktreeRemoved(plan.input.projectPath, id);
      });
    }
  });

  describe("PR6 launch publication compare-and-set", () => {
    test("fingerprint publication shares the owning launcher's single compare-and-set", () => {
      const fingerprint = { head: "review-head", treeHash: "review-tree-hash" };
      const before = record("pending", { launchPid: process.pid });
      expect(db.completeLaunch("pending", process.pid + 1, "foreign-base", undefined, fingerprint)).toBe(false);
      expect(db.getSession("pending")).toEqual(before);
      expect(db.completeLaunch("pending", process.pid, "review-head", undefined, fingerprint)).toBe(true);
      const published = db.getSession("pending");
      expect(published).toMatchObject({ targetFingerprint: fingerprint, baseCommit: "review-head", launchPid: null, version: before.version + 1 });
      expect(db.completeLaunch("pending", process.pid, "later-head", undefined, { ...fingerprint, head: "later-head" })).toBe(false);
      expect(db.getSession("pending")).toEqual(published);
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
          // The lease is a fixed contract (three minutes), not whatever the
          // constant happens to be: probe just inside and exactly at the bound.
          const LEASE_MS = 180_000;
          await daemon.refreshSessionStatuses(db, ["pending"], createdAt + (age === "expired" ? LEASE_MS : LEASE_MS - 1));
          const crashed = age === "expired" || pidState === "ESRCH";
          expect(db.getSession("pending")).toMatchObject({ status: crashed ? "dead" : "running", launchPid: crashed ? null : process.pid });
          if (!crashed) expect(Tmux.hasSession).not.toHaveBeenCalled();
        });
      }
    }
  });
});

describe("kill-tree rollback", () => {
  let db: StateDB;
  let root: string;
  let project: string;
  let savedLayout: { ahelpaDir: string; tmpDir: string };
  let savedParent: string | undefined;
  let alive: Set<string>;

  beforeEach(() => {
    const fixtures = realpathSync(tmpdir());
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
});
