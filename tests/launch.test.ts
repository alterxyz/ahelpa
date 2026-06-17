import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { launch, planLaunch } from "../src/commands/launch";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";
import { unlinkSync, existsSync, rmSync, mkdirSync } from "fs";

const TEST_DB = "/tmp/ahelpa-launch-test.db";
const TEST_PROJECT = "/tmp/ahelpa-launch-test-project";

describe("launch", () => {
  let sessionId: string | undefined;
  let db: StateDB;

  afterEach(async () => {
    mock.restore();
    if (sessionId) {
      try { await Tmux.kill(sessionId); } catch {}
      sessionId = undefined;
    }
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  test("creates session with correct shape and records in SQLite", async () => {
    db = new StateDB(TEST_DB);

    const result = await launch({
      db,
      agentType: "claude-code",
      task: "echo hello",
      projectPath: "/tmp",
      parentId: "test-parent",
      label: "test-launch",
    });

    sessionId = result.sessionId;

    // sessionId starts with driver prefix
    expect(result.sessionId).toMatch(/^claude-/);

    // ownerToken is 32 hex chars (two UUIDs stripped of dashes = 32 chars each)
    expect(result.ownerToken).toHaveLength(32);
    expect(result.ownerToken).toMatch(/^[0-9a-f]{32}$/);

    // tmuxSession is the same as sessionId
    expect(result.tmuxSession).toBe(result.sessionId);

    // session is recorded in SQLite with status "running"
    const record = db.getSession(result.sessionId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("running");
    expect(record!.agentType).toBe("claude-code");
    expect(record!.task).toBe("echo hello");
    expect(record!.projectPath).toBe("/tmp");
    expect(record!.ownerToken).toBe(result.ownerToken);
    expect(record!.label).toBe("test-launch");

    // tmux session exists
    const exists = await Tmux.hasSession(result.sessionId);
    expect(exists).toBe(true);
  }, 10000);

  test("auto-starts daemon when it is not already running", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    const callOrder: string[] = [];
    spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
    const createSessionSpy = spyOn(db, "createSession").mockImplementation((input) => {
      callOrder.push("db");
      return StateDB.prototype.createSession.call(db, input);
    });
    const startDaemonSpy = spyOn(daemon, "startDaemon").mockImplementation(() => {
      callOrder.push("daemon");
    });
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:DONE]");
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    const result = await launch({
      db,
      agentType: "claude-code",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });

    sessionId = result.sessionId;

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(startDaemonSpy).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["db", "daemon"]);
  });

  test("injects session identity and max depth into helper environment", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxCreateSpy = spyOn(Tmux, "create").mockResolvedValue();
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "capture")
      .mockResolvedValueOnce([
        "Tip: New For a limited time, Codex is included in your plan for free - let's build together.",
        "",
        "• Starting MCP servers (0/2): codex_apps, vercel",
      ].join("\n"))
      .mockResolvedValue("Working (1s)");
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    const result = await launch({
      db,
      agentType: "codex",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });

    sessionId = result.sessionId;

    expect(tmuxCreateSpy).toHaveBeenCalledTimes(1);
    const launchCommand = tmuxCreateSpy.mock.calls[0]?.[1];
    expect(launchCommand).toContain(`export AHELPA_PARENT_ID=${result.sessionId}`);
    expect(launchCommand).toContain("AHELPA_MAX_NESTING_DEPTH=4");
    expect(launchCommand).toContain("codex --dangerously-bypass-approvals-and-sandbox");
    expect(sendKeysSpy).toHaveBeenCalledTimes(1);
    const instruction = sendKeysSpy.mock.calls[0]?.[1];
    expect(instruction).toContain("Please read and complete the task described in");
    expect(instruction).toContain("/tmp/ahelpa/ahelpa-task-");
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/${result.sessionId}`);
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/summary.md`);
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/artifacts`);
    expect(existsSync(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/artifacts`)).toBe(true);
  });

  test("planLaunch returns a data object without side effects", () => {
    db = new StateDB(TEST_DB);

    const plan = planLaunch({
      db,
      agentType: "claude-code",
      task: "plan only",
      projectPath: "/tmp/nonexistent",
      parentId: "test-parent",
      label: "plan-test",
    });

    expect(plan.sessionId).toMatch(/^claude-/);
    expect(plan.ownerToken).toHaveLength(32);
    expect(plan.driver.name).toBe("claude-code");
    expect(plan.launchCmd).toContain("claude --dangerously-skip-permissions");
    expect(plan.fileHandoff.taskInstruction).toContain("Please read and complete the task described in");
    expect(plan.fileHandoff.sessionDeliveryDir).toContain("/tmp/nonexistent/.ahelpa/");
    expect(plan.input.task).toBe("plan only");
  });

  test("planLaunch rejects beyond max nesting depth without side effects", () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });

    db.createSession({ id: "r", parentId: "cli", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT, depth: 1 });
    db.createSession({ id: "c1", parentId: "r", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT, depth: 2 });
    db.createSession({ id: "c2", parentId: "c1", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT, depth: 3 });
    db.createSession({ id: "c3", parentId: "c2", agentType: "codex", task: "t", ownerToken: "tok", projectPath: TEST_PROJECT, depth: 4 });

    expect(() => planLaunch({
      db,
      agentType: "codex",
      task: "too deep",
      projectPath: TEST_PROJECT,
      parentId: "c3",
    })).toThrow(/Max nesting depth exceeded/);
  });

  test("rejects launch beyond max nesting depth", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    db.createSession({
      id: "root-session",
      parentId: "cli-root",
      agentType: "claude-code",
      task: "root",
      ownerToken: "tok-root",
      projectPath: TEST_PROJECT,
      depth: 1,
    });
    db.createSession({
      id: "child-session",
      parentId: "root-session",
      agentType: "codex",
      task: "child",
      ownerToken: "tok-child",
      projectPath: TEST_PROJECT,
      depth: 2,
    });
    db.createSession({
      id: "grandchild-session",
      parentId: "child-session",
      agentType: "codex",
      task: "grandchild",
      ownerToken: "tok-grandchild",
      projectPath: TEST_PROJECT,
      depth: 3,
    });
    db.createSession({
      id: "greatgrandchild-session",
      parentId: "grandchild-session",
      agentType: "codex",
      task: "greatgrandchild",
      ownerToken: "tok-greatgrandchild",
      projectPath: TEST_PROJECT,
      depth: 4,
    });

    const tmuxCreateSpy = spyOn(Tmux, "create").mockResolvedValue();

    await expect(launch({
      db,
      agentType: "codex",
      task: "too deep",
      projectPath: TEST_PROJECT,
      parentId: "greatgrandchild-session",
    })).rejects.toThrow(/Max nesting depth exceeded/);

    expect(tmuxCreateSpy).not.toHaveBeenCalled();
  });
});
