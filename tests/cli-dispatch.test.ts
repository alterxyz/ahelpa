import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { StateDB } from "../src/state";
import { runCli } from "../src/command-contract";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";
import { FIFO } from "../src/fifo";

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
    try { if (existsSync("/tmp/ahelpa/ahelpa-task-task-cli-1.md")) unlinkSync("/tmp/ahelpa/ahelpa-task-task-cli-1.md"); } catch {}
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
    expect(captured.err[0]).toBe("--task is required");
  });

  test("missing positionals fail with the contract usage", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["wait"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("Usage: ahelpa wait <id...>");
  });

  test("non-numeric number flag fails before the handler runs", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["wait", "some-id", "--timeout", "soon"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toBe("--timeout must be a number");
  });

  test("unknown flags fail instead of being silently dropped", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    const code = await runCli(db, ["launch", "codex", "--task", "t", "--modle", "gpt-5.5"], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toContain("Unknown flag --modle");
  });

  test("equals-syntax flags resolve like space-separated ones", async () => {
    db = new StateDB(TEST_DB);
    const captured: Captured = { out: [], err: [] };

    // Empty required value via equals syntax is treated as missing.
    const code = await runCli(db, ["launch", "codex", "--task="], io(captured));

    expect(code).toBe(1);
    expect(captured.err[0]).toBe("--task is required");
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
    spyOn(Tmux, "capture").mockResolvedValue("Working (1s)");
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
    expect(readFileSync("/tmp/ahelpa/ahelpa-task-task-cli-1.md", "utf-8")).toBe("new task body");
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
