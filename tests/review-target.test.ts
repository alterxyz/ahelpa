import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { sendTask } from "../src/commands/session-ops";
import { wait } from "../src/commands/wait";
import * as evidence from "../src/evidence";
import { buildTaskFileContent, planFileHandoff, prepareFileHandoff } from "../src/file-handoff";
import { COMMAND_CONTRACTS } from "../src/command-contract";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";

const { collectEvidence, computeTargetFingerprint } = evidence;

describe("review target and blind handoff", () => {
  let root: string;
  let project: string;
  let db: StateDB;
  let gitCeiling: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(import.meta.dir, "../.ahelpa/review-target-test-"));
    project = join(root, "repo");
    mkdirSync(project);
    // These fixtures live inside the source checkout. Stop discovery at their
    // root so an uninitialized fixture really is outside Git.
    gitCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    db = new StateDB(join(root, "state.db"));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
  });

  afterEach(() => {
    mock.restore();
    db.close();
    if (gitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = gitCeiling;
    rmSync(root, { recursive: true, force: true });
  });

  async function initRepo() {
    await $`git -C ${project} init -q`.quiet();
    writeFileSync(join(project, "code.ts"), "export const n = 1;\n");
    await $`git -C ${project} add code.ts`.quiet();
    await $`git -C ${project} -c user.email=t@t -c user.name=t commit -q -m base`.quiet();
    return (await $`git -C ${project} rev-parse HEAD`.text()).trim();
  }

  async function launchHand(role: "worker" | "reviewer" | "advisor" = "reviewer", after?: string, unblind?: boolean) {
    const plan = planLaunch({ db, agentType: role === "advisor" ? "claude-code" : "codex", task: "inspect the code", projectPath: project, parentId: "host", role, after, unblind });
    spyOn(plan.driver, "prepareForTask").mockResolvedValue();
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
    await executeLaunch(plan);
    db.updateStatus(plan.sessionId, "idle");
    return plan;
  }

  test("launch binds HEAD and tree hash, wait detects an edit, and own results do not count", async () => {
    const head = await initRepo();
    const plan = await launchHand();
    const session = db.getSession(plan.sessionId)!;
    expect(session.targetFingerprint?.head).toBe(head);
    expect(session.targetFingerprint?.treeHash).toMatch(/^[a-f0-9]{64}$/);
    const content = readFileSync(plan.fileHandoff.taskCopyPath, "utf8");
    expect(content).toContain(`Review target: HEAD \`${head}\``);
    expect(content).toContain(session.targetFingerprint!.treeHash!);
    expect(content).toContain("State the HEAD and fingerprint you reviewed.");
    writeFileSync(plan.fileHandoff.summaryPath, "ship\n");
    writeFileSync(join(plan.fileHandoff.artifactsDir, "proof.txt"), "rerun\n");
    writeFileSync(join(plan.fileHandoff.sessionDeliveryDir, "check.log"), "exit 0\n");
    const unchanged = await wait(db, [plan.sessionId], false, 5000);
    expect(unchanged).toMatchObject({ evidence: { targetChanged: false, targetFingerprint: session.targetFingerprint, currentFingerprint: session.targetFingerprint } });
    writeFileSync(join(project, "code.ts"), "export const n = 2;\n");
    const changed = await wait(db, [plan.sessionId], false, 5000);
    expect(changed).toMatchObject({ evidence: { targetChanged: true, targetFingerprint: session.targetFingerprint } });
    expect(Array.isArray(changed)).toBe(false);
    if (!Array.isArray(changed)) expect(changed.evidence?.currentFingerprint?.treeHash).not.toBe(session.targetFingerprint!.treeHash);
  });

  test("non-git reviewer and plain worker omit target evidence", async () => {
    const reviewer = await launchHand();
    expect(db.getSession(reviewer.sessionId)?.targetFingerprint).toBeNull();
    expect(await wait(db, [reviewer.sessionId], false, 5000)).toMatchObject({ evidence: { summaryBytes: 0 } });
    expect((await collectEvidence(db.getSession(reviewer.sessionId)!)).targetChanged).toBeUndefined();
    await initRepo();
    const worker = await launchHand("worker");
    expect(db.getSession(worker.sessionId)?.targetFingerprint).toBeNull();
    expect((await collectEvidence(db.getSession(worker.sessionId)!)).targetChanged).toBeUndefined();
  });

  test("staged content, HEAD, and untracked names count; untracked content alone does not", async () => {
    await initRepo();
    writeFileSync(join(project, "code.ts"), "export const n = 2;\n");
    await $`git -C ${project} add code.ts`.quiet();
    const staged = await computeTargetFingerprint(project);
    writeFileSync(join(project, "code.ts"), "export const n = 3;\n");
    await $`git -C ${project} add code.ts`.quiet();
    expect(await computeTargetFingerprint(project)).not.toEqual(staged);
    await $`git -C ${project} -c user.email=t@t -c user.name=t commit -q -m staged`.quiet();
    const committed = await computeTargetFingerprint(project);
    await $`git -C ${project} -c user.email=t@t -c user.name=t commit -q --allow-empty -m next`.quiet();
    expect((await computeTargetFingerprint(project))?.head).not.toBe(committed?.head);
    expect((await computeTargetFingerprint(project))?.treeHash).toBe(committed?.treeHash);
    writeFileSync(join(project, "space\nfile.txt"), "one");
    const named = await computeTargetFingerprint(project);
    expect(named?.treeHash).not.toBe(committed?.treeHash);
    writeFileSync(join(project, "space\nfile.txt"), "two");
    expect(await computeTargetFingerprint(project)).toEqual(named);
  });

  test("exclude only own directory, including tracked output and a subdirectory project", async () => {
    await initRepo();
    const ownDir = join(project, "sub", ".ahelpa", "review[1]");
    mkdirSync(ownDir, { recursive: true });
    writeFileSync(join(ownDir, "summary.md"), "before");
    await $`git -C ${project} add .`.quiet();
    await $`git -C ${project} -c user.email=t@t -c user.name=t commit -q -m output`.quiet();
    const fingerprint = await computeTargetFingerprint(join(project, "sub"), [ownDir]);
    writeFileSync(join(ownDir, "summary.md"), "after");
    await $`git -C ${project} add .`.quiet();
    expect(await computeTargetFingerprint(join(project, "sub"), [ownDir])).toEqual(fingerprint);
    mkdirSync(join(project, "sub", ".ahelpa", "other"));
    writeFileSync(join(project, "sub", ".ahelpa", "other", "summary.md"), "changed");
    expect(await computeTargetFingerprint(join(project, "sub"), [ownDir])).not.toEqual(fingerprint);
  });

  test("a symlink project excludes its own newly created result directory", async () => {
    await initRepo();
    const alias = join(root, "alias");
    symlinkSync(project, alias, "dir");
    project = alias;
    const plan = await launchHand();
    writeFileSync(plan.fileHandoff.summaryPath, "reviewed through alias");
    expect(await wait(db, [plan.sessionId], false, 5000)).toMatchObject({ evidence: { targetChanged: false } });
    writeFileSync(join(project, "code.ts"), "changed\n");
    expect(await wait(db, [plan.sessionId], false, 5000)).toMatchObject({ evidence: { targetChanged: true } });
  });

  test.each([false, true])("reviewer after is blind unless unblind=%s", async (unblind) => {
    const baseCommit = await initRepo();
    db.createSession({ id: "impl", parentId: "host", agentType: "codex", task: "implement", projectPath: project, ownerToken: "tok", baseCommit });
    prepareFileHandoff(planFileHandoff(project, "impl"), "implement the feature");
    writeFileSync(join(project, "code.ts"), "export const n = 2;\n");
    mkdirSync(join(project, "tests"));
    writeFileSync(join(project, "tests/code.test.ts"), "// author's test\n");
    await $`git -C ${project} add code.ts tests/code.test.ts`.quiet();
    await $`git -C ${project} -c user.email=t@t -c user.name=t commit -q -m implementation`.quiet();
    const launchHead = (await $`git -C ${project} rev-parse HEAD`.text()).trim();
    const plan = await launchHand("reviewer", "impl", unblind);
    expect(db.getSession(plan.sessionId)?.baseCommit).toBe(launchHead);
    expect(db.getSession(plan.sessionId)?.targetFingerprint?.head).not.toBe(baseCommit);
    const ownEvidence = await collectEvidence(db.getSession(plan.sessionId)!);
    expect(ownEvidence.changedFiles).not.toContain("code.ts");
    expect(ownEvidence.testFilesChanged).not.toContain("tests/code.test.ts");
    const content = readFileSync(plan.fileHandoff.taskCopyPath, "utf8");
    const section = content.split("## ahelpa previous hand")[1].split("\n\n---")[0];
    expect(section).toContain(`${project}/.ahelpa/impl/${unblind ? "task" : "ask"}.md`);
    expect(section.includes(`${project}/.ahelpa/impl/summary.md`)).toBe(unblind);
    expect(section.includes(`${project}/.ahelpa/impl/artifacts`)).toBe(unblind);
    expect(section).toContain(baseCommit);
    expect(section).toContain(db.getSession(plan.sessionId)!.targetFingerprint!.treeHash!);
  });

  test("task builder withholds previous claims even without launch orchestration", () => {
    const handoff = planFileHandoff(project, "reviewer");
    const previous = planFileHandoff(project, "author");
    const content = buildTaskFileContent(handoff, "review the code", {
      role: "reviewer",
      targetFingerprint: { head: "head-sha", treeHash: "tree-hash" },
      previous: { sessionId: "author", taskCopyPath: previous.taskCopyPath, summaryPath: previous.summaryPath, artifactsDir: previous.artifactsDir, baseCommit: "base-sha" },
    });
    expect(content).toContain("Original ask unavailable");
    expect(content).not.toContain(previous.taskCopyPath);
    expect(content).not.toContain(previous.summaryPath);
    expect(content).not.toContain(previous.artifactsDir);
    expect(content).toContain("base-sha");
    expect(content).toContain("head-sha");
    expect(content).toContain("tree-hash");
  });

  test("reviewer with a legacy previous hand uses current HEAD as its diff base", async () => {
    const head = await initRepo();
    db.createSession({ id: "legacy", parentId: "host", agentType: "codex", task: "implement", projectPath: project, ownerToken: "tok" });
    const plan = await launchHand("reviewer", "legacy");
    expect(db.getSession(plan.sessionId)?.baseCommit).toBe(head);
    expect(readFileSync(plan.fileHandoff.taskCopyPath, "utf8")).toContain(`- Diff base commit: ${head}`);
  });

  test.each(["worker", "advisor"] as const)("%s after keeps author notes without review-target tracking", async (role) => {
    await initRepo();
    db.createSession({ id: "review", parentId: "host", agentType: "codex", task: "review", projectPath: project, ownerToken: "tok" });
    const plan = await launchHand(role, "review");
    const content = readFileSync(plan.fileHandoff.taskCopyPath, "utf8");
    expect(content).toContain(`${project}/.ahelpa/review/summary.md`);
    expect(content).toContain(`${project}/.ahelpa/review/artifacts`);
    expect(content).toContain(`${project}/.ahelpa/review/task.md`);
    expect(content).not.toContain("Review target:");
    const session = db.getSession(plan.sessionId)!;
    expect(session.afterId).toBe("review");
    expect(session.targetFingerprint).toBeNull();
    expect(session.targetResultDirs).toBeNull();
    writeFileSync(join(project, "code.ts"), "rework\n");
    expect((await collectEvidence(session)).targetChanged).toBeUndefined();
  });

  test("blind reviewer links only original asks across rework and task follow-ups", async () => {
    await initRepo();
    const prior = await launchHand("worker");
    writeFileSync(prior.fileHandoff.summaryPath, "CLAIM: all tests pass");
    const author = await launchHand("worker", prior.sessionId);
    writeFileSync(author.fileHandoff.summaryPath, "CLAIM: feature is correct");
    const followup = join(root, "follow-up.md");
    writeFileSync(followup, "also implement the edge case\n");
    await sendTask(db, author.sessionId, author.ownerToken, followup);
    const audit = readFileSync(author.fileHandoff.taskCopyPath, "utf8");
    expect(audit).toContain(prior.fileHandoff.summaryPath);
    expect(audit).toContain(author.fileHandoff.summaryPath);
    const reviewer = await launchHand("reviewer", author.sessionId);
    const section = readFileSync(reviewer.fileHandoff.taskCopyPath, "utf8").split("## ahelpa previous hand")[1].split("\n\n---")[0];
    const links = [...section.matchAll(/^- Its ask: (.+)$/gm)].map((match) => match[1]);
    expect(links).toEqual([join(author.fileHandoff.sessionDeliveryDir, "ask.md")]);
    expect(section).not.toContain(author.fileHandoff.taskCopyPath);
    for (const link of links) {
      const ask = readFileSync(link, "utf8");
      expect(ask).toBe("inspect the code\n\n===== follow-up task =====\n\nalso implement the edge case\n");
      for (const hand of [prior, author]) {
        expect(ask).not.toContain(hand.fileHandoff.summaryPath);
        expect(ask).not.toContain(hand.fileHandoff.artifactsDir);
      }
      expect(ask).not.toContain("CLAIM:");
      expect(ask).not.toContain("## ahelpa");
    }
  });

  test("non-reviewer legacy fingerprints are ignored by evidence and dropped on resume", async () => {
    await initRepo();
    const original = await launchHand("worker");
    const fingerprint = await computeTargetFingerprint(project);
    db.createSession({ ...db.getSession(original.sessionId)!, id: "old-worker", ownerToken: "tok", resumedFrom: undefined, targetFingerprint: fingerprint, targetResultDirs: [original.fileHandoff.sessionDeliveryDir] });
    const legacy = db.getSession("old-worker")!;
    expect((await collectEvidence(legacy)).targetChanged).toBeUndefined();
    expect((await collectEvidence({ ...legacy, role: "advisor" })).targetChanged).toBeUndefined();
    expect((await collectEvidence({ ...legacy, role: null })).targetChanged).toBeUndefined();
    db.updateStatus(legacy.id, "dead");
    db.updateResumeId(legacy.id, "native-token");
    spyOn(original.driver, "prepareForResume").mockResolvedValue();
    const resumed = await resume({ db, sessionId: legacy.id, ownerToken: "tok" });
    const record = db.getSession(resumed.sessionId)!;
    expect(record.targetFingerprint).toBeNull();
    expect(record.targetResultDirs).toBeNull();
  });

  test("legacy previous hand without ask explicitly reports unavailable without linking task", async () => {
    await initRepo();
    db.createSession({ id: "legacy", parentId: "host", agentType: "codex", task: "old ask", projectPath: project, ownerToken: "tok" });
    const handoff = planFileHandoff(project, "legacy");
    mkdirSync(handoff.sessionDeliveryDir, { recursive: true });
    writeFileSync(handoff.taskCopyPath, `old ask\nResult: ${handoff.summaryPath}`);
    const reviewer = await launchHand("reviewer", "legacy");
    const content = readFileSync(reviewer.fileHandoff.taskCopyPath, "utf8");
    expect(content).toContain("Original ask unavailable");
    expect(content).not.toContain(handoff.taskCopyPath);
    expect(content).not.toContain(handoff.summaryPath);
  });

  test("already dirty nested submodules include tracked edits, staged edits and untracked names", async () => {
    await initRepo();
    const child = join(root, "child");
    mkdirSync(child);
    await $`git -C ${child} init -q`.quiet();
    writeFileSync(join(child, "tracked.ts"), "base\n");
    await $`git -C ${child} add .`.quiet();
    await $`git -C ${child} -c user.email=t@t -c user.name=t commit -qm base`.quiet();
    const middle = join(root, "middle");
    mkdirSync(middle);
    await $`git -C ${middle} init -q`.quiet();
    await $`git -C ${middle} -c protocol.file.allow=always submodule add -q ${child} inner`.quiet();
    await $`git -C ${middle} -c user.email=t@t -c user.name=t commit -qam middle`.quiet();
    await $`git -C ${project} -c protocol.file.allow=always submodule add -q ${middle} vendor`.quiet();
    await $`git -C ${project} -c user.email=t@t -c user.name=t commit -qam submodule`.quiet();
    await $`git -C ${project} -c protocol.file.allow=always submodule update --init --recursive`.quiet();
    const nested = join(project, "vendor", "inner");
    writeFileSync(join(nested, "tracked.ts"), "first dirty version\n");
    const reviewer = await launchHand();
    expect((await collectEvidence(db.getSession(reviewer.sessionId)!)).targetChanged).toBe(false);
    writeFileSync(join(nested, "tracked.ts"), "second dirty version\n");
    expect((await collectEvidence(db.getSession(reviewer.sessionId)!)).targetChanged).toBe(true);
    await $`git -C ${nested} add tracked.ts`.quiet();
    const staged = await computeTargetFingerprint(project);
    // Restore the worktree bytes after changing the index: staged content must
    // still participate even though the superproject only reports dirty.
    writeFileSync(join(nested, "tracked.ts"), "third version\n");
    await $`git -C ${nested} add tracked.ts`.quiet();
    writeFileSync(join(nested, "tracked.ts"), "second dirty version\n");
    expect(await computeTargetFingerprint(project)).not.toEqual(staged);
    const beforeName = await computeTargetFingerprint(project);
    writeFileSync(join(nested, "untracked.txt"), "one");
    const named = await computeTargetFingerprint(project);
    expect(named).not.toEqual(beforeName);
    writeFileSync(join(nested, "untracked.txt"), "two");
    expect(await computeTargetFingerprint(project)).toEqual(named);
  });

  test("wait fingerprints after the acceptance command and ignores its own check log", async () => {
    await initRepo();
    const plan = planLaunch({ db, agentType: "codex", task: "review", projectPath: project, parentId: "host", role: "reviewer", check: "echo checked" });
    spyOn(plan.driver, "prepareForTask").mockResolvedValue();
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
    await executeLaunch(plan);
    db.updateStatus(plan.sessionId, "idle");
    expect(await wait(db, [plan.sessionId], false, 5000)).toMatchObject({ evidence: { targetChanged: false, check: { exitCode: 0 } } });
    const session = db.getSession(plan.sessionId)!;
    expect(await collectEvidence({ ...session, checkCmd: "echo edit >> code.ts" })).toMatchObject({ targetChanged: true });
  });

  test.each([undefined, "worker", "advisor"] as const)("unblind rejects role %s before side effects", (role) => {
    expect(() => planLaunch({ db, agentType: "claude-code", task: "work", projectPath: project, parentId: "host", role, unblind: true })).toThrow("--unblind requires --role reviewer");
    expect(Tmux.create).not.toHaveBeenCalled();
    expect(db.listSessions()).toEqual([]);
  });

  test("command contract exposes unblind as a boolean and passes it to launch", async () => {
    const command = COMMAND_CONTRACTS.find((c) => c.name === "launch")!;
    expect(command.flags?.unblind).toEqual({ kind: "boolean" });
    expect(command.usage).toContain("[--unblind]");
    await expect(command.run({ db, positionals: ["codex"], flags: { strings: { task: "work", project }, booleans: { unblind: true }, numbers: {} }, print: () => {} })).rejects.toThrow("--unblind requires --role reviewer");
  });

  test("nullable migration preserves old rows and new fields survive reopen and resume", async () => {
    await initRepo();
    const plan = await launchHand("reviewer", undefined, true);
    const original = db.getSession(plan.sessionId)!;
    db.close();
    const legacy = new Database(join(root, "state.db"));
    for (const column of ["target_fingerprint", "target_result_dirs", "unblind"]) legacy.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
    legacy.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.getSession(plan.sessionId)?.targetFingerprint).toBeNull();
    db.createSession({ ...original, id: "saved", ownerToken: "tok", resumedFrom: undefined });
    db.updateStatus("saved", "dead");
    db.updateResumeId("saved", "native-token");
    db.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.getSession("saved")?.targetFingerprint).toEqual(original.targetFingerprint);
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(plan.driver, "prepareForResume").mockResolvedValue();
    const resumed = await resume({ db, sessionId: "saved", ownerToken: "tok" });
    const record = db.getSession(resumed.sessionId)!;
    expect(record.targetFingerprint).toEqual(original.targetFingerprint);
    expect(record.unblind).toBe(true);
    expect(record.targetResultDirs).toEqual([...original.targetResultDirs!, planFileHandoff(project, record.id).sessionDeliveryDir]);
    const handoff = planFileHandoff(project, record.id);
    mkdirSync(handoff.artifactsDir, { recursive: true });
    writeFileSync(handoff.summaryPath, "resumed result");
    expect((await collectEvidence(record)).targetChanged).toBe(false);
    expect(buildTaskFileContent(handoff, "follow up", { role: record.role, targetFingerprint: record.targetFingerprint })).toContain(original.targetFingerprint!.treeHash!);
    const ask = join(root, "follow-up.md");
    writeFileSync(ask, "review again");
    spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
    await sendTask(db, record.id, resumed.ownerToken, ask);
    expect(readFileSync(handoff.taskCopyPath, "utf8")).toContain(original.targetFingerprint!.treeHash!);
    expect((await collectEvidence(db.getSession(record.id)!)).targetChanged).toBe(false);
  });
});
