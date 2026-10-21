import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { getDriver } from "../src/drivers/registry";
import * as capabilities from "../src/drivers/codex-capabilities";
import * as daemon from "../src/daemon";
import { runCli } from "../src/command-contract";
import { resume } from "../src/commands/launch";
import { planSessionHandoff } from "../src/file-handoff";
import { defaultWakeup } from "../src/wakeup";

// What the launch and resume results say about a Codex "Folder access" prompt the driver answered.
const folder = readFileSync(new URL("./fixtures/codex/folder-access-120.txt", import.meta.url), "utf8").trimEnd();
const prompt = "› Implement {feature}";
const driver = getDriver("codex");

let root: string;
let project: string;
let db: StateDB;

async function launchJson(...flags: string[]) {
  const out: string[] = [];
  const code = await runCli(db, ["launch", "codex", "--task", "Review it", "--project", project, ...flags],
    { print: (text) => out.push(text), printError: (text) => out.push(text) });
  expect(code).toBe(0);
  return JSON.parse(out[0]);
}

async function launchFailure(...flags: string[]): Promise<string> {
  const out: string[] = [];
  const code = await runCli(db, ["launch", "codex", "--task", "Review it", "--project", project, ...flags],
    { print: (text) => out.push(text), printError: (text) => out.push(text) });
  expect(code).toBe(1);
  return out.join("\n");
}

// The real driver sees the Folder access screen until Enter is sent, then `after`.
function folderScreenThen(after: string) {
  spyOn(Bun, "sleep").mockResolvedValue();
  let shown = folder;
  spyOn(Tmux, "capture").mockImplementation(async () => shown);
  spyOn(Tmux, "sendKey").mockImplementation(async () => { shown = after; });
}

function oldCodexSession() {
  db.createSession({ id: "old", parentId: "host", agentType: "codex", task: "first", ownerToken: "tok", projectPath: project });
  db.updateStatus("old", "dead");
  db.updateResumeId("old", "native-thread");
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "codex-folder-trust-"));
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
});

afterEach(() => {
  mock.restore();
  for (const row of db.listSessions()) rmSync(planSessionHandoff(row).taskFilePath, { force: true });
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("codexTrust in the launch and resume results", () => {
  test.each([["default", []], ["--safe", ["--safe"]]])("launch reports the root the driver trusted in %s mode", async (_mode, flags) => {
    spyOn(driver, "prepareForTask").mockResolvedValue({ codexTrust: "<repo root>" });
    expect((await launchJson(...flags)).codexTrust).toBe("<repo root>");
  });

  test("launch has no codexTrust when nothing was answered", async () => {
    spyOn(driver, "prepareForTask").mockResolvedValue();
    expect(await launchJson()).not.toHaveProperty("codexTrust");
    spyOn(driver, "prepareForTask").mockResolvedValue({});
    expect(await launchJson()).not.toHaveProperty("codexTrust");
  });

  test("launch through the real driver answers the screen once and says so", async () => {
    spyOn(Bun, "sleep").mockResolvedValue();
    let shown = folder;
    spyOn(Tmux, "capture").mockImplementation(async () => shown);
    spyOn(Tmux, "sendKey").mockImplementation(async () => { shown = prompt; });
    const result = await launchJson();
    expect(result.codexTrust).toBe("<repo root>");
    expect(Tmux.sendKey).toHaveBeenCalledTimes(1);
    expect(Tmux.sendKey).toHaveBeenCalledWith(result.sessionId, "Enter");
  });

  test("resume reports it the same way", async () => {
    oldCodexSession();
    spyOn(driver, "prepareForResume").mockResolvedValue({ codexTrust: "<repo root>" });
    expect((await resume({ db, sessionId: "old", ownerToken: "tok" })).codexTrust).toBe("<repo root>");
    spyOn(driver, "prepareForResume").mockResolvedValue();
    expect(await resume({ db, sessionId: "old", ownerToken: "tok" })).not.toHaveProperty("codexTrust");
  });

  // Codex has saved the trust once Enter is pressed. A failure at any later step rolls the session back, so the error is
  // the only place left to say so.
  const note = "Folder access was accepted for <repo root>, which Codex keeps trusted";

  test.each([
    ["the wakeup cannot be prepared", () => spyOn(defaultWakeup, "prepare").mockRejectedValue(new Error("wakeup boom"))],
    ["the launch was cancelled", () => spyOn(db, "completeLaunch").mockReturnValue(false)],
  ] as const)("launch says the trust stays saved when %s after the screen was answered", async (_failure, inject) => {
    folderScreenThen(prompt);
    inject();
    const message = await launchFailure();
    expect(message).toContain(`; ${note}`);
    expect(message.split("Folder access was accepted").length).toBe(2);
    expect(Tmux.sendKey).toHaveBeenCalledTimes(1);
    expect(Tmux.kill).toHaveBeenCalledTimes(1);
    expect(db.listSessions()).toHaveLength(0);
  });

  test("launch names the trust once when the prompt is never reached after the screen was answered", async () => {
    folderScreenThen("OpenAI Codex");
    const message = await launchFailure();
    expect(message).toContain("did not reach its input prompt");
    expect(message.split("Folder access was accepted").length).toBe(2);
  });

  test("launch does not mention the trust when no screen was answered", async () => {
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue(prompt);
    spyOn(defaultWakeup, "prepare").mockRejectedValue(new Error("wakeup boom"));
    const message = await launchFailure();
    expect(message).toContain("wakeup boom");
    expect(message).not.toContain("Folder access");
    expect(Tmux.sendKey).not.toHaveBeenCalled();
  });

  test("resume says the trust stays saved when a later step fails after the screen was answered", async () => {
    oldCodexSession();
    folderScreenThen(prompt);
    spyOn(defaultWakeup, "prepare").mockRejectedValue(new Error("wakeup boom"));
    const failure: Error = await resume({ db, sessionId: "old", ownerToken: "tok" }).then(() => { throw new Error("resume succeeded"); }, (error) => error);
    expect(failure.message).toContain(`wakeup boom; ${note}`);
    expect(Tmux.sendKey).toHaveBeenCalledTimes(1);
    expect(Tmux.kill).toHaveBeenCalledTimes(1);
    expect(db.listSessions().map((row) => row.id)).toEqual(["old"]);
  });

  test("resume does not mention the trust when no screen was answered", async () => {
    oldCodexSession();
    spyOn(Bun, "sleep").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue(prompt);
    spyOn(defaultWakeup, "prepare").mockRejectedValue(new Error("wakeup boom"));
    const failure: Error = await resume({ db, sessionId: "old", ownerToken: "tok" }).then(() => { throw new Error("resume succeeded"); }, (error) => error);
    expect(failure.message).toContain("wakeup boom");
    expect(failure.message).not.toContain("Folder access");
  });
});
