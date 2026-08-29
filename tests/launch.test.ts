import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { executeLaunch, launch, planLaunch } from "../src/commands/launch";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";
import { unlinkSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { defaultRuntimeLayout } from "../src/runtime-layout";

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
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    const result = await launch({
      db,
      agentType: "claude-code",
      task: "echo hello",
      projectPath: TEST_PROJECT,
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
    expect(record!.projectPath).toBe(TEST_PROJECT);
    expect(record!.ownerToken).toBe(result.ownerToken);
    expect(record!.label).toBe("test-launch");

    // tmux session exists
    const exists = await Tmux.hasSession(result.sessionId);
    expect(exists).toBe(true);
  }, 30000);

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
    let taskSent = false;
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    spyOn(Tmux, "capture").mockImplementation(async () => taskSent
      ? "❯ Please read and complete the task described in a file.\n⏺ Working"
      : "❯\n0 tokens");
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
    let taskSent = false;
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      if (captures === 1) {
        return "• Starting MCP servers (0/2): codex_apps, vercel";
      }
      if (!taskSent) return "› Implement {feature}";
      return "› Please read and complete the task described in a file.\nWorking (1s)";
    });
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
    expect(instruction).toContain(`${defaultRuntimeLayout.tmpDir}/ahelpa-task-`);
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/${result.sessionId}`);
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/summary.md`);
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/artifacts`);
    expect(existsSync(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/artifacts`)).toBe(true);
  });

  test("keeps an unsupported Codex model turn for daemon error settlement", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    let taskSent = false;
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    spyOn(Tmux, "capture").mockImplementation(async () => taskSent
      ? [
          "› Please read and complete the task described in /tmp/ahelpa/task.md.",
          "ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.\"}}",
          "› Explain this codebase",
        ].join("\n")
      : "› Implement {feature}");
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    const result = await launch({
      db,
      agentType: "codex",
      task: "review with requested model",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
      model: "gpt-5.6",
    });
    sessionId = result.sessionId;

    expect(db.getSession(result.sessionId)?.status).toBe("running");
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

  test("planLaunch safe mode omits danger flags", () => {
    db = new StateDB(TEST_DB);

    const plan = planLaunch({
      db,
      agentType: "codex",
      task: "plan safe",
      projectPath: "/tmp/nonexistent",
      parentId: "test-parent",
      safe: true,
    });

    expect(plan.launchCmd).toContain("codex -s workspace-write -a never");
    expect(plan.launchCmd).not.toContain("--dangerously-bypass");
    expect(plan.launchCmd).not.toContain("--dangerously-skip-permissions");
  });

  test("planLaunch passes model and effort to the driver launch command", () => {
    db = new StateDB(TEST_DB);

    const plan = planLaunch({
      db,
      agentType: "codex",
      task: "plan model",
      projectPath: "/tmp/nonexistent",
      parentId: "test-parent",
      model: "gpt-5.5",
      effort: "high",
    });

    expect(plan.launchCmd).toContain("--model 'gpt-5.5'");
    expect(plan.launchCmd).toContain("-c 'model_reasoning_effort=\"high\"'");
    expect(plan.input.model).toBe("gpt-5.5");
    expect(plan.input.effort).toBe("high");
  });

  test("isolated runtime roots are inherited by nested helper launches", () => {
    db = new StateDB(TEST_DB);
    const previousHome = process.env.AHELPA_HOME;
    const previousTmp = process.env.AHELPA_TMP_DIR;
    try {
      process.env.AHELPA_HOME = "/tmp/ahelpa nested/state";
      process.env.AHELPA_TMP_DIR = "/tmp/ahelpa nested/runtime";

      const plan = planLaunch({
        db,
        agentType: "codex",
        task: "nested isolation",
        projectPath: "/tmp/nonexistent",
        parentId: "test-parent",
      });

      expect(plan.launchCmd).toContain("AHELPA_HOME='/tmp/ahelpa nested/state'");
      expect(plan.launchCmd).toContain("AHELPA_TMP_DIR='/tmp/ahelpa nested/runtime'");
    } finally {
      if (previousHome === undefined) delete process.env.AHELPA_HOME;
      else process.env.AHELPA_HOME = previousHome;
      if (previousTmp === undefined) delete process.env.AHELPA_TMP_DIR;
      else process.env.AHELPA_TMP_DIR = previousTmp;
    }
  });

  test("captures a Kimi resume token after the first task creates it", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    let taskSent = false;
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    spyOn(Tmux, "capture").mockImplementation(async () => taskSent
      ? [
          "Welcome to Kimi Code!",
          "│  Session:   session_bce9aed7-8ee0-42ba-8ee8-5326e673db72  │",
          "✨ Please read and complete the task described in /tmp/task.md.",
        ].join("\n")
      : [
          "Welcome to Kimi Code!",
          "│  Session:   │",
          "│ >   │",
          "context: 0% (0/977k)",
        ].join("\n"));
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    const result = await launch({
      db,
      agentType: "kimi",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });
    sessionId = result.sessionId;

    expect(result.sessionId).toMatch(/^kimi-/);
    expect(db.getSession(result.sessionId)?.agentResumeId)
      .toBe("session_bce9aed7-8ee0-42ba-8ee8-5326e673db72");
    expect(sendKeysSpy).toHaveBeenCalledTimes(1);
  });

  test("does not fail launch when post-submit resume-token capture fails", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    let taskSent = false;
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      captures++;
      if (!taskSent) {
        return "Welcome to Kimi Code!\n│  Session:   │\n│ >   │";
      }
      if (captures === 3) {
        return "Welcome to Kimi Code!\n│  Session:   session_early-token  │\n✨ task";
      }
      throw new Error("capture failed");
    });
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    const result = await launch({
      db,
      agentType: "kimi",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });
    sessionId = result.sessionId;

    expect(db.getSession(result.sessionId)?.agentResumeId).toBeNull();
  });

  test("cleans up a new tmux session when Kimi never becomes ready", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue(
      "Trust this folder?\n   Trust this folder\n ❯ Don't trust",
    );
    spyOn(Tmux, "sendKey").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    await expect(launch({
      db,
      agentType: "kimi",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    })).rejects.toThrow("did not reach its input prompt");

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(db.listSessions()).toHaveLength(0);
  });

  test("does not reclaim unowned resources when tmux creation fails", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const plan = planLaunch({
      db,
      agentType: "kimi",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });

    spyOn(Tmux, "create").mockRejectedValue(new Error("tmux create failed"));
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();

    await expect(executeLaunch(plan)).rejects.toThrow("tmux create failed");

    expect(killSpy).not.toHaveBeenCalled();
    expect(existsSync(plan.fileHandoff.taskFilePath)).toBe(false);
    expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
    expect(db.getSession(plan.sessionId)).toBeNull();
  });

  test("refuses to overwrite pre-existing handoff resources", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const plan = planLaunch({
      db,
      agentType: "kimi",
      task: "new task",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });
    mkdirSync(plan.fileHandoff.sessionDeliveryDir, { recursive: true });
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
    writeFileSync(plan.fileHandoff.taskFilePath, "existing task");
    writeFileSync(plan.fileHandoff.summaryPath, "existing summary");
    const createSpy = spyOn(Tmux, "create").mockResolvedValue();
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();

    try {
      await expect(executeLaunch(plan)).rejects.toThrow("Refusing to overwrite");

      expect(createSpy).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(readFileSync(plan.fileHandoff.taskFilePath, "utf-8")).toBe("existing task");
      expect(readFileSync(plan.fileHandoff.summaryPath, "utf-8")).toBe("existing summary");
    } finally {
      try { unlinkSync(plan.fileHandoff.taskFilePath); } catch {}
      rmSync(plan.fileHandoff.sessionDeliveryDir, { recursive: true, force: true });
    }
  });

  test("cleans up when the helper never acknowledges the submitted task", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(Tmux, "create").mockResolvedValue();
    let taskSent = false;
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    spyOn(Tmux, "capture").mockImplementation(async () => taskSent
      ? "❯ queued task with inline [AHELPA:DONE] text\n123 tokens"
      : "0 tokens\n❯ Try asking about this codebase");
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    await expect(launch({
      db,
      agentType: "claude-code",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    })).rejects.toThrow("did not expose the submitted task as a new turn");

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(db.listSessions()).toHaveLength(0);
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
