import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { $ } from "bun";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { getDriver } from "../src/drivers/registry";
import * as capabilities from "../src/drivers/codex-capabilities";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { planSessionHandoff } from "../src/file-handoff";
import { collectEvidence, computeTargetFingerprint } from "../src/evidence";
import { defaultWakeup } from "../src/wakeup";
import * as daemon from "../src/daemon";
import { COMPLETION_NUDGE, refreshSessionStatuses } from "../src/daemon";
import { inbox, mail } from "../src/commands/peer-mail";
import { sendTask } from "../src/commands/session-ops";
import { writeTurnHook } from "../src/turn-hooks";
import { shellEscape } from "../src/shell";

// A session in a linked git worktree keeps its results in the main checkout, so
// `git worktree remove` cannot take them. Every fixture lives under the real
// path of the system tmpdir: the main checkout is reported as a realpath.
const AGENTS = ["claude-code", "codex", "kimi"];
const HOOK_AGENTS = ["claude-code", "codex"];
const TASK_PREFIX = "Please read and complete the task described in fixture";
const READY = "Response complete\n\n› \n\n  GPT-6.1-Sol · ~/proj\n  ? for shortcuts";
const envKeys = ["AHELPA_PARENT_ID", "AHELPA_JOB_ID"] as const;

let root: string;
let main: string;
let db: StateDB;
let create: Mock<typeof Tmux.create>;
let savedEnv: (string | undefined)[];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const run = await $`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -C ${cwd} ${args}`.quiet().nothrow();
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  return run.text().trim();
}

// ignoreResults: a plain `git worktree remove` refuses a worktree that holds
// untracked files, and the compatibility link is one unless .ahelpa/ is ignored.
async function initRepo(ignoreResults = true): Promise<void> {
  mkdirSync(main);
  await git(main, "init", "-q");
  if (ignoreResults) writeFileSync(join(main, ".gitignore"), ".ahelpa/\n");
  writeFileSync(join(main, "README.md"), "fixture\n");
  await git(main, "add", "-A");
  await git(main, "commit", "-q", "-m", "init");
}

async function hostWorktree(name = "host-wt"): Promise<string> {
  const path = join(root, name);
  await git(main, "worktree", "add", "-q", "-b", name, path);
  return path;
}

// The hook directory as it sits inside Codex's shell-quoted notify command.
function notifyDir(dir: string): string {
  return `'\\''${dir}'\\''`;
}

function lstatOrNull(path: string) {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "linked-results-"));
  main = join(root, "main");
  db = new StateDB(join(root, "state.db"));
  savedEnv = envKeys.map(key => process.env[key]);
  for (const key of envKeys) delete process.env[key];
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  spyOn(defaultWakeup, "prepare").mockResolvedValue();
  spyOn(Tmux, "hasSession").mockResolvedValue(false);
  spyOn(Tmux, "capture").mockResolvedValue("");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(Tmux, "kill").mockResolvedValue();
  create = spyOn(Tmux, "create").mockResolvedValue();
  spyOn(capabilities, "getCodexCapabilities").mockReturnValue({ executable: "/bin/echo", noDaemon: true });
  for (const agent of AGENTS) {
    spyOn(getDriver(agent), "prepareForTask").mockResolvedValue();
    spyOn(getDriver(agent), "prepareForResume").mockResolvedValue();
    spyOn(getDriver(agent), "afterTaskSubmitted").mockResolvedValue(true);
  }
});

afterEach(() => {
  mock.restore();
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  for (const row of db.listSessions()) rmSync(planSessionHandoff(row).taskFilePath, { force: true });
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("--worktree keeps its results in the source repository", () => {
  test.each(AGENTS)("%s: summary.md and artifacts survive a plain `git worktree remove`", async agent => {
    await initRepo();
    const plan = planLaunch({ db, agentType: agent, task: "isolated", projectPath: main, parentId: "host", worktree: true });
    expect(plan.deliveryRoot).toBe(main);
    const result = await executeLaunch(plan);
    const id = result.sessionId;
    const worktree = plan.input.projectPath;
    const dir = join(main, ".ahelpa", id);
    expect(worktree).not.toBe(main);
    expect(existsSync(join(worktree, ".git"))).toBe(true);

    // The plan told the helper this path; the row remembers it.
    expect(plan.fileHandoff.sessionDeliveryDir).toBe(dir);
    expect(db.getSession(id)).toMatchObject({ projectPath: worktree, deliveryRoot: main });
    expect(readFileSync(join(dir, "task.md"), "utf8")).toContain(join(dir, "summary.md"));
    expect(existsSync(join(dir, "ask.md"))).toBe(true);
    // The usual path keeps working while the worktree lives.
    const link = join(worktree, ".ahelpa", id);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(dir);

    if (agent === "claude-code") {
      const settings = join(dir, "claude-settings.json");
      expect(create.mock.calls[0][1]).toContain(`--settings ${shellEscape(settings)}`);
      expect(readFileSync(settings, "utf8")).toContain(dir);
    }
    if (agent === "codex") expect(create.mock.calls[0][1]).toContain(notifyDir(dir));
    if (agent !== "kimi") {
      // The hook writer accepts the main checkout's session directory.
      writeTurnHook(dir, agent, JSON.stringify(agent === "codex"
        ? { type: "agent-turn-complete", "thread-id": "main", "turn-id": "one", "input-messages": [TASK_PREFIX] }
        : { hook_event_name: "UserPromptSubmit", session_id: "native", prompt_id: "p", prompt: TASK_PREFIX }));
      expect(readFileSync(join(dir, "turns.log"), "utf8")).toContain(agent);
    }

    writeFileSync(join(dir, "summary.md"), "done\n");
    writeFileSync(join(dir, "artifacts", "out.txt"), "evidence");
    expect(readFileSync(join(link, "summary.md"), "utf8")).toBe("done\n");

    // Without --force: the worktree holds only ignored files and the link.
    const removed = await $`git -C ${main} worktree remove ${worktree}`.quiet().nothrow();
    expect(removed.stderr.toString()).toBe("");
    expect(removed.exitCode).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toBe("done\n");
    expect(readFileSync(join(dir, "artifacts", "out.txt"), "utf8")).toBe("evidence");

    // Readers find them from the row alone, long after the worktree is gone.
    const row = db.getSession(id)!;
    expect((await collectEvidence(row)).summaryBytes).toBe("done\n".length);
    const next = planLaunch({ db, agentType: "codex", task: "next", projectPath: main, parentId: "host", after: id });
    expect(next.handoffContext.previous).toMatchObject({
      summaryPath: join(dir, "summary.md"),
      taskCopyPath: join(dir, "task.md"),
      artifactsDir: join(dir, "artifacts"),
      askPath: join(dir, "ask.md"),
    });
    const followUp = join(root, "follow-up.md");
    writeFileSync(followUp, "second ask");
    await sendTask(db, id, result.ownerToken, followUp);
    expect(readFileSync(join(dir, "task.md"), "utf8")).toContain("second ask");
  });

  test("a failed launch removes the worktree and its results, and leaves other sessions' alone", async () => {
    await initRepo();
    const other = join(main, ".ahelpa", "other-session");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "summary.md"), "keep");
    const plan = planLaunch({ db, agentType: "codex", task: "isolated", projectPath: main, parentId: "host", worktree: true });
    spyOn(getDriver("codex"), "prepareForTask").mockRejectedValue(new Error("boom"));
    await expect(executeLaunch(plan)).rejects.toThrow("boom");
    expect(existsSync(plan.input.projectPath)).toBe(false);
    expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
    expect(await git(main, "branch", "--list", `ahelpa/${plan.sessionId}`)).toBe("");
    expect(db.getSession(plan.sessionId)).toBeNull();
    expect(readFileSync(join(other, "summary.md"), "utf8")).toBe("keep");
  });

  test("safe mode grants the result directory outside the worktree", async () => {
    await initRepo();
    for (const agent of HOOK_AGENTS) {
      const plan = planLaunch({ db, agentType: agent, task: "isolated", projectPath: main, parentId: "host", worktree: true, safe: true });
      expect(plan.launchCmd).toContain(`--add-dir ${shellEscape(join(main, ".ahelpa", plan.sessionId))}`);
    }
  });
});

describe("--project on a worktree the host made", () => {
  test.each(HOOK_AGENTS)("%s: results go to the main checkout and survive `git worktree remove`", async agent => {
    await initRepo();
    const worktree = await hostWorktree();
    const plan = planLaunch({ db, agentType: agent, task: "work", projectPath: worktree, parentId: "host" });
    expect(plan.input.projectPath).toBe(worktree);
    expect(plan.worktreeSource).toBeUndefined();
    const { sessionId: id } = await executeLaunch(plan);
    const dir = join(main, ".ahelpa", id);
    expect(db.getSession(id)?.deliveryRoot).toBe(main);
    expect(readlinkSync(join(worktree, ".ahelpa", id))).toBe(dir);
    writeFileSync(join(dir, "summary.md"), "done\n");
    writeFileSync(join(dir, "artifacts", "out.txt"), "evidence");

    const removed = await $`git -C ${main} worktree remove ${worktree}`.quiet().nothrow();
    expect(removed.stderr.toString()).toBe("");
    expect(removed.exitCode).toBe(0);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toBe("done\n");
    expect(readFileSync(join(dir, "artifacts", "out.txt"), "utf8")).toBe("evidence");
    expect(planSessionHandoff(db.getSession(id)!).summaryPath).toBe(join(dir, "summary.md"));
  });

  test("a project that is the main checkout keeps its results in the project", async () => {
    await initRepo();
    const plan = planLaunch({ db, agentType: "codex", task: "work", projectPath: main, parentId: "host" });
    expect(plan.deliveryRoot).toBeUndefined();
    const { sessionId: id } = await executeLaunch(plan);
    expect(db.getSession(id)?.deliveryRoot).toBeNull();
    expect(plan.fileHandoff.sessionDeliveryDir).toBe(join(main, ".ahelpa", id));
    expect(lstatOrNull(join(main, ".ahelpa", id))?.isDirectory()).toBe(true);
  });

  test("a failed launch removes the link and the directory, but not the worktree or other results", async () => {
    await initRepo();
    const worktree = await hostWorktree();
    const other = join(main, ".ahelpa", "other-session");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "summary.md"), "keep");
    const plan = planLaunch({ db, agentType: "codex", task: "work", projectPath: worktree, parentId: "host" });
    spyOn(getDriver("codex"), "prepareForTask").mockRejectedValue(new Error("boom"));
    await expect(executeLaunch(plan)).rejects.toThrow("boom");
    // existsSync follows a dangling link and would say false; look at the link itself.
    expect(lstatOrNull(join(worktree, ".ahelpa", plan.sessionId))).toBeNull();
    expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
    expect(existsSync(worktree)).toBe(true);
    expect(db.getSession(plan.sessionId)).toBeNull();
    expect(readFileSync(join(other, "summary.md"), "utf8")).toBe("keep");
  });

  test("a reviewer's fingerprint ignores the link even when the repository does not ignore .ahelpa", async () => {
    await initRepo(false);
    const worktree = await hostWorktree();
    const plan = planLaunch({ db, agentType: "codex", task: "review", projectPath: worktree, parentId: "host", role: "reviewer" });
    const { sessionId: id } = await executeLaunch(plan);
    const dir = join(main, ".ahelpa", id);
    const link = join(worktree, ".ahelpa", id);
    const row = db.getSession(id)!;
    expect(row.targetResultDirs).toEqual([dir, link]);
    expect(row.targetFingerprint?.treeHash).toBeString();
    // What `wait` recomputes equals what the launch recorded...
    expect(await computeTargetFingerprint(worktree, row.targetResultDirs!)).toEqual(row.targetFingerprint!);
    // ...and only because the link is excluded: it is an untracked file there.
    expect(await computeTargetFingerprint(worktree, [dir])).not.toEqual(row.targetFingerprint!);
    expect((await collectEvidence(row)).targetChanged).toBe(false);
  });
});

describe("resume in a linked worktree", () => {
  function oldSession(agent: string, worktree: string, extra: { deliveryRoot?: string; safe?: boolean } = {}) {
    db.createSession({ id: "old", parentId: "host", agentType: agent, task: "first", ownerToken: "tok", projectPath: worktree, ...extra });
    db.updateStatus("old", "dead");
    db.updateResumeId("old", "native-thread");
  }

  test.each(HOOK_AGENTS)("%s: a relocated source resumes into the main checkout and keeps its ask", async agent => {
    await initRepo();
    const worktree = await hostWorktree();
    oldSession(agent, worktree, { deliveryRoot: main, safe: true });
    mkdirSync(join(main, ".ahelpa", "old"), { recursive: true });
    writeFileSync(join(main, ".ahelpa", "old", "ask.md"), "ORIGINAL ASK");

    const { sessionId: id } = await resume({ db, sessionId: "old", ownerToken: "tok" });
    const dir = join(main, ".ahelpa", id);
    const command = create.mock.calls[0][1];
    expect(db.getSession(id)).toMatchObject({ projectPath: worktree, deliveryRoot: main, safe: true });
    expect(readFileSync(join(dir, "ask.md"), "utf8")).toBe("ORIGINAL ASK");
    expect(readlinkSync(join(worktree, ".ahelpa", id))).toBe(dir);
    if (agent === "claude-code") {
      expect(command).toContain(`--settings ${shellEscape(join(dir, "claude-settings.json"))}`);
      expect(existsSync(join(dir, "claude-settings.json"))).toBe(true);
      expect(command).toEndWith(` --add-dir ${shellEscape(dir)}`);
    } else {
      expect(command).toContain(notifyDir(dir));
      expect(command).toContain(`-s workspace-write -a never --add-dir ${shellEscape(dir)}`);
    }

    const removed = await $`git -C ${main} worktree remove ${worktree}`.quiet().nothrow();
    expect(removed.exitCode).toBe(0);
    expect(readFileSync(join(dir, "ask.md"), "utf8")).toBe("ORIGINAL ASK");
  });

  test("a session launched before this change keeps its directory in the worktree; the resumed one does not", async () => {
    await initRepo();
    const worktree = await hostWorktree();
    oldSession("codex", worktree);
    const legacy = join(worktree, ".ahelpa", "old");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "ask.md"), "LEGACY ASK");

    const { sessionId: id } = await resume({ db, sessionId: "old", ownerToken: "tok" });
    expect(readFileSync(join(main, ".ahelpa", id, "ask.md"), "utf8")).toBe("LEGACY ASK");
    expect(db.getSession(id)?.deliveryRoot).toBe(main);
    expect(db.getSession("old")?.deliveryRoot).toBeNull();
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "ask.md"), "utf8")).toBe("LEGACY ASK");
  });

  test.each(HOOK_AGENTS)("%s: a failed resume removes the link and the directory", async agent => {
    await initRepo();
    const worktree = await hostWorktree();
    oldSession(agent, worktree, { deliveryRoot: main });
    spyOn(getDriver(agent), "prepareForResume").mockRejectedValue(new Error("boom"));
    await expect(resume({ db, sessionId: "old", ownerToken: "tok" })).rejects.toThrow("boom");
    const id = create.mock.calls[0][0];
    expect(lstatOrNull(join(worktree, ".ahelpa", id))).toBeNull();
    expect(existsSync(join(main, ".ahelpa", id))).toBe(false);
    expect(db.listSessions().map(row => row.id)).toEqual(["old"]);
  });

  test("a resumed reviewer excludes the source's directory and its own, link included", async () => {
    await initRepo(false);
    const worktree = await hostWorktree();
    const plan = planLaunch({ db, agentType: "codex", task: "review", projectPath: worktree, parentId: "host", role: "reviewer" });
    const first = await executeLaunch(plan);
    db.updateStatus(first.sessionId, "dead");
    db.updateResumeId(first.sessionId, "native-thread");
    const { sessionId: id } = await resume({ db, sessionId: first.sessionId, ownerToken: first.ownerToken });
    expect(db.getSession(id)?.targetResultDirs).toEqual([
      join(main, ".ahelpa", first.sessionId), join(worktree, ".ahelpa", first.sessionId),
      join(main, ".ahelpa", id), join(worktree, ".ahelpa", id),
    ]);
  });
});

describe("where an existing session's results are", () => {
  test("the row decides: a worktree's leftovers neither move a relocated session nor hide a legacy one", async () => {
    await initRepo();
    const worktree = await hostWorktree();
    // Legacy: a row without a root, a real directory in the worktree.
    mkdirSync(join(worktree, ".ahelpa", "legacy"), { recursive: true });
    expect(planSessionHandoff({ projectPath: worktree, id: "legacy", deliveryRoot: null }).sessionDeliveryDir)
      .toBe(join(worktree, ".ahelpa", "legacy"));
    // A row without a root is in the project even when nothing is there yet.
    expect(planSessionHandoff({ projectPath: worktree, id: "fresh" }).sessionDeliveryDir).toBe(join(worktree, ".ahelpa", "fresh"));
    // Relocated: `git clean -fdx` removed the link and a helper recreated the path.
    mkdirSync(join(worktree, ".ahelpa", "moved"), { recursive: true });
    const moved = { projectPath: worktree, id: "moved", deliveryRoot: main };
    expect(planSessionHandoff(moved).sessionDeliveryDir).toBe(join(main, ".ahelpa", "moved"));
    // The worktree is gone altogether.
    await git(main, "worktree", "remove", "--force", worktree);
    expect(planSessionHandoff(moved).sessionDeliveryDir).toBe(join(main, ".ahelpa", "moved"));
    expect(planSessionHandoff(moved).compatLink).toBe(join(worktree, ".ahelpa", "moved"));
    expect(planSessionHandoff({ projectPath: worktree, id: "plain" }).compatLink).toBeNull();
  });

  test("the daemon finds the summary and turn events of a session whose worktree is gone", async () => {
    await initRepo();
    const id = "codex-gone";
    const row = db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: join(root, "removed-worktree"), deliveryRoot: main });
    db.beginTurn(id, row.version, TASK_PREFIX);
    const dir = join(main, ".ahelpa", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "written result");
    writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "one", "input-messages": [TASK_PREFIX] }));
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(READY);
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
  });
});

describe("peer mail between helpers in linked worktrees", () => {
  function helper(id: string, worktree: string, deliveryRoot?: string) {
    return db.createSession({ id, parentId: "host", agentType: "codex", task: "t", ownerToken: "tok", projectPath: worktree, role: "worker", jobId: "job", deliveryRoot });
  }

  test("mail, inbox and read use the main checkout's .ahelpa", async () => {
    await initRepo();
    helper("a", await hostWorktree("wt-a"), main);
    const wb = await hostWorktree("wt-b");
    helper("b", wb, main);
    process.env.AHELPA_PARENT_ID = "a";
    const [sent] = mail(db, "b", false, "hello\n");
    expect(sent.path).toBe(join(main, ".ahelpa", "b", "inbox", "1-from-a.md"));
    expect(JSON.parse(readFileSync(join(main, ".ahelpa", "jobs", "job", "mail.jsonl"), "utf8"))).toMatchObject({ from: "a", to: "b", seq: 1 });
    expect(existsSync(join(wb, ".ahelpa"))).toBe(false);
    process.env.AHELPA_PARENT_ID = "b";
    expect(inbox(db)).toHaveLength(1);
    expect(inbox(db, 1)).toBe("> hello");
  });

  test("a recipient launched before this change still receives into its own worktree", async () => {
    await initRepo();
    helper("a", await hostWorktree("wt-a"), main);
    const wb = await hostWorktree("wt-b");
    helper("b", wb);
    process.env.AHELPA_PARENT_ID = "a";
    const [sent] = mail(db, "b", false, "hello\n");
    expect(sent.path).toBe(join(wb, ".ahelpa", "b", "inbox", "1-from-a.md"));
    expect(existsSync(join(main, ".ahelpa", "jobs", "job", "mail.jsonl"))).toBe(true);
    process.env.AHELPA_PARENT_ID = "b";
    expect(inbox(db, 1)).toBe("> hello");
  });

  test("a symlinked .ahelpa in the main checkout is still refused", async () => {
    await initRepo();
    helper("a", await hostWorktree("wt-a"), main);
    helper("b", await hostWorktree("wt-b"), main);
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(main, ".ahelpa"));
    process.env.AHELPA_PARENT_ID = "a";
    expect(() => mail(db, "b", false, "hello\n")).toThrow(/must not contain a symlink/);
    expect(existsSync(join(root, "elsewhere", "jobs"))).toBe(false);
  });
});
