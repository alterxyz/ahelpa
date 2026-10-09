import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { StateDB } from "../src/state";
import { COMMAND_CONTRACTS, runCli } from "../src/command-contract";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { getDriver } from "../src/drivers/registry";

const TEST_DB = "/tmp/ahelpa-dispatch-test.db";
const TEST_PROJECT = "/tmp/ahelpa-dispatch-project";
const TEST_TASK_FILE = "/tmp/ahelpa-dispatch-task.md";

interface Captured {
  out: string[];
  err: string[];
}

function io(captured: Captured) {
  return {
    print: (text: string) => captured.out.push(text),
    printError: (text: string) => captured.err.push(text),
  };
}

describe("cli dispatch", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    try { if (existsSync(TEST_TASK_FILE)) unlinkSync(TEST_TASK_FILE); } catch {}
    try {
      const taskPath = defaultRuntimeLayout.taskFilePath("task-cli-1");
      if (existsSync(taskPath)) unlinkSync(taskPath);
    } catch {}
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  test("no command prints help and succeeds", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, [], io(captured));

    expect(code).toBe(0);
    expect(captured.out[0]).toContain("ahelpa - Agent Help Agent");
  });

  test("unknown command fails with a message", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["frobnicate"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("Unknown command: frobnicate");
  });

  test("missing required flag fails with the flag name", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["launch", "claude-code"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toBe("--task or --file is required");
  });

  test("missing positionals fail with the contract usage", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["wait"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("Usage: ahelpa wait (<id...> | --job <id>)");
  });

  test.each([
    { argv: ["clean", "only-this-id"] },
    { argv: ["daemon", "start", "stop"] },
    { argv: ["send", "session-id", "hello", "world", "--token", "tok"] },
    { argv: ["kill", "id-1", "id-2", "--token", "tok"] },
    { argv: ["launch", "codex", "extra", "--task", "task"] },
    { argv: ["models", "codex", "kimi"] },
  ])("rejects excess positionals before executing $argv", async ({ argv }) => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    const contract = COMMAND_CONTRACTS.find((entry) => entry.name === argv[0])!;
    const handlerSpy = spyOn(contract, "run").mockResolvedValue();
    expect(await runCli(db, [...argv], io(captured))).toBe(1);
    expect(captured.err[0]).toContain(`Usage: ahelpa ${argv[0]}`);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  test("help rejects extra input instead of reporting success", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["help", "extra"], io(captured))).toBe(1);
    expect(captured.err[0]).toBe("Usage: ahelpa help");
    expect(captured.out).toEqual([]);
  });

  test("non-numeric number flag fails before the handler runs", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["wait", "some-id", "--timeout", "soon"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toBe("--timeout must be a number");
  });

  test("wait --all before IDs includes every requested session", async () => {
    db = new StateDB(TEST_DB);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["wait", "--all", "missing-1", "missing-2", "--timeout", "0"], io(captured))).toBe(0);
    expect(JSON.parse(captured.out[0])).toEqual([
      { sessionId: "missing-1", status: "dead" },
      { sessionId: "missing-2", status: "dead" },
    ]);
  });

  test.each(["1oops", "Infinity", "NaN"])("rejects malformed timeout %s", async (timeout) => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["wait", "some-id", "--timeout", timeout], io(captured))).toBe(1);
    expect(captured.err[0]).toBe("--timeout must be a number");
  });

  test("required string flag without a value fails before launching", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["launch", "codex", "--task"], io(captured))).toBe(1);
    expect(captured.err[0]).toBe("--task requires a value");
  });

  test.each([
    { argv: ["wait", "some-id", "--timeout"], flag: "timeout" },
    { argv: ["capture", "some-id", "--token", "tok", "--lines"], flag: "lines" },
    { argv: ["launch", "codex", "--task", "task", "--project"], flag: "project" },
    { argv: ["launch", "codex", "--task", "task", "--parent="], flag: "parent" },
    { argv: ["launch", "codex", "--task", "task", "--label", ""], flag: "label" },
    { argv: ["launch", "codex", "--task", "task", "--safe="], flag: "safe" },
    { argv: ["install-skill", "--source"], flag: "source" },
  ])("rejects an explicitly empty --$flag before executing its handler", async ({ argv, flag }) => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    const contract = COMMAND_CONTRACTS.find((entry) => entry.name === argv[0])!;
    const handlerSpy = spyOn(contract, "run").mockResolvedValue();
    expect(await runCli(db, [...argv], io(captured))).toBe(1);
    expect(captured.err[0]).toBe(`--${flag} requires a value`);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  test("invalid boolean spelling fails instead of silently disabling the flag", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["wait", "some-id", "--all=flase"], io(captured))).toBe(1);
    expect(captured.err[0]).toBe("--all must be true or false");
  });

  test("timeout conversion cannot overflow into an unbounded wait", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["wait", "some-id", "--timeout", "1e308"], io(captured))).toBe(1);
    expect(captured.err[0]).toBe("--timeout must be a finite duration");
  });

  test.each(["0", "-1", "10.5"])("rejects invalid capture line count %s", async (lines) => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["capture", "some-id", "--token", "tok", "--lines", lines], io(captured))).toBe(1);
    expect(captured.err[0]).toBe("--lines must be a positive integer");
  });

  test("unknown flags fail instead of being silently dropped", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["launch", "codex", "--task", "t", "--modle", "gpt-5.5"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("Unknown flag --modle");
  });

  test.each(["__proto__", "constructor", "toString"])("rejects prototype-like unknown flag --%s", async (flag) => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["version", `--${flag}=x`], io(captured))).toBe(1);
    expect(captured.err[0]).toContain(`Unknown flag --${flag}`);
  });

  test("equals-syntax flags resolve like space-separated ones", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    // Explicit empty values must fail instead of falling back to defaults.
    const code = await runCli(db, ["launch", "codex", "--task="], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toBe("--task requires a value");
  });

  test("session not found includes error code in output", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["kill", "missing-session", "--token", "tok"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("[SESSION_NOT_FOUND]");
    expect(captured.err[0]).toContain("Session not found");
  });

  test("invalid token includes error code in output", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "auth-1", parentId: "p", agentType: "claude-code",
      task: "t", ownerToken: "real-token", projectPath: "/tmp",
    });
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["kill", "auth-1", "--token", "wrong-token"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("[INVALID_TOKEN]");
  });

  test("number flags reach the handler typed", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "cap-1", parentId: "p", agentType: "claude-code",
      task: "t", ownerToken: "tok", projectPath: "/tmp",
    });
    const captureSpy = spyOn(Tmux, "capture").mockResolvedValue("output");
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["capture", "cap-1", "--token", "tok", "--lines", "7"], io(captured));

    expect(code).toBe(0);
    expect(captureSpy).toHaveBeenCalledWith("cap-1", 7);
    expect(captured.out[0]).toBe("output");
  });

  test("send command authorizes with token before sending message", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "send-1", parentId: "p", agentType: "claude-code",
      task: "t", ownerToken: "tok", projectPath: "/tmp",
    });
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["send", "send-1", "hello", "--token", "tok"], io(captured));

    expect(code).toBe(0);
    expect(captured.out[0]).toBe("sent");
    expect(sendKeysSpy).toHaveBeenCalledWith("send-1", "hello");
  });

  test("send still allows an explicitly empty message to submit the current input", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "send-empty", parentId: "p", agentType: "claude-code",
      task: "t", ownerToken: "tok", projectPath: "/tmp",
    });
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["send", "send-empty", "", "--token", "tok"], io(captured))).toBe(0);
    expect(sendKeysSpy).toHaveBeenCalledWith("send-empty", "");
  });

  test("model command authorizes and switches the running helper model", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "model-1", parentId: "p", agentType: "claude-code",
      task: "t", ownerToken: "tok", projectPath: "/tmp",
    });
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    const sendKeySpy = spyOn(Tmux, "sendKey").mockResolvedValue();
    spyOn(Tmux, "capture")
      .mockResolvedValueOnce([
        "Select model",
        "  1. Default",
        "  2. Opus",
        "❯ 3. Sonnet",
        "  4. Haiku",
      ].join("\n"))
      .mockResolvedValueOnce("Set model to Haiku 4.5 for this session only");
    spyOn(Bun, "sleep").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["model", "model-1", "--to", "haiku", "--token", "tok"], io(captured));

    expect(code).toBe(0);
    expect(captured.out[0]).toContain("Set model to Haiku 4.5");
    expect(sendKeysSpy).toHaveBeenCalledWith("model-1", "/model");
    expect(sendKeySpy).toHaveBeenCalledWith("model-1", "Down");
    expect(sendKeySpy).toHaveBeenCalledWith("model-1", "s");
  });

  test("launch accepts an explicit parent for headless hosts", async () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture")
      .mockResolvedValueOnce("› Implement {feature}")
      .mockResolvedValueOnce("› Implement {feature}")
      .mockResolvedValue("› t\nWorking (1s)");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, [
      "launch", "codex",
      "--task", "t",
      "--project", TEST_PROJECT,
      "--parent", "headless-codex-1",
    ], io(captured));

    expect(code).toBe(0);
    const result = JSON.parse(captured.out[0]);
    expect(db.getSession(result.sessionId)?.parentId).toBe("headless-codex-1");
    expect(result).toMatchObject({ role: "worker", model: "gpt-6.1-sol", effort: "high" });
  });

  test("launch --role worker selects and reports the Claude worker defaults", async () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const createSpy = spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("ready");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    const driver = getDriver("claude-code");
    spyOn(driver, "prepareForTask").mockResolvedValue();
    spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
    const captured: Captured = { out: [], err: [] };

    expect(await runCli(db, ["launch", "claude-code", "--role", "worker",
      "--task", "Implement the agreed change", "--project", TEST_PROJECT], io(captured))).toBe(0);
    const result = JSON.parse(captured.out[0]);
    const profile = { role: "worker", model: "claude-sonnet-5-5", effort: "high" };
    expect(result).toMatchObject(profile);
    expect(db.getSession(result.sessionId)).toMatchObject(profile);
    expect(createSpy.mock.calls[0][1]).toContain("--model 'claude-sonnet-5-5' --effort 'high'");
    unlinkSync(defaultRuntimeLayout.taskFilePath(result.sessionId));
  });

  test("a temp path inside --file content is not flagged, the same text via --task is", async () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("ready");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    const driver = getDriver("claude-code");
    spyOn(driver, "prepareForTask").mockResolvedValue();
    spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
    const taskPath = `${TEST_PROJECT}/durable-task.md`;
    writeFileSync(taskPath, "Fix cleanup of /tmp/out.log\n");

    const viaFile: Captured = { out: [], err: [] };
    expect(await runCli(db, ["launch", "claude-code", "--file", taskPath, "--project", TEST_PROJECT], io(viaFile))).toBe(0);
    const fromFile = JSON.parse(viaFile.out[0]);
    expect(fromFile.taskWarning).toBeUndefined();
    unlinkSync(defaultRuntimeLayout.taskFilePath(fromFile.sessionId));

    const viaTask: Captured = { out: [], err: [] };
    expect(await runCli(db, ["launch", "claude-code", "--task", "Fix cleanup of /tmp/out.log", "--project", TEST_PROJECT], io(viaTask))).toBe(0);
    const fromTask = JSON.parse(viaTask.out[0]);
    expect(fromTask.taskWarning).toMatch(/--file/);
    unlinkSync(defaultRuntimeLayout.taskFilePath(fromTask.sessionId));
  });

  test.each([
    ["claude-code", "normal"], ["codex", "advisor"], ["kimi", "worker"],
  ])("rejects unsupported %s role %s before creating a terminal", async (agent, role) => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    const createSpy = spyOn(Tmux, "create").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["launch", agent, "--role", role, "--task", "t",
      "--project", TEST_PROJECT], io(captured))).toBe(1);
    expect(captured.err[0]).toContain("role");
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.listSessions()).toHaveLength(0);
  });

  test("launch --file snapshots multiline instructions without putting the body in tmux input", async () => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    const task = "Review the parser.\n\nKeep literal `code`, $(commands), and \"quotes\".\n".repeat(100);
    writeFileSync(TEST_TASK_FILE, task);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "capture")
      .mockResolvedValueOnce("› Implement {feature}")
      .mockResolvedValueOnce("› Implement {feature}")
      .mockResolvedValue("› task\nWorking (1s)");
    const sendSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
    spyOn(Bun, "sleep").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };

    expect(await runCli(db, ["launch", "codex", "--file", TEST_TASK_FILE,
      "--project", TEST_PROJECT], io(captured))).toBe(0);
    const result = JSON.parse(captured.out[0]);
    expect(db.getSession(result.sessionId)?.task).toBe(task);
    const handoffPath = defaultRuntimeLayout.taskFilePath(result.sessionId);
    const handedOffTask = readFileSync(handoffPath, "utf-8");
    expect(handedOffTask).toStartWith(`${task}\n\n---\n\n## ahelpa contract\n\n`);
    expect(handedOffTask).toContain("[AHELPA:NEED_HELP:review,input]");
    expect(sendSpy.mock.calls[0][1]).toContain(handoffPath);
    expect(sendSpy.mock.calls[0][1]).not.toContain("Keep literal");
    writeFileSync(TEST_TASK_FILE, "later edit");
    expect(readFileSync(handoffPath, "utf-8")).toBe(handedOffTask);
    unlinkSync(handoffPath);
  });

  test.each([
    { args: ["--task", "inline", "--file", TEST_TASK_FILE], error: "Use exactly one" },
    { args: ["--task", "inline", "--file"], error: "--file requires a value" },
    { args: ["--task", "inline", "--file="], error: "--file requires a value" },
    { args: ["--task=", "--file", TEST_TASK_FILE], error: "--task requires a value" },
    { args: ["--task", "--file", TEST_TASK_FILE], error: "--task requires a value" },
    { args: ["--task=", "--file="], error: "--task requires a value" },
    { args: ["--task", " \n "], error: "Task must not be empty" },
    { args: ["--file", TEST_TASK_FILE], error: "Task must not be empty" },
    { args: ["--file", TEST_PROJECT], error: "regular file" },
    { args: ["--file", `${TEST_PROJECT}/missing.md`], error: "ENOENT" },
  ])("invalid launch task fails before creating a helper: $args", async ({ args, error }) => {
    db = new StateDB(TEST_DB);
    mkdirSync(TEST_PROJECT, { recursive: true });
    writeFileSync(TEST_TASK_FILE, " \n");
    const createSpy = spyOn(Tmux, "create").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };
    expect(await runCli(db, ["launch", "codex", ...args], io(captured))).toBe(1);
    expect(captured.err[0]).toContain(error);
    expect(createSpy).not.toHaveBeenCalled();
    expect(db.listSessions()).toHaveLength(0);
  });

  test("check runs end to end through the dispatch", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "chk-1", parentId: "p", agentType: "codex",
      task: "do things", ownerToken: "tok", projectPath: "/tmp",
    });
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["check"], io(captured));

    expect(code).toBe(0);
    const sessions = JSON.parse(captured.out[0]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("chk-1");
  });

  test("task command writes through the file handoff contract", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "task-cli-1", parentId: "p", agentType: "codex",
      task: "old task", ownerToken: "tok", projectPath: TEST_PROJECT,
    });
    writeFileSync(TEST_TASK_FILE, "new task body");
    const sendKeysSpy = spyOn(Tmux, "sendKeys").mockResolvedValue();
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["task", "task-cli-1", "--file", TEST_TASK_FILE, "--token", "tok"], io(captured));

    expect(code).toBe(0);
    expect(captured.out[0]).toBe("task sent");
    expect(readFileSync(defaultRuntimeLayout.taskFilePath("task-cli-1"), "utf-8"))
      .toStartWith("new task body\n\n---\n\n## ahelpa contract\n\n");
    expect(existsSync(`${TEST_PROJECT}/.ahelpa/task-cli-1/artifacts`)).toBe(true);
    expect(sendKeysSpy).toHaveBeenCalledTimes(1);
    const instruction = sendKeysSpy.mock.calls[0]?.[1];
    expect(instruction).toContain(`${TEST_PROJECT}/.ahelpa/task-cli-1/summary.md`);
  });

  test("version reports the runtime version", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["version"], io(captured));

    expect(code).toBe(0);
    expect(captured.out[0]).toMatch(/^ahelpa \d+\.\d+\.\d+$/);
  });
});
