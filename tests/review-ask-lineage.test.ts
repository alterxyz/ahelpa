import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { sendTask } from "../src/commands/session-ops";
import { planFileHandoff } from "../src/file-handoff";
import { getDriver } from "../src/drivers/registry";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";

const UNAVAILABLE = "Original ask unavailable: the original ask predates ask.md and is unavailable to blind review.";

describe("blind review ask lineage", () => {
  let root: string;
  let project: string;
  let db: StateDB;
  let gitCeiling: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(import.meta.dir, "../.ahelpa/ask-lineage-test-"));
    project = join(root, "repo");
    mkdirSync(project);
    gitCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    db = new StateDB(join(root, "state.db"));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(FIFO, "create").mockResolvedValue();
    const driver = getDriver("codex");
    spyOn(driver, "prepareForTask").mockResolvedValue();
    spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
    spyOn(driver, "prepareForResume").mockResolvedValue();
  });

  afterEach(() => {
    mock.restore();
    db.close();
    if (gitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = gitCeiling;
    rmSync(root, { recursive: true, force: true });
  });

  async function launchHand(task: string, role: "worker" | "reviewer" = "worker", after?: string) {
    const plan = planLaunch({ db, agentType: "codex", task, projectPath: project, parentId: "host", role, after });
    await executeLaunch(plan);
    db.updateStatus(plan.sessionId, "idle");
    return plan;
  }

  async function followUp(sessionId: string, token: string, text: string) {
    const file = join(root, "follow-up.md");
    writeFileSync(file, text);
    await sendTask(db, sessionId, token, file);
  }

  async function resumeHand(sessionId: string, ownerToken: string) {
    db.updateStatus(sessionId, "dead");
    db.updateResumeId(sessionId, "native-conversation");
    return resume({ db, sessionId, ownerToken });
  }

  async function reviewerAsk(sessionId: string, unavailable: boolean) {
    const reviewer = await launchHand("Review independently against the requirements", "reviewer", sessionId);
    const source = planFileHandoff(project, sessionId);
    const section = readFileSync(reviewer.fileHandoff.taskCopyPath, "utf8").split("## ahelpa previous hand")[1].split("\n\n---")[0];
    expect(section).toContain(`- Its ask: ${source.askPath}`);
    expect(section.includes(UNAVAILABLE)).toBe(unavailable);
    for (const path of [source.taskCopyPath, source.summaryPath, source.artifactsDir]) expect(section).not.toContain(path);
    return readFileSync(source.askPath, "utf8");
  }

  test("legacy follow-up marks the unavailable original ask in both file and blind review", async () => {
    db.createSession({ id: "legacy", parentId: "host", agentType: "codex", task: "ORIGINAL requirements", projectPath: project, ownerToken: "tok" });
    const source = planFileHandoff(project, "legacy");
    mkdirSync(source.sessionDeliveryDir, { recursive: true });
    writeFileSync(source.taskCopyPath, `ORIGINAL requirements\nResult: ${source.summaryPath}`);
    await followUp("legacy", "tok", "fix one edge case");
    const ask = await reviewerAsk("legacy", true);
    expect(ask).toBe(`${UNAVAILABLE}\n\n===== follow-up task =====\n\nfix one edge case`);
    expect(ask).not.toContain(source.summaryPath);
    expect(readFileSync(source.taskCopyPath, "utf8")).toContain("ORIGINAL requirements");
  });

  test("two resumes preserve the full original and follow-up asks for each blind review", async () => {
    const original = "  ORIGINAL requirements: cover all edge cases\r\n";
    const author = await launchHand(original);
    await followUp(author.sessionId, author.ownerToken, "first follow-up");
    const originalAsk = `${original}\n\n===== follow-up task =====\n\nfirst follow-up`;
    expect(await reviewerAsk(author.sessionId, false)).toBe(originalAsk);
    const first = await resumeHand(author.sessionId, author.ownerToken);
    expect(await reviewerAsk(first.sessionId, false)).toBe(originalAsk);
    await followUp(first.sessionId, first.ownerToken, "second follow-up");
    const continuedAsk = `${originalAsk}\n\n===== follow-up task =====\n\nsecond follow-up`;
    expect(await reviewerAsk(first.sessionId, false)).toBe(continuedAsk);
    const second = await resumeHand(first.sessionId, first.ownerToken);
    expect(await reviewerAsk(second.sessionId, false)).toBe(continuedAsk);
    await followUp(second.sessionId, second.ownerToken, "third follow-up");
    expect(await reviewerAsk(second.sessionId, false)).toBe(`${continuedAsk}\n\n===== follow-up task =====\n\nthird follow-up`);
    expect(readFileSync(author.fileHandoff.askPath, "utf8")).toBe(originalAsk);
  });

  test("legacy resume propagates the unavailable marker through two resumes and follow-ups", async () => {
    db.createSession({ id: "legacy-resume", parentId: "host", agentType: "codex", task: "old native conversation", projectPath: project, ownerToken: "tok" });
    const first = await resumeHand("legacy-resume", "tok");
    expect(await reviewerAsk(first.sessionId, true)).toBe(`${UNAVAILABLE}\n`);
    await followUp(first.sessionId, first.ownerToken, "only known follow-up");
    const ask = `${UNAVAILABLE}\n\n\n===== follow-up task =====\n\nonly known follow-up`;
    expect(await reviewerAsk(first.sessionId, true)).toBe(ask);
    const second = await resumeHand(first.sessionId, first.ownerToken);
    expect(await reviewerAsk(second.sessionId, true)).toBe(ask);
  });
});
