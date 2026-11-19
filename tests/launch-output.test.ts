import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { getDriver } from "../src/drivers/registry";
import * as capabilities from "../src/drivers/codex-capabilities";
import * as daemon from "../src/daemon";
import { runCli } from "../src/command-contract";
import { planSessionHandoff } from "../src/file-handoff";
import { defaultWakeup } from "../src/wakeup";

const driver = getDriver("codex");

let root: string;
let project: string;
let db: StateDB;

interface Captured { out: string[]; err: string[] }

function io(captured: Captured) {
  return {
    print: (text: string) => captured.out.push(text),
    printError: (text: string) => captured.err.push(text),
  };
}

async function launchCli(captured: Captured, ...flags: string[]): Promise<number> {
  return runCli(db, ["launch", "codex", "--task", "t", "--project", project, ...flags], io(captured));
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "launch-output-"));
  project = join(root, "project");
  mkdirSync(project);
  db = new StateDB(join(root, "state.db"));
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  spyOn(defaultWakeup, "prepare").mockResolvedValue();
  spyOn(Tmux, "hasSession").mockResolvedValue(false);
  spyOn(Tmux, "create").mockResolvedValue();
  spyOn(Tmux, "capture").mockResolvedValue("");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(Tmux, "sendKey").mockResolvedValue();
  spyOn(Tmux, "kill").mockResolvedValue();
  spyOn(capabilities, "getCodexCapabilities").mockReturnValue({ executable: "/bin/echo", noDaemon: true });
  spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
  spyOn(driver, "prepareForTask").mockResolvedValue();
});

afterEach(() => {
  mock.restore();
  for (const row of db.listSessions()) rmSync(planSessionHandoff(row).taskFilePath, { force: true });
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("launch output", () => {
  test("warns on stderr when --after names a session that is still running", async () => {
    db.createSession({ id: "prev", parentId: "host", agentType: "codex", task: "first", ownerToken: "tok", projectPath: project });
    expect(db.getSession("prev")?.status).toBe("running");

    const captured: Captured = { out: [], err: [] };
    const code = await launchCli(captured, "--after", "prev");

    expect(code).toBe(0);
    const sessionId = JSON.parse(captured.out[0]).sessionId;
    const stderr = captured.err.join("\n");
    expect(stderr).toContain(`--after prev was still running`);
    expect(stderr).toContain(sessionId);
  });

  test("warns even when the --after session settles while launch confirms the turn", async () => {
    db.createSession({ id: "prev", parentId: "host", agentType: "codex", task: "first", ownerToken: "tok", projectPath: project });
    // The task is already submitted when the previous hand settles.
    spyOn(driver, "afterTaskSubmitted").mockImplementation(async () => { db.updateStatus("prev", "idle"); return true; });

    const captured: Captured = { out: [], err: [] };
    expect(await launchCli(captured, "--after", "prev")).toBe(0);
    expect(captured.err.join("\n")).toContain("--after prev was still running");
  });

  test("no still-running warning once the --after session has settled", async () => {
    db.createSession({ id: "prev", parentId: "host", agentType: "codex", task: "first", ownerToken: "tok", projectPath: project });
    db.updateStatus("prev", "idle");

    const captured: Captured = { out: [], err: [] };
    const code = await launchCli(captured, "--after", "prev");

    expect(code).toBe(0);
    expect(captured.err.join("\n")).not.toContain("still running");
  });

  test("the session ID is printed first and last of the launch JSON", async () => {
    db.createSession({ id: "writer", parentId: "host", agentType: "codex", task: "w", ownerToken: "tok", projectPath: project });

    const captured: Captured = { out: [], err: [] };
    const code = await launchCli(captured);

    expect(code).toBe(0);
    const stdout = captured.out[0].trimEnd();
    const lines = stdout.split("\n");
    const parsed = JSON.parse(stdout);
    expect(parsed.writerConflict).toBeDefined();
    expect(lines.at(-1)).toBe("}");
    expect(lines.at(-2)).toContain(`"tmuxSession": "${parsed.sessionId}"`);
    expect(parsed.tmuxSession).toBe(parsed.sessionId);
    expect(stdout.indexOf(`"sessionId"`)).toBeLessThan(stdout.indexOf(`"tmuxSession"`));
  });
});
