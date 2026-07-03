import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { resume } from "../src/commands/launch";
import { getDriver } from "../src/drivers/registry";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";
import { unlinkSync, existsSync, mkdirSync, rmSync } from "fs";

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
    expect(cmd).toContain("codex resume");
    expect(cmd).toContain("abc-123");
    expect(cmd).toContain("--dangerously-bypass");
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

    const newSession = db.getSession(result.sessionId);
    expect(newSession).not.toBeNull();
    expect(newSession!.resumedFrom).toBe("claude-old1");
    expect(newSession!.status).toBe("running");
  });

  test("resume reuses the recorded launch model and effort", async () => {
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
      model: "opus",
      effort: "max",
    });
    db.updateStatus("claude-model1", "dead");
    db.updateResumeId("claude-model1", "resume-uuid-999");

    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const tmuxSpy = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();

    const result = await resume({ db, sessionId: "claude-model1", ownerToken: "tok-m" });

    const cmd = tmuxSpy.mock.calls[0]?.[1];
    expect(cmd).toContain("--model 'opus'");
    expect(cmd).toContain("--effort 'max'");

    const newSession = db.getSession(result.sessionId);
    expect(newSession!.model).toBe("opus");
    expect(newSession!.effort).toBe("max");
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
    })).rejects.toThrow(/still running/);
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
