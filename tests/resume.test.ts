import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { resume } from "../src/commands/launch";
import { getDriver } from "../src/drivers/registry";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";
import { unlinkSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { shellEscape } from "../src/shell";

const TEST_DB = "/tmp/ahelpa-resume-test.db";
const TEST_PROJECT = "/tmp/ahelpa-resume-test-project";

describe("extractResumeToken", () => {
  test("claude-code extracts resume ID from exit output", () => {
    const driver = getDriver("claude-code");
    const output = [
      "╭─────────────────────────────────────╮",
      "│ Total cost: $0.15                   │",
      "│ Resume this session with:           │",
      "│   claude --resume dc8ca9c2-766b-4d52-9623-1ff9d44b2075 │",
      "╰─────────────────────────────────────╯",
    ].join("\n");
    expect(driver.extractResumeToken(output)).toBe("dc8ca9c2-766b-4d52-9623-1ff9d44b2075");
  });

  test("codex extracts resume ID from exit output", () => {
    const driver = getDriver("codex");
    const output = [
      "Token usage: total=23,324 input=23,209 (+ 2,432 cached) output=115",
      "To continue this session, run codex resume 019ed880-4604-7ad1-8ba7-dcbbba1f34f3",
    ].join("\n");
    expect(driver.extractResumeToken(output)).toBe("019ed880-4604-7ad1-8ba7-dcbbba1f34f3");
  });

  test("kimi extracts resume ID after the first message", () => {
    const driver = getDriver("kimi");
    expect(driver.extractResumeToken(
      "Welcome to Kimi Code!\n│  Session:   session_bce9aed7-8ee0-42ba-8ee8-5326e673db72  │",
    )).toBe("session_bce9aed7-8ee0-42ba-8ee8-5326e673db72");
  });

  test("returns null when no resume token present", () => {
    const driver = getDriver("claude-code");
    expect(driver.extractResumeToken("some random output\nno resume here")).toBeNull();
  });
});

describe("buildResumeCommand", () => {
  test("claude-code builds resume command with --resume flag", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: "abc-123" });
    expect(cmd).toContain("claude --resume");
    expect(cmd).toContain("abc-123");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  test("claude-code safe resume omits danger flag", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: "abc-123", safe: true });
    expect(cmd).toContain("claude --resume");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  test("codex builds resume command", () => {
    const driver = getDriver("codex");
    const cmd = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: "abc-123" });
    expect(cmd).toContain(" resume 'abc-123' ");
    expect(cmd).toContain("--dangerously-bypass");
  });

  test("kimi builds resume command with its native --session flag", () => {
    const driver = getDriver("kimi");
    const cmd = driver.buildResumeCommand({
      cwd: "/tmp/project",
      resumeId: "session_bce9aed7-8ee0-42ba-8ee8-5326e673db72",
      model: "review-model",
    });

    expect(cmd).toContain("kimi --session 'session_bce9aed7-8ee0-42ba-8ee8-5326e673db72'");
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("--model 'review-model'");
  });

  test("resume commands carry model and effort", () => {
    const claude = getDriver("claude-code").buildResumeCommand({
      cwd: "/tmp/project", resumeId: "abc-123", model: "opus", effort: "max",
    });
    expect(claude).toContain("--model 'opus'");
    expect(claude).toContain("--effort 'max'");

    const codex = getDriver("codex").buildResumeCommand({
      cwd: "/tmp/project", resumeId: "abc-123", model: "gpt-5.5", effort: "high",
    });
    expect(codex).toContain("--model 'gpt-5.5'");
    expect(codex).toContain("-c 'model_reasoning_effort=\"high\"'");
  });
});

describe("resume command", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  test("resumes a dead session with agent resume token", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    db.createSession({
      id: "claude-old1",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "original task",
      ownerToken: "tok-abc",
      projectPath: TEST_PROJECT,
      depth: 1,
    });
    db.updateStatus("claude-old1", "dead");
    db.updateResumeId("claude-old1", "dc8ca9c2-766b-4d52-9623-1ff9d44b2075");

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxSpy = spyOn(Tmux, "create").mockResolvedValue();
    const captureSpy = spyOn(Tmux, "capture").mockResolvedValue("0 tokens\n❯");
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();

    const result = await resume({
      db,
      sessionId: "claude-old1",
      ownerToken: "tok-abc",
    });

    expect(result.resumedFrom).toBe("claude-old1");
    expect(result.sessionId).toMatch(/^claude-/);
    expect(tmuxSpy).toHaveBeenCalledTimes(1);
    const cmd = tmuxSpy.mock.calls[0]?.[1];
    expect(cmd).toContain("claude --resume");
    expect(cmd).toContain("dc8ca9c2-766b-4d52-9623-1ff9d44b2075");
    expect(captureSpy).toHaveBeenCalled();

    const newSession = db.getSession(result.sessionId);
    expect(newSession).not.toBeNull();
    expect(newSession!.resumedFrom).toBe("claude-old1");
    expect(newSession!.status).toBe("needs_attention");
  });

  test("resume reuses the recorded role, model, and effort without applying new profile defaults", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    db.createSession({
      id: "claude-model1",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "original task",
      ownerToken: "tok-m",
      projectPath: TEST_PROJECT,
      depth: 1,
      role: "worker",
      model: "opus",
      effort: "max",
      jobId: "parser-fix",
    });
    db.updateStatus("claude-model1", "dead");
    db.updateResumeId("claude-model1", "resume-uuid-999");

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxSpy = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("0 tokens\n❯");
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();

    const result = await resume({ db, sessionId: "claude-model1", ownerToken: "tok-m" });

    const cmd = tmuxSpy.mock.calls[0]?.[1];
    expect(cmd).toContain("--model 'opus'");
    expect(cmd).toContain("--effort 'max'");
    expect(cmd).toMatch(/AHELPA_JOB_ID='?parser-fix'?[; ]/);

    const newSession = db.getSession(result.sessionId);
    expect(newSession!.role).toBe("worker");
    expect(newSession!.model).toBe("opus");
    expect(newSession!.effort).toBe("max");
    expect(newSession!.jobId).toBe("parser-fix");
    expect(result).toMatchObject({ role: "worker", model: "opus", effort: "max" });
  });

  test.each(["codex", "claude-code", "kimi"])("resume keeps unknown historical %s role and model settings unknown", async (agentType) => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const id = "historical-defaults";
    db.createSession({ id, parentId: "p", agentType, task: "original", ownerToken: "tok", projectPath: TEST_PROJECT });
    db.updateStatus(id, "dead");
    db.updateResumeId(id, "session_historical-token");
    const create = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(getDriver(agentType), "prepareForResume").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    const result = await resume({ db, sessionId: id, ownerToken: "tok" });

    expect(db.getSession(result.sessionId)).toMatchObject({ role: null, model: null, effort: null });
    expect(result).not.toHaveProperty("role");
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("effort");
    const command = create.mock.calls[0]?.[1] ?? "";
    expect(command).not.toContain("--model");
    expect(command).not.toContain("--effort");
    expect(command).not.toContain("model_reasoning_effort");
    expect(db.getSession(id)).toMatchObject({ role: null, model: null, effort: null });
  });

  test("resume preserves a safe launch posture without another flag", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    db.createSession({
      id: "kimi-safe1",
      parentId: "cli-1",
      agentType: "kimi",
      task: "original safe task",
      ownerToken: "tok-safe",
      projectPath: TEST_PROJECT,
      safe: true,
    });
    db.updateStatus("kimi-safe1", "dead");
    db.updateResumeId("kimi-safe1", "session_safe123");

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxSpy = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("│ > │");
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();

    const result = await resume({ db, sessionId: "kimi-safe1", ownerToken: "tok-safe" });

    const cmd = tmuxSpy.mock.calls[0]?.[1];
    expect(cmd).toContain("kimi --session 'session_safe123'");
    expect(cmd).not.toContain("--yolo");
    expect(db.getSession(result.sessionId)?.safe).toBe(true);
  });

  test("resume propagates isolated runtime roots to the new tmux session", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "claude-isolated",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "original task",
      ownerToken: "tok-isolated",
      projectPath: TEST_PROJECT,
    });
    db.updateStatus("claude-isolated", "dead");
    db.updateResumeId("claude-isolated", "resume-isolated-1");

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxSpy = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("0 tokens\n❯");
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();

    await resume({ db, sessionId: "claude-isolated", ownerToken: "tok-isolated" });

    const command = tmuxSpy.mock.calls[0]?.[1];
    expect(command).toContain(`AHELPA_HOME=${shellEscape(defaultRuntimeLayout.ahelpaHomeDir())}`);
    expect(command).toContain(`AHELPA_TMP_DIR=${shellEscape(defaultRuntimeLayout.tmpDir)}`);
  });

  test("rejects a legacy relative project path instead of guessing its original working directory", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "legacy-relative", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: "." });
    db.updateStatus("legacy-relative", "dead");
    db.updateResumeId("legacy-relative", "resume-legacy");
    const create = spyOn(Tmux, "create").mockResolvedValue();

    await expect(resume({ db, sessionId: "legacy-relative", ownerToken: "tok" }))
      .rejects.toThrow("original working directory is unknown");

    expect(create).not.toHaveBeenCalled();
    expect(db.getSession("legacy-relative")?.projectPath).toBe(".");
    expect(db.listSessions()).toHaveLength(1);
  });

  test.each(["missing", "file"])("rejects a %s recorded project before creating a resumed terminal", async (kind) => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    const projectPath = `${TEST_PROJECT}/${kind}`;
    if (kind === "file") writeFileSync(projectPath, "regular file");
    db.createSession({ id: "invalid-project", parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath });
    db.updateStatus("invalid-project", "dead");
    db.updateResumeId("invalid-project", "resume-invalid");
    const create = spyOn(Tmux, "create").mockResolvedValue();

    await expect(resume({ db, sessionId: "invalid-project", ownerToken: "tok" }))
      .rejects.toThrow(kind === "missing" ? "ENOENT" : "must be a directory");

    expect(create).not.toHaveBeenCalled();
    expect(db.listSessions()).toHaveLength(1);
  });

  test("resume reclaims the new tmux session when the driver never becomes ready", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "claude-not-ready",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "original task",
      ownerToken: "tok-not-ready",
      projectPath: TEST_PROJECT,
    });
    db.updateStatus("claude-not-ready", "dead");
    db.updateResumeId("claude-not-ready", "resume-not-ready-1");

    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("Claude Code is still starting");
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();

    await expect(resume({
      db,
      sessionId: "claude-not-ready",
      ownerToken: "tok-not-ready",
    })).rejects.toThrow("did not reach its input prompt");

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(db.listSessions()).toHaveLength(1);
  });

  test("resume does not kill an unowned tmux when creation fails", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "claude-create-fails",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "original task",
      ownerToken: "tok-create-fails",
      projectPath: TEST_PROJECT,
    });
    db.updateStatus("claude-create-fails", "dead");
    db.updateResumeId("claude-create-fails", "resume-create-fails-1");

    spyOn(Tmux, "create").mockRejectedValue(new Error("tmux name already exists"));
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();

    await expect(resume({
      db,
      sessionId: "claude-create-fails",
      ownerToken: "tok-create-fails",
    })).rejects.toThrow("tmux name already exists");

    expect(killSpy).not.toHaveBeenCalled();
    expect(db.listSessions()).toHaveLength(1);
    expect(db.getSession("claude-create-fails")?.status).toBe("dead");
  });

  test("preserves a conflicting wakeup path when resume rolls back", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
    db = new StateDB(TEST_DB);
    const oldId = "claude-fifo-conflict";
    db.createSession({
      id: oldId, parentId: "cli-1", agentType: "claude-code", task: "original task",
      ownerToken: "tok-conflict", projectPath: TEST_PROJECT,
    });
    db.updateStatus(oldId, "dead");
    db.updateResumeId(oldId, "resume-fifo-conflict");
    let newId = "";
    let conflict = "";
    spyOn(Tmux, "create").mockImplementation(async (id) => {
      newId = id;
      conflict = defaultRuntimeLayout.fifoPath(id);
      writeFileSync(conflict, "unowned file");
    });
    const killSpy = spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(getDriver("claude-code"), "prepareForResume").mockResolvedValue();

    try {
      await expect(resume({ db, sessionId: oldId, ownerToken: "tok-conflict" }))
        .rejects.toThrow("non-FIFO path");

      expect(readFileSync(conflict, "utf8")).toBe("unowned file");
      expect(killSpy).toHaveBeenCalledWith(newId);
      expect(db.getSession(newId)).toBeNull();
      expect(db.listSessions()).toHaveLength(1);
      expect(db.getSession(oldId)?.agentResumeId).toBe("resume-fifo-conflict");
    } finally {
      if (conflict) try { unlinkSync(conflict); } catch {}
    }
  });

  test("a resumed Kimi record immediately inherits the agent session ID", async () => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);

    db.createSession({
      id: "kimi-old1",
      parentId: "cli-1",
      agentType: "kimi",
      task: "original task",
      ownerToken: "tok-kimi",
      projectPath: TEST_PROJECT,
      depth: 1,
      model: "review-model",
    });
    db.updateStatus("kimi-old1", "dead");
    db.updateResumeId("kimi-old1", "session_bce9aed7-8ee0-42ba-8ee8-5326e673db72");

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxSpy = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue(
      "Welcome to Kimi Code!\n│  Session:   session_bce9aed7-8ee0-42ba-8ee8-5326e673db72  │\n│ >   │",
    );
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();

    const result = await resume({ db, sessionId: "kimi-old1", ownerToken: "tok-kimi" });
    const command = tmuxSpy.mock.calls[0]?.[1];
    expect(command).toContain("kimi --session 'session_bce9aed7-8ee0-42ba-8ee8-5326e673db72'");
    expect(command).toContain("--model 'review-model'");
    expect(db.getSession(result.sessionId)?.agentResumeId)
      .toBe("session_bce9aed7-8ee0-42ba-8ee8-5326e673db72");
    expect(db.getSession(result.sessionId)?.status).toBe("needs_attention");
  });

  test("rejects resume of running session", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "claude-run1",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "running task",
      ownerToken: "tok-run",
      projectPath: "/tmp",
      depth: 1,
    });

    await expect(resume({
      db,
      sessionId: "claude-run1",
      ownerToken: "tok-run",
    })).rejects.toThrow(/must be idle or dead.*running/);
  });

  test("rejects another resume while a resumed helper is awaiting input", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "kimi-live-resume",
      parentId: "cli-1",
      agentType: "kimi",
      task: "(resumed)",
      ownerToken: "tok-live",
      projectPath: "/tmp",
      depth: 1,
    });
    db.updateResumeId("kimi-live-resume", "session_live-123");
    db.updateStatus("kimi-live-resume", "needs_attention");

    await expect(resume({
      db,
      sessionId: "kimi-live-resume",
      ownerToken: "tok-live",
    })).rejects.toThrow(/must be idle or dead.*needs_attention/);
  });

  test("rejects resume while a settled idle helper still has its terminal", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "kimi-idle-live", parentId: "cli-1", agentType: "kimi",
      task: "completed task", ownerToken: "tok-idle", projectPath: TEST_PROJECT,
    });
    db.updateStatus("kimi-idle-live", "idle");
    db.updateResumeId("kimi-idle-live", "session_idle-live");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    const createSpy = spyOn(Tmux, "create").mockResolvedValue();

    await expect(resume({ db, sessionId: "kimi-idle-live", ownerToken: "tok-idle" }))
      .rejects.toThrow("still has an active terminal");

    expect(createSpy).not.toHaveBeenCalled();
    expect(db.getSession("kimi-idle-live")?.status).toBe("idle");
  });

  test("rejects resume without resume token", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "claude-nort1",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "no token task",
      ownerToken: "tok-nort",
      projectPath: "/tmp",
      depth: 1,
    });
    db.updateStatus("claude-nort1", "dead");

    await expect(resume({
      db,
      sessionId: "claude-nort1",
      ownerToken: "tok-nort",
    })).rejects.toThrow(/no resume token/);
  });

  test("rejects resume with wrong token", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "claude-auth1",
      parentId: "cli-1",
      agentType: "claude-code",
      task: "auth task",
      ownerToken: "tok-real",
      projectPath: "/tmp",
      depth: 1,
    });

    await expect(resume({
      db,
      sessionId: "claude-auth1",
      ownerToken: "tok-fake",
    })).rejects.toThrow(/Invalid token/);
  });
});

describe("state: resume fields", () => {
  let db: StateDB;

  afterEach(() => {
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
  });

  test("updateResumeId stores and retrieves agent resume ID", () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "s1",
      parentId: "p1",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
    });

    db.updateResumeId("s1", "resume-uuid-123");
    const session = db.getSession("s1");
    expect(session!.agentResumeId).toBe("resume-uuid-123");
  });

  test("resumedFrom is stored on creation", () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "s2",
      parentId: "p1",
      agentType: "codex",
      task: "resumed task",
      ownerToken: "tok",
      projectPath: "/tmp",
      resumedFrom: "s1",
    });

    const session = db.getSession("s2");
    expect(session!.resumedFrom).toBe("s1");
  });

  test("fields default to null when not set", () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "s3",
      parentId: "p1",
      agentType: "codex",
      task: "plain task",
      ownerToken: "tok",
      projectPath: "/tmp",
    });

    const session = db.getSession("s3");
    expect(session!.agentResumeId).toBeNull();
    expect(session!.resumedFrom).toBeNull();
    expect(session!.model).toBeNull();
    expect(session!.effort).toBeNull();
    expect(session!.role).toBeNull();
  });

  test("model and effort round-trip through the session record", () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "s4",
      parentId: "p1",
      agentType: "codex",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
      model: "gpt-5.5",
      effort: "xhigh",
    });

    const session = db.getSession("s4");
    expect(session!.model).toBe("gpt-5.5");
    expect(session!.effort).toBe("xhigh");
  });
});
