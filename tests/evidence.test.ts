import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { collectEvidence } from "../src/evidence";

const REPO = "/tmp/ahelpa-evidence-test-repo";

describe("evidence", () => {
  afterEach(() => rmSync(REPO, { recursive: true, force: true }));

  test("reports summary size, changed files, and which of them are tests", async () => {
    mkdirSync(`${REPO}/tests`, { recursive: true });
    mkdirSync(`${REPO}/.ahelpa/codex-ev1`, { recursive: true });
    await $`git -C ${REPO} init -q`.quiet();
    writeFileSync(`${REPO}/src.ts`, "export const x = 1;\n");
    writeFileSync(`${REPO}/tests/src.test.ts`, "// test\n");
    writeFileSync(`${REPO}/.ahelpa/codex-ev1/summary.md`, "# done\n");

    const evidence = await collectEvidence({ id: "codex-ev1", projectPath: REPO });

    expect(evidence.summaryBytes).toBe(7);
    expect(evidence.changedFiles).toContain("src.ts");
    expect(evidence.changedFiles).toContain("tests/src.test.ts");
    expect(evidence.testFilesChanged).toEqual(["tests/src.test.ts"]);
  });

  test("keeps paths with spaces unquoted and reports renames by their new path only", async () => {
    mkdirSync(`${REPO}/tests`, { recursive: true });
    await $`git -C ${REPO} init -q`.quiet();
    await $`git -C ${REPO} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();
    writeFileSync(`${REPO}/old.ts`, "a\n");
    await $`git -C ${REPO} add old.ts`.quiet();
    await $`git -C ${REPO} -c user.email=t@t -c user.name=t commit -q -m add`.quiet();
    await $`git -C ${REPO} mv old.ts "new name.ts"`.quiet();
    writeFileSync(`${REPO}/tests/space case.test.ts`, "// t\n");

    const evidence = await collectEvidence({ id: "codex-ev3", projectPath: REPO });

    expect(evidence.changedFiles).toEqual(["new name.ts", "tests/space case.test.ts"]);
    expect(evidence.testFilesChanged).toEqual(["tests/space case.test.ts"]);
  });

  test("a launch baseline keeps committed helper work visible alongside uncommitted changes", async () => {
    mkdirSync(REPO, { recursive: true });
    await $`git -C ${REPO} init -q`.quiet();
    await $`git -C ${REPO} -c user.email=t@t -c user.name=t commit -q --allow-empty -m base`.quiet();
    const base = (await $`git -C ${REPO} rev-parse HEAD`.text()).trim();
    writeFileSync(`${REPO}/committed.ts`, "x\n");
    await $`git -C ${REPO} add committed.ts`.quiet();
    await $`git -C ${REPO} -c user.email=t@t -c user.name=t commit -q -m work`.quiet();
    writeFileSync(`${REPO}/pending.ts`, "y\n");

    const evidence = await collectEvidence({ id: "codex-ev4", projectPath: REPO, baseCommit: base });

    expect(evidence.baseCommit).toBe(base);
    expect(evidence.changedFiles?.sort()).toEqual(["committed.ts", "pending.ts"]);
  });

  test("runs the acceptance command on the final state and logs its exit code", async () => {
    mkdirSync(`${REPO}/.ahelpa/codex-ev5`, { recursive: true });

    const evidence = await collectEvidence({ id: "codex-ev5", projectPath: REPO, checkCmd: "echo checked; echo oops >&2; exit 3" });

    expect(evidence.check).toMatchObject({ command: "echo checked; echo oops >&2; exit 3", exitCode: 3, timedOut: false, logPath: `${REPO}/.ahelpa/codex-ev5/check.log` });
    expect(evidence.check?.output).toContain("checked");
    expect(evidence.check?.output).toContain("oops");
    expect(readFileSync(`${REPO}/.ahelpa/codex-ev5/check.log`, "utf-8")).toEndWith("[exit 3]\n");
  });

  test("a timed-out check kills the whole process tree, reports timedOut, and returns promptly", async () => {
    mkdirSync(`${REPO}/.ahelpa/codex-ev6`, { recursive: true });
    const pidFile = `${REPO}/child.pid`;
    const started = Date.now();

    const evidence = await collectEvidence(
      { id: "codex-ev6", projectPath: REPO, checkCmd: `sleep 30 & echo $! > ${pidFile}; echo started; wait` },
      { checkTimeoutMs: 300 },
    );

    expect(Date.now() - started).toBeLessThan(3000);
    expect(evidence.check).toMatchObject({ timedOut: true });
    expect(evidence.check?.output).toContain("started");
    expect(readFileSync(`${REPO}/.ahelpa/codex-ev6/check.log`, "utf-8")).toMatch(/\[exit .*, timed out\]\n$/);
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    await Bun.sleep(100);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  test("a background process left by a normally exiting check does not outlive the check", async () => {
    mkdirSync(`${REPO}/.ahelpa/codex-ev10`, { recursive: true });
    const pidFile = `${REPO}/straggler.pid`;
    const started = Date.now();

    const evidence = await collectEvidence({ id: "codex-ev10", projectPath: REPO, checkCmd: `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 0` });

    expect(evidence.check).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(4000);
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    await Bun.sleep(100);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  test("a command that dies from its own signal is not reported as timed out", async () => {
    mkdirSync(`${REPO}/.ahelpa/codex-ev7`, { recursive: true });

    const evidence = await collectEvidence({ id: "codex-ev7", projectPath: REPO, checkCmd: "kill -TERM $$" });

    expect(evidence.check?.timedOut).toBe(false);
    expect(readFileSync(`${REPO}/.ahelpa/codex-ev7/check.log`, "utf-8")).not.toContain("timed out");
  });

  test("an exhausted budget skips the check instead of running it", async () => {
    mkdirSync(`${REPO}/.ahelpa/codex-ev8`, { recursive: true });

    const evidence = await collectEvidence({ id: "codex-ev8", projectPath: REPO, checkCmd: "sleep 5" }, { checkTimeoutMs: 0 });

    expect(evidence.check).toMatchObject({ command: "sleep 5", exitCode: null, timedOut: false, skipped: expect.stringContaining("re-wait") });
    expect(existsSync(`${REPO}/.ahelpa/codex-ev8/check.log`)).toBe(false);
  });

  test("a baseline that no longer resolves is flagged instead of silently narrowing the evidence", async () => {
    mkdirSync(REPO, { recursive: true });
    await $`git -C ${REPO} init -q`.quiet();
    await $`git -C ${REPO} -c user.email=t@t -c user.name=t commit -q --allow-empty -m base`.quiet();
    writeFileSync(`${REPO}/pending.ts`, "y\n");

    const evidence = await collectEvidence({ id: "codex-ev9", projectPath: REPO, baseCommit: "0123456789abcdef0123456789abcdef01234567" });

    expect(evidence.baseCommit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(evidence.baseCommitMissing).toBe(true);
    expect(evidence.changedFiles).toEqual(["pending.ts"]);
  });

  test("degrades to summary size outside a git repo", async () => {
    mkdirSync(REPO, { recursive: true });

    const evidence = await collectEvidence({ id: "codex-ev2", projectPath: REPO });

    expect(evidence).toEqual({ summaryBytes: 0 });
  });
});
