import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { executeLaunch, launch, planLaunch, resume } from "../src/commands/launch";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";
import { unlinkSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { relative, resolve } from "path";
import { shellEscape } from "../src/shell";

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
    expect(launchCommand).toContain(" --dangerously-bypass-approvals-and-sandbox");
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
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    const plan = planLaunch({
      db,
      agentType: "claude-code",
      task: "plan only",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
      label: "plan-test",
    });

    expect(plan.sessionId).toMatch(/^claude-/);
    expect(plan.ownerToken).toHaveLength(32);
    expect(plan.driver.name).toBe("claude-code");
    expect(plan.launchCmd).toContain("claude --dangerously-skip-permissions");
    expect(plan.fileHandoff.taskInstruction).toContain("Please read and complete the task described in");
    expect(plan.fileHandoff.sessionDeliveryDir).toContain(`${TEST_PROJECT}/.ahelpa/`);
    expect(plan.input.task).toBe("plan only");
    expect(existsSync(`${TEST_PROJECT}/.ahelpa`)).toBe(false);
    expect(db.listSessions()).toHaveLength(0);
  });

  test("planLaunch safe mode omits danger flags", () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    const plan = planLaunch({
      db,
      agentType: "codex",
      task: "plan safe",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
      safe: true,
    });

    expect(plan.launchCmd).toContain(" -s workspace-write -a never");
    expect(plan.launchCmd).not.toContain("--dangerously-bypass");
    expect(plan.launchCmd).not.toContain("--dangerously-skip-permissions");
  });

  test("planLaunch passes model and effort to the driver launch command", () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    const plan = planLaunch({
      db,
      agentType: "codex",
      task: "plan model",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
      model: "gpt-5.5",
      effort: "high",
    });

    expect(plan.launchCmd).toContain("--model 'gpt-5.5'");
    expect(plan.launchCmd).toContain("-c 'model_reasoning_effort=\"high\"'");
    expect(plan.input.model).toBe("gpt-5.5");
    expect(plan.input.effort).toBe("high");
  });

  test.each([
    { agentType: "codex", role: undefined, expectedRole: "worker", model: "gpt-6.1-sol", effort: "high" },
    { agentType: "claude-code", role: undefined, expectedRole: "advisor", model: "claude-opus-5-5", effort: "xhigh" },
    { agentType: "claude-code", role: "worker" as const, expectedRole: "worker", model: "claude-sonnet-5-5", effort: "high" },
    { agentType: "kimi", role: undefined, expectedRole: undefined, model: undefined, effort: undefined },
  ])("launch persists and returns the effective $agentType profile ($role)", async ({ agentType, role, expectedRole, model, effort }) => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const plan = planLaunch({ db, agentType, role, task: "task", projectPath: TEST_PROJECT, parentId: "test-parent" });
    const create = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(plan.driver, "prepareForTask").mockResolvedValue();
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    const result = await executeLaunch(plan);

    expect(plan.input.role).toBe(expectedRole);
    expect(plan.input.model).toBe(model);
    expect(plan.input.effort).toBe(effort);
    expect(db.getSession(result.sessionId)).toMatchObject({ role: expectedRole ?? null, model: model ?? null, effort: effort ?? null });
    expect(result.role).toBe(expectedRole);
    expect(result.model).toBe(model);
    expect(result.effort).toBe(effort);
    if (model) expect(create.mock.calls[0]?.[1]).toContain(shellEscape(model));
    else {
      expect(create.mock.calls[0]?.[1]).not.toContain("--model");
      expect(result).not.toHaveProperty("role");
      expect(result).not.toHaveProperty("model");
      expect(result).not.toHaveProperty("effort");
    }
  });

  test("launch persists explicit model and effort overrides along with the chosen role", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const plan = planLaunch({ db, agentType: "claude-code", role: "worker", model: "custom-model", effort: "low",
      task: "task", projectPath: TEST_PROJECT, parentId: "test-parent" });
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(plan.driver, "prepareForTask").mockResolvedValue();
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    const result = await executeLaunch(plan);

    expect(result).toMatchObject({ role: "worker", model: "custom-model", effort: "low" });
    expect(db.getSession(result.sessionId)).toMatchObject({ role: "worker", model: "custom-model", effort: "low" });
    expect(plan.launchCmd).toContain("--model 'custom-model'");
    expect(plan.launchCmd).toContain("--effort 'low'");
  });

  test("nested helper launches inherit the active absolute runtime roots", () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const plan = planLaunch({
      db,
      agentType: "codex",
      task: "nested isolation",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });

    expect(plan.launchCmd).toContain(`AHELPA_HOME=${shellEscape(defaultRuntimeLayout.ahelpaHomeDir())}`);
    expect(plan.launchCmd).toContain(`AHELPA_TMP_DIR=${shellEscape(defaultRuntimeLayout.tmpDir)}`);
  });

  test.each(["missing", "file"])("rejects a %s project before creating a terminal or handoff files", async (kind) => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const projectPath = `${TEST_PROJECT}/${kind}`;
    if (kind === "file") writeFileSync(projectPath, "regular file");
    const create = spyOn(Tmux, "create").mockResolvedValue();

    await expect(launch({ db, agentType: "codex", task: "task", projectPath, parentId: "test-parent" }))
      .rejects.toThrow(kind === "missing" ? "ENOENT" : "must be a directory");

    expect(create).not.toHaveBeenCalled();
    expect(db.listSessions()).toHaveLength(0);
    expect(existsSync(`${TEST_PROJECT}/.ahelpa`)).toBe(false);
    if (kind === "missing") expect(existsSync(projectPath)).toBe(false);
  });

  test("relative project paths stay stable through launch and resume from another working directory", async () => {
    mkdirSync(`${TEST_PROJECT}/other`, { recursive: true });
    db = new StateDB(TEST_DB);
    const callerCwd = process.cwd();
    const projectPath = resolve(TEST_PROJECT);
    const plan = planLaunch({
      db, agentType: "codex", task: "task", projectPath: relative(callerCwd, TEST_PROJECT), parentId: "test-parent",
    });
    const create = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(plan.driver, "prepareForTask").mockResolvedValue();
    spyOn(plan.driver, "prepareForResume").mockResolvedValue();
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    try {
      process.chdir(`${TEST_PROJECT}/other`);
      const launched = await executeLaunch(plan);
      expect(db.getSession(launched.sessionId)?.projectPath).toBe(projectPath);
      expect(create.mock.calls[0]?.[1]).toContain(`cd ${shellEscape(projectPath)} &&`);
      expect(plan.fileHandoff.summaryPath).toBe(`${projectPath}/.ahelpa/${launched.sessionId}/summary.md`);
      expect(resolve(projectPath, plan.fileHandoff.summaryPath)).toBe(plan.fileHandoff.summaryPath);
      db.updateStatus(launched.sessionId, "dead");
      db.updateResumeId(launched.sessionId, "synthetic-resume-token");

      const resumed = await resume({ db, sessionId: launched.sessionId, ownerToken: launched.ownerToken });

      expect(db.getSession(resumed.sessionId)?.projectPath).toBe(projectPath);
      expect(create.mock.calls[1]?.[1]).toContain(`cd ${shellEscape(projectPath)} &&`);
    } finally {
      process.chdir(callerCwd);
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

  test("preserves a conflicting wakeup path when launch rolls back", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
    db = new StateDB(TEST_DB);
    const plan = planLaunch({
      db, agentType: "codex", task: "task", projectPath: TEST_PROJECT, parentId: "test-parent",
    });
    const conflict = defaultRuntimeLayout.fifoPath(plan.sessionId);
    writeFileSync(conflict, "unowned file");
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(plan.driver, "prepareForTask").mockResolvedValue();
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);

    try {
      await expect(executeLaunch(plan)).rejects.toThrow("non-FIFO path");

      expect(readFileSync(conflict, "utf8")).toBe("unowned file");
      expect(killSpy).toHaveBeenCalledWith(plan.sessionId);
      expect(db.getSession(plan.sessionId)).toBeNull();
      expect(existsSync(plan.fileHandoff.taskFilePath)).toBe(false);
      expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
    } finally {
      try { unlinkSync(conflict); } catch {}
    }
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

  test("keeps a delivered-but-unconfirmed task alive as needs_attention", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    let taskSent = false;
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text.includes("Please read and complete")) taskSent = true;
    });
    // Echo visible, no turn evidence: afterTaskSubmitted returns false.
    spyOn(Tmux, "capture").mockImplementation(async () => taskSent
      ? "› Please read and complete the task described in /tmp/ahelpa/task.md."
      : "› Implement {feature}");
    spyOn(FIFO, "create").mockResolvedValue();
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    const result = await launch({
      db,
      agentType: "codex",
      task: "echo hello",
      projectPath: TEST_PROJECT,
      parentId: "test-parent",
    });
    sessionId = result.sessionId;

    expect(result.warning).toContain("needs_attention");
    expect(db.getSession(result.sessionId)?.status).toBe("needs_attention");
    expect(killSpy).not.toHaveBeenCalled();
    expect(existsSync(`${TEST_PROJECT}/.ahelpa/${result.sessionId}/artifacts`)).toBe(true);
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
