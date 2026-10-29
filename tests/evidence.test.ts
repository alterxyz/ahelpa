import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { collectEvidence, parseScope, type OutOfScopeChange } from "../src/evidence";

let REPO: string;
let scratch: string;

describe("evidence", () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-evidence-"));
    REPO = join(scratch, "repo");
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  test("counts what a helper left under artifacts/, directories included", async () => {
    mkdirSync(`${REPO}/.ahelpa/codex-art/artifacts/mutation-copy/src`, { recursive: true });
    writeFileSync(`${REPO}/.ahelpa/codex-art/artifacts/mutation-copy/src/a.ts`, "x");
    writeFileSync(`${REPO}/.ahelpa/codex-art/artifacts/report.md`, "r");

    const evidence = await collectEvidence({ id: "codex-art", projectPath: REPO });

    expect(evidence.artifactsEntries).toBe(4);
  });

  test("reports summary size, changed files, and which of them are tests", async () => {
    mkdirSync(`${REPO}/tests`, { recursive: true });
    mkdirSync(`${REPO}/.ahelpa/codex-ev1`, { recursive: true });
    await $`git -C ${REPO} init -q`.quiet();
    writeFileSync(`${REPO}/src.ts`, "export const x = 1;\n");
    writeFileSync(`${REPO}/tests/src.test.ts`, "// test\n");
    writeFileSync(`${REPO}/.ahelpa/codex-ev1/summary.md`, "# done\n");

    const evidence = await collectEvidence({ id: "codex-ev1", projectPath: REPO });

    expect(evidence.summaryBytes).toBe(7);
    expect(evidence.artifactsEntries).toBeUndefined();
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

describe("evidence outOfScopeChanges", () => {
  let root: string;
  let repo: string;
  let gitCeiling: string | undefined;
  let originalPath: string | undefined;
  let base: string;
  const realGit = Bun.which("git")!;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

  beforeEach(async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "evidence-scope-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    originalPath = process.env.PATH;
    // Stop git discovery at the fixture root so a non-repo directory is really outside Git.
    gitCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    await $`git -C ${repo} init -q`.quiet();
    // A developer's global config decides whether git pairs renames; pin it.
    await $`git -C ${repo} config diff.renames true`.quiet();
    await $`git -C ${repo} config status.renames true`.quiet();
    write("src/parser/a.ts", "1\n2\n3\n");
    write("src/other/o.ts", "1\n2\n3\n");
    write("src/other/bin.dat", Buffer.from([1, 0, 2]));
    write("docs/readme.md", "d1\nd2\nd3\nd4\n");
    write("docs/pure.md", "p1\np2\np3\n");
    write(".env", "A=1\n");
    base = await commit("base");
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (gitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = gitCeiling;
    rmSync(root, { recursive: true, force: true });
  });

  // A git in front of the real one, to hold back or watch a single call.
  function shim(body: string) {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const path = join(bin, "git");
    writeFileSync(path, `#!/bin/sh\n${body}\nexec ${quote(realGit)} "$@"\n`);
    chmodSync(path, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
  }

  function write(file: string, content: string | Buffer, dir = repo) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }

  async function commit(message: string, dir = repo) {
    await $`git -C ${dir} add -A`.quiet();
    await $`git -C ${dir} -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m ${message}`.quiet();
    return (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  }

  // changedFiles lists tracked changes before untracked ones; compare by path.
  const sorted = (changes?: OutOfScopeChange[]) => changes && [...changes].sort((a, b) => (a.file < b.file ? -1 : 1));
  const outOfScope = async (scope: string | null | undefined, since = base) =>
    sorted((await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: since, scope })).outOfScopeChanges);

  test("an edit inside the scope gives an empty list, and a change outside it is listed with net line counts", async () => {
    write("src/parser/a.ts", "1\nchanged\n3\n");
    expect(await outOfScope("src/parser/**")).toEqual([]);

    write("src/other/o.ts", "1\nX\n");
    expect(await outOfScope("src/parser/**")).toEqual([{ file: "src/other/o.ts", added: 1, removed: 2 }]);
    // Staging changes nothing about the net result.
    await $`git -C ${repo} add src/other/o.ts`.quiet();
    expect(await outOfScope("src/parser/**")).toEqual([{ file: "src/other/o.ts", added: 1, removed: 2 }]);
  });

  test("the field is absent without a scope, not an empty array", async () => {
    write("src/other/o.ts", "changed\n");
    for (const scope of [undefined, null]) {
      const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: base, scope });
      expect(evidence.changedFiles).toContain("src/other/o.ts");
      expect(Object.hasOwn(evidence, "outOfScopeChanges")).toBe(false);
    }
  });

  test("outside git the field is absent as well", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await collectEvidence({ id: "codex-sc", projectPath: plain, scope: "src/**" })).toEqual({ summaryBytes: 0 });
  });

  test("an untracked file counts its lines as added, with or without a final newline", async () => {
    write("src/other/no-newline.txt", "n1\nn2\nn3");
    write("src/other/newline.txt", "a\nb\n");
    write("src/other/empty.txt", "");
    expect(await outOfScope("src/parser/**")).toEqual([
      { file: "src/other/empty.txt", added: 0, removed: 0 },
      { file: "src/other/newline.txt", added: 2, removed: 0 },
      { file: "src/other/no-newline.txt", added: 3, removed: 0 },
    ]);
  });

  test("work committed since the baseline counts together with later edits, and a reverted file counts zero", async () => {
    write("src/other/c.ts", "c1\nc2\n");
    write("src/other/o.ts", "1\n2\n3\nextra\n");
    await commit("helper work");
    write("src/other/c.ts", "c1\nc2\nc3\n");
    write("src/other/o.ts", "1\n2\n3\n");
    expect(await outOfScope("src/parser/**")).toEqual([
      { file: "src/other/c.ts", added: 3, removed: 0 },
      { file: "src/other/o.ts", added: 0, removed: 0 },
    ]);
  });

  test("a binary file, tracked or untracked, has null counts; so do an oversized file, a symlink and files past the read cap", async () => {
    write("src/other/bin.dat", Buffer.from([1, 0, 3]));
    write("src/other/new.bin", Buffer.from([0, 1, 2]));
    write("src/other/big.txt", "a\n".repeat(500_001));
    symlinkSync("o.ts", join(repo, "src/other/link"));
    expect(await outOfScope("src/parser/**")).toEqual([
      { file: "src/other/big.txt", added: null, removed: null },
      { file: "src/other/bin.dat", added: null, removed: null },
      { file: "src/other/link", added: null, removed: null },
      { file: "src/other/new.bin", added: null, removed: null },
    ]);
    rmSync(join(repo, "src/other"), { recursive: true });
    for (let i = 0; i < 201; i++) write(`bulk/${String(i).padStart(3, "0")}.txt`, "x\n");
    const bulk = (await outOfScope("src/parser/**"))!.filter((change) => change.file.startsWith("bulk/"));
    expect(bulk).toHaveLength(201);
    expect(bulk.filter((change) => change.added === 1)).toHaveLength(200);
    expect(bulk[200]).toEqual({ file: "bulk/200.txt", added: null, removed: null });
  });

  test("a staged rename lists its new path and its old path as a deletion, so a move out of an out-of-scope place shows", async () => {
    await $`git -C ${repo} mv docs/pure.md docs/pure2.md`.quiet();
    await $`git -C ${repo} mv docs/readme.md docs/guide.md`.quiet();
    write("docs/guide.md", "d1\nd2\nd3\nd4\nd5\n");
    await $`git -C ${repo} mv src/other/o.ts src/parser/o.ts`.quiet();
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: base, scope: "src/parser/**" });
    // changedFiles still names a rename by its new path only.
    expect(evidence.changedFiles).toContain("docs/pure2.md");
    expect(evidence.changedFiles).not.toContain("docs/pure.md");
    expect(sorted(evidence.outOfScopeChanges)).toEqual([
      { file: "docs/guide.md", added: 5, removed: 0 },
      { file: "docs/pure.md", added: 0, removed: 3 },
      { file: "docs/pure2.md", added: 3, removed: 0 },
      { file: "docs/readme.md", added: 0, removed: 4 },
      { file: "src/other/o.ts", added: 0, removed: 3 },
    ]);
  });

  test("a move committed since the baseline lists the old path as well", async () => {
    await $`git -C ${repo} mv src/other/o.ts lib-o.ts`.quiet();
    await commit("move out");
    expect(await outOfScope("src/parser/**")).toEqual([
      { file: "lib-o.ts", added: 3, removed: 0 },
      { file: "src/other/o.ts", added: 0, removed: 3 },
    ]);
  });

  test("a move staged on the new side only counts both paths instead of pairing them as a rename", async () => {
    write("other/old.txt", Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""));
    const long = await commit("long file");
    write("other/new.txt", readFileSync(join(repo, "other/old.txt")));
    rmSync(join(repo, "other/old.txt"));
    await $`git -C ${repo} add other/new.txt`.quiet();
    expect(await outOfScope("src/parser/**", long)).toEqual([
      { file: "other/new.txt", added: 40, removed: 0 },
      { file: "other/old.txt", added: 0, removed: 40 },
    ]);
  });

  test("a glob-free entry covers what lies beneath it but not a sibling with the same prefix", async () => {
    write("src/parser/a.ts", "1\n");
    write("src/parser/deep/b.ts", "b\n");
    write("src/parser2/x.ts", "x\n");
    for (const scope of ["src/parser", parseScope("./src/parser/")]) {
      expect(await outOfScope(scope)).toEqual([{ file: "src/parser2/x.ts", added: 1, removed: 0 }]);
    }
  });

  test("an entry with a wildcard matches exactly as Bun.Glob does and does not recurse", async () => {
    write("src/top.ts", "t\n");
    write("src/deep/er/x.ts", "x\n");
    write("lib/y.ts", "y\n");
    write("notes.md/secret.ts", "s\n");
    write("top.md", "m\n");
    const listed = async (scope: string) => (await outOfScope(scope))!.map((change) => change.file);
    expect(await listed("src/*")).toEqual(["lib/y.ts", "notes.md/secret.ts", "src/deep/er/x.ts", "top.md"]);
    expect(await listed("*.md")).toEqual(["lib/y.ts", "notes.md/secret.ts", "src/deep/er/x.ts", "src/top.ts"]);
    expect(await listed("src/**")).toEqual(["lib/y.ts", "notes.md/secret.ts", "top.md"]);
    expect(await listed("src/t?p.ts,*.md,lib")).toEqual(["notes.md/secret.ts", "src/deep/er/x.ts"]);
  });

  test("? stands in for the brackets of a literal [dir]", async () => {
    write("app/[locale]/page.tsx", "p\n");
    expect(await outOfScope("app/?locale?/**")).toEqual([]);
    expect(await outOfScope("app/[locale]/**")).toHaveLength(1);
  });

  test("** covers dotfiles and nested paths, and several globs add up", async () => {
    write(".env", "A=2\n");
    write("a/b/c/d.ts", "d\n");
    write("docs/readme.md", "changed\n");
    expect(await outOfScope("**")).toEqual([]);
    expect(await outOfScope("docs/*.md,a/**,.env")).toEqual([]);
    expect((await outOfScope("docs/*.md,a/**"))!.map((change) => change.file)).toEqual([".env"]);
    expect((await outOfScope("*.md"))!.map((change) => change.file)).toEqual([".env", "a/b/c/d.ts", "docs/readme.md"]);
  });

  test("only this session's own .ahelpa results are not helper work", async () => {
    write(".ahelpa/other/ask.md", "ask\nmore\n");
    const others = await commit("another hand");
    write(".ahelpa/codex-sc/summary.md", "# done\n");
    write(".ahelpa/codex-sc/task.md", "task\n");
    expect(await outOfScope("src/parser/**", others)).toEqual([]);

    write(".ahelpa/other/ask.md", "ask\nmore\nedited\n");
    write(".ahelpa/other-hand/summary.md", "x\ny\n");
    write(".ahelpa-notes/n.md", "n\n");
    write("docs/.ahelpa/x.md", "x\n");
    expect(await outOfScope("src/parser/**", others)).toEqual([
      { file: ".ahelpa-notes/n.md", added: 1, removed: 0 },
      { file: ".ahelpa/other-hand/summary.md", added: 2, removed: 0 },
      { file: ".ahelpa/other/ask.md", added: 1, removed: 0 },
      { file: "docs/.ahelpa/x.md", added: 1, removed: 0 },
    ]);
  });

  test("the link a worktree session keeps at .ahelpa/<id> is its own result as well", async () => {
    const deliveryRoot = join(root, "main");
    mkdirSync(join(deliveryRoot, ".ahelpa", "codex-sc"), { recursive: true });
    mkdirSync(join(repo, ".ahelpa"));
    symlinkSync(join(deliveryRoot, ".ahelpa", "codex-sc"), join(repo, ".ahelpa", "codex-sc"));
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, deliveryRoot, baseCommit: base, scope: "src/parser/**" });
    expect(evidence.changedFiles).toEqual([".ahelpa/codex-sc"]);
    expect(evidence.outOfScopeChanges).toEqual([]);
  });

  test("a baseline that no longer resolves falls back to HEAD for the counts", async () => {
    write("src/other/o.ts", "1\n");
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: "0123456789abcdef0123456789abcdef01234567", scope: "src/parser/**" });
    expect(evidence.baseCommitMissing).toBe(true);
    expect(evidence.outOfScopeChanges).toEqual([{ file: "src/other/o.ts", added: 0, removed: 2 }]);
  });

  test("a repository without commits lists staged files with null counts instead of failing", async () => {
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    await $`git -C ${fresh} init -q`.quiet();
    write("staged.ts", "s\n", fresh);
    write("loose.ts", "l\nm\n", fresh);
    await $`git -C ${fresh} add staged.ts`.quiet();
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: fresh, scope: "src/**" });
    expect(sorted(evidence.outOfScopeChanges)).toEqual([
      { file: "loose.ts", added: 2, removed: 0 },
      { file: "staged.ts", added: null, removed: null },
    ]);
  });

  test.each([
    ["by default", false],
    ["whatever the user's diff.relative says", true],
  ])("a project below the repository root matches the scope against project-relative paths, %s", async (_name, relative) => {
    if (relative) await $`git -C ${repo} config diff.relative true`.quiet();
    const project = join(repo, "pkg", "api");
    write("pkg/api/src/a.ts", "a\n");
    write("src/x.ts", "x\n");
    write("pkg/api/docs/old.md", "old\n");
    write("lib/z.ts", "z\n");
    const moduleBase = await commit("module");
    write("lib/z.ts", "z\nz2\n");
    await commit("committed since the baseline");
    write("pkg/api/src/a.ts", "a\nb\n");
    write("src/x.ts", "x\ny\n");
    write("pkg/api/docs/new.md", "n1\nn2\n");
    write("top.md", "t\n");
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: project, baseCommit: moduleBase, scope: "src/**" });
    // Files are reported as git prints them (repository-root-relative); the root's src/x.ts is not the project's src/.
    expect(sorted(evidence.outOfScopeChanges)).toEqual([
      { file: "lib/z.ts", added: 1, removed: 0 },
      { file: "pkg/api/docs/new.md", added: 2, removed: 0 },
      { file: "src/x.ts", added: 1, removed: 0 },
      { file: "top.md", added: 1, removed: 0 },
    ]);
  });

  test("the counts come from the same snapshot as changedFiles, before --check can touch the tree", async () => {
    write("src/other/o.ts", "1\n2\n3\nfirst\n");
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: base, scope: "src/parser/**", checkCmd: "echo second >> src/other/o.ts" });
    expect(evidence.check?.exitCode).toBe(0);
    expect(evidence.outOfScopeChanges).toEqual([{ file: "src/other/o.ts", added: 1, removed: 0 }]);
  });

  test("a tracked file with a newline in its name keeps its counts", async () => {
    write("src/other/two\nlines.ts", "1\n2\n");
    const named = await commit("newline name");
    write("src/other/two\nlines.ts", "1\nx\ny\n");
    expect(await outOfScope("src/parser/**", named)).toEqual([{ file: "src/other/two\nlines.ts", added: 2, removed: 1 }]);
  });

  test("a tracked file named HEAD does not confuse the diff against HEAD", async () => {
    write("HEAD", "a\nb\n");
    await commit("odd name");
    write("HEAD", "a\nB\nc\n");
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, scope: "src/parser/**" });
    expect(evidence.outOfScopeChanges).toEqual([{ file: "HEAD", added: 2, removed: 1 }]);
  });

  test("test files outside the scope are listed like any other file", async () => {
    write("tests/stray.test.ts", "t\n");
    write("lib/__tests__/helper.ts", "h\n");
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: base, scope: "src/parser/**" });
    expect(evidence.testFilesChanged).toEqual(["lib/__tests__/helper.ts", "tests/stray.test.ts"]);
    expect(sorted(evidence.outOfScopeChanges)).toEqual([
      { file: "lib/__tests__/helper.ts", added: 1, removed: 0 },
      { file: "tests/stray.test.ts", added: 1, removed: 0 },
    ]);
  });

  test("an untracked file is binary when a NUL is among its first 8000 bytes, as git decides", async () => {
    const nulAt = (index: number) => {
      const data = Buffer.alloc(9000, 0x61);
      data[index] = 0;
      data[8999] = 10;
      return data;
    };
    write("src/other/nul-early.txt", nulAt(100));
    write("src/other/nul-edge.txt", nulAt(7999));
    write("src/other/nul-late.txt", nulAt(8000));
    expect(await outOfScope("src/parser/**")).toEqual([
      { file: "src/other/nul-early.txt", added: null, removed: null },
      { file: "src/other/nul-edge.txt", added: null, removed: null },
      { file: "src/other/nul-late.txt", added: 1, removed: 0 },
    ]);
  });

  test("untracked files share one byte budget", async () => {
    for (let i = 0; i < 9; i++) write(`bulk/${i}.txt`, "a\n".repeat(500_000));
    const bulk = (await outOfScope("src/parser/**"))!;
    expect(bulk.filter((change) => change.added === 500_000)).toHaveLength(8);
    expect(bulk[8]).toEqual({ file: "bulk/8.txt", added: null, removed: null });
  });

  test("a submodule with uncommitted changes is listed with null counts, not as net zero", async () => {
    const child = join(root, "child");
    mkdirSync(child);
    await $`git -C ${child} init -q`.quiet();
    write("c.txt", "c\n", child);
    await commit("child", child);
    await $`git -C ${repo} -c protocol.file.allow=always submodule add -q ${child} vendor`.quiet();
    const withModule = await commit("module");
    write("vendor/c.txt", "c\nedited\n");
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: withModule, scope: "src/parser/**" });
    expect(evidence.changedFiles).toEqual(["vendor"]);
    expect(evidence.outOfScopeChanges).toEqual([{ file: "vendor", added: null, removed: null }]);
  });

  test("reading the counts leaves the index alone, even for a file whose mtime changed", async () => {
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, "src/other/o.ts"), later, later);
    write("docs/readme.md", "changed\n");
    const index = join(repo, ".git", "index");
    const before = readFileSync(index);
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: base, scope: "src/parser/**" });
    expect(evidence.outOfScopeChanges).toEqual([{ file: "docs/readme.md", added: 1, removed: 4 }]);
    expect(readFileSync(index).equals(before)).toBe(true);
  });

  test("the wait deadline bounds the diff: entries stay listed with null counts and git is killed", async () => {
    write("src/other/o.ts", "1\n");
    write("src/other/new.txt", "n\n");
    const pidFile = join(root, "git.pid");
    shim(`case "$*" in *"diff --numstat"*) echo $$ > ${quote(pidFile)}; exec sleep 8 ;; esac`);
    const started = Date.now();
    const evidence = await collectEvidence({ id: "codex-sc", projectPath: repo, baseCommit: base, scope: "src/parser/**" }, { deadline: Date.now() + 1000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(sorted(evidence.outOfScopeChanges)).toEqual([
      { file: "src/other/new.txt", added: null, removed: null },
      { file: "src/other/o.ts", added: null, removed: null },
    ]);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await Bun.sleep(30);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
