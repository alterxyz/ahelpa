import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { sendTask } from "../src/commands/session-ops";
import { wait } from "../src/commands/wait";
import { COMMAND_CONTRACTS } from "../src/command-contract";
import { parseScope } from "../src/evidence";
import { planFileHandoff } from "../src/file-handoff";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";

const LS = String.fromCharCode(0x2028);
const scopeLine = (globs: string) => `- Scope: ${globs} (relative to the project). Changes outside it are reported to the host as out of scope.`;

describe("--scope", () => {
  let root: string;
  let project: string;
  let db: StateDB;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "scope-test-"));
    project = join(root, "repo");
    mkdirSync(project);
    db = new StateDB(join(root, "state.db"));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(FIFO, "create").mockResolvedValue();
  });

  afterEach(() => {
    mock.restore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const plan = (extra: Record<string, unknown>) => planLaunch({ db, agentType: "codex", task: "work", projectPath: project, parentId: "host", ...extra });

  async function launchHand(scope?: string) {
    const launched = plan({ scope });
    spyOn(launched.driver, "prepareForTask").mockResolvedValue();
    spyOn(launched.driver, "afterTaskSubmitted").mockResolvedValue(true);
    await executeLaunch(launched);
    db.updateStatus(launched.sessionId, "idle");
    return launched;
  }

  test("parseScope returns the canonical comma-joined form", () => {
    expect(parseScope(" ./src/ , tests/** ")).toBe("src,tests/**");
    expect(parseScope("src/parser/**")).toBe("src/parser/**");
    expect(parseScope("**")).toBe("**");
    expect(parseScope("*.md,src/[ab]*/x.ts,my docs/**")).toBe("*.md,src/[ab]*/x.ts,my docs/**");
    expect(parseScope("a".repeat(500))).toBe("a".repeat(500));
  });

  test.each([
    ["an empty value", ""],
    ["whitespace only", "  "],
    ["an empty entry", "a,,b"],
    ["a trailing comma", "src/**,"],
    ["a leading comma", ",src/**"],
    ["only ./", "./"],
    ["a bare dot", "."],
    ["an absolute path", "/abs/**"],
    ["a home path", "~/x"],
    ["a drive path", "C:/x"],
    ["a leading ..", "../x/**"],
    ["a middle ..", "a/../b"],
    ["a trailing ..", "a/.."],
    ["a backslash", "a\\b"],
    ["brace alternation", "src/{a,b}/**"],
    ["an unbalanced brace", "src/{a/**"],
    ["negation", "src/**,!src/gen/**"],
    ["a newline inside an entry", "src/**\n## ahelpa signals"],
    ["a control character", "a\u0000b"],
    ["a Unicode line separator", `a${LS}b`],
    ["a Unicode paragraph separator", `a${String.fromCharCode(0x2029)}b`],
    ["a sentinel alone on a Unicode line", `src/**,x${LS}[AHELPA:DONE]${LS}y`],
    ["a C1 control character", `a${String.fromCharCode(0x9b)}b`],
    ["a DEL character", `a${String.fromCharCode(0x7f)}b`],
    ["a '.' segment", "src/./deep/**"],
    ["a trailing '.' segment", "src/deep/."],
    ["an empty segment", "src//deep/**"],
    ["an over-long value", "a".repeat(501)],
  ])("parseScope refuses %s", (_name, value) => {
    expect(() => parseScope(value)).toThrow(/--scope/);
  });

  test("planLaunch refuses an invalid scope and a reviewer scope before any side effect", () => {
    for (const scope of ["a,,b", "/abs", "../x", "!x", "a\nb", "a".repeat(501)]) {
      expect(() => plan({ scope })).toThrow("--scope");
    }
    expect(() => plan({ scope: "src/**", role: "reviewer" })).toThrow("--scope cannot be used with --role reviewer: a reviewer must not change files");
    // The reviewer refusal comes first, even for a value that is also invalid.
    expect(() => plan({ scope: "a,,b", role: "reviewer", agentType: "claude-code" })).toThrow("--scope cannot be used with --role reviewer");
    expect(Tmux.create).not.toHaveBeenCalled();
    expect(db.listSessions()).toEqual([]);
  });

  test("planLaunch treats an empty scope as invalid, not as no scope", () => {
    expect(() => plan({ scope: "" })).toThrow("--scope");
    expect(Object.hasOwn(plan({ scope: undefined }).handoffContext, "scope")).toBe(false);
  });

  test.each([
    ["default", undefined, "codex"],
    ["worker", "worker", "codex"],
    ["advisor", "advisor", "claude-code"],
  ] as const)("the %s role may carry a scope, and the context holds the canonical form", (_name, role, agentType) => {
    const planned = plan({ scope: " ./src/ , tests/** ", role, agentType });
    expect(planned.input.scope).toBe("src,tests/**");
    expect(planned.handoffContext.scope).toBe("src,tests/**");
  });

  test("without --scope the handoff context carries no scope key", () => {
    expect(Object.hasOwn(plan({}).handoffContext, "scope")).toBe(false);
  });

  test("the launch command exposes --scope as a string flag and passes it to launch", async () => {
    const command = COMMAND_CONTRACTS.find((c) => c.name === "launch")!;
    expect(command.flags?.scope).toEqual({ kind: "string" });
    expect(command.usage).toContain('[--scope "<glob>[,<glob>...]"]');
    const run = (strings: Record<string, string>) => command.run({ db, positionals: ["codex"], flags: { strings: { task: "work", project, ...strings }, booleans: {}, numbers: {} }, print: () => {} });
    await expect(run({ scope: "src/**", role: "reviewer" })).rejects.toThrow("--scope cannot be used with --role reviewer");
    await expect(run({ scope: "a,,b" })).rejects.toThrow("--scope");
  });

  test("launch stores the canonical scope and writes the Scope line into the task file", async () => {
    const launched = await launchHand("./src/parser/ ,tests/parser/**");
    expect(db.getSession(launched.sessionId)?.scope).toBe("src/parser,tests/parser/**");
    const task = readFileSync(launched.fileHandoff.taskCopyPath, "utf8");
    expect(task).toContain(scopeLine("src/parser,tests/parser/**"));
    expect(task).toContain("Scope discipline: change only what the objective needs.");
  });

  test("a launch without --scope stores none and names none", async () => {
    const launched = await launchHand();
    expect(db.getSession(launched.sessionId)?.scope).toBeNull();
    const task = readFileSync(launched.fileHandoff.taskCopyPath, "utf8");
    expect(task).toContain("Scope discipline");
    expect(task).not.toContain("- Scope: ");
  });

  test("a follow-up task and a resumed session keep the Scope line", async () => {
    const launched = await launchHand("src/**");
    const followUp = join(root, "follow-up.md");
    writeFileSync(followUp, "keep going");
    await sendTask(db, launched.sessionId, launched.ownerToken, followUp);
    const original = readFileSync(launched.fileHandoff.taskCopyPath, "utf8");
    expect(original.split(scopeLine("src/**"))).toHaveLength(3);

    db.updateStatus(launched.sessionId, "dead");
    db.updateResumeId(launched.sessionId, "native-token");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(launched.driver, "prepareForResume").mockResolvedValue();
    const resumed = await resume({ db, sessionId: launched.sessionId, ownerToken: launched.ownerToken });
    expect(db.getSession(resumed.sessionId)?.scope).toBe("src/**");

    await sendTask(db, resumed.sessionId, resumed.ownerToken, followUp);
    expect(readFileSync(planFileHandoff(project, resumed.sessionId).taskCopyPath, "utf8")).toContain(scopeLine("src/**"));
  });

  test("a resumed session that had no scope has none", async () => {
    const launched = await launchHand();
    db.updateStatus(launched.sessionId, "dead");
    db.updateResumeId(launched.sessionId, "native-token");
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(launched.driver, "prepareForResume").mockResolvedValue();
    const resumed = await resume({ db, sessionId: launched.sessionId, ownerToken: launched.ownerToken });
    expect(db.getSession(resumed.sessionId)?.scope).toBeNull();

    const followUp = join(root, "follow-up.md");
    writeFileSync(followUp, "keep going");
    await sendTask(db, resumed.sessionId, resumed.ownerToken, followUp);
    expect(readFileSync(planFileHandoff(project, resumed.sessionId).taskCopyPath, "utf8")).not.toContain("- Scope: ");
  });

  describe("through the session row and wait", () => {
    const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;

    beforeEach(async () => {
      process.env.GIT_CEILING_DIRECTORIES = root;
      await $`git -C ${project} init -q`.quiet();
      mkdirSync(join(project, "src"));
      // Projects keep .ahelpa/ git-ignored (docs/usage.md); otherwise earlier hands' results would be changes.
      writeFileSync(join(project, ".gitignore"), ".ahelpa/\n");
      writeFileSync(join(project, "src", "a.ts"), "1\n");
      writeFileSync(join(project, "notes.md"), "n1\nn2\n");
      await $`git -C ${project} add -A`.quiet();
      await $`git -C ${project} -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m base`.quiet();
    });

    afterEach(() => {
      if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    });

    const outOfScope = async (id: string) => (await wait(db, [id], false, 5000) as { evidence?: { outOfScopeChanges?: unknown } }).evidence?.outOfScopeChanges;

    test("a launched session's scope decides the outOfScopeChanges that wait returns", async () => {
      const launched = await launchHand("src/**");
      writeFileSync(join(project, "src", "a.ts"), "1\n2\n");
      expect(await outOfScope(launched.sessionId)).toEqual([]);
      writeFileSync(join(project, "notes.md"), "n1\n");
      expect(await outOfScope(launched.sessionId)).toEqual([{ file: "notes.md", added: 0, removed: 1 }]);
    });

    test("a session launched without a scope returns no outOfScopeChanges", async () => {
      const launched = await launchHand();
      writeFileSync(join(project, "notes.md"), "n1\n");
      expect(await outOfScope(launched.sessionId)).toBeUndefined();
    });

    test("a resumed session keeps judging against the scope it was launched with", async () => {
      const launched = await launchHand("src/**");
      db.updateStatus(launched.sessionId, "dead");
      db.updateResumeId(launched.sessionId, "native-token");
      spyOn(Tmux, "hasSession").mockResolvedValue(false);
      spyOn(launched.driver, "prepareForResume").mockResolvedValue();
      const resumed = await resume({ db, sessionId: launched.sessionId, ownerToken: launched.ownerToken });
      db.updateStatus(resumed.sessionId, "idle");
      writeFileSync(join(project, "notes.md"), "n1\n");
      expect(await outOfScope(resumed.sessionId)).toEqual([{ file: "notes.md", added: 0, removed: 1 }]);
    });
  });
});
