import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { deliveryRootFor, mainCheckoutOf, RuntimeLayout } from "../src/runtime-layout";
import { join, resolve } from "path";
import { shellEscape } from "../src/shell";

describe("runtime layout", () => {
  test("centralizes home, temp, archive, task, fifo, and project delivery paths", () => {
    const layout = new RuntimeLayout({
      homeDir: "/tmp/ahelpa-home",
      tmpDir: "/tmp/ahelpa-runtime",
    });

    expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-home/.ahelpa");
    expect(layout.stateDbPath()).toBe("/tmp/ahelpa-home/.ahelpa/state.db");
    expect(layout.daemonPidPath()).toBe("/tmp/ahelpa-home/.ahelpa/daemon.pid");
    expect(layout.daemonLogPath()).toBe("/tmp/ahelpa-home/.ahelpa/daemon.log");
    expect(layout.archiveDir()).toBe("/tmp/ahelpa-home/.ahelpa/archive");
    expect(layout.needHelpLedgerPath()).toBe("/tmp/ahelpa-home/.ahelpa/need-help.jsonl");
    expect(layout.projectDeliveryDir("/tmp/project")).toBe("/tmp/project/.ahelpa");
    expect(layout.taskFilePath("codex-abc")).toBe("/tmp/ahelpa-runtime/ahelpa-task-codex-abc.md");
    expect(layout.fifoPath("codex-abc")).toBe("/tmp/ahelpa-runtime/codex-abc.pipe");
  });

  test("accepts isolated state and temp roots without changing the process home", () => {
    const layout = new RuntimeLayout({
      ahelpaDir: "/tmp/ahelpa-isolated/state",
      tmpDir: "/tmp/ahelpa-isolated/runtime",
    });

    expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-isolated/state");
    expect(layout.stateDbPath()).toBe("/tmp/ahelpa-isolated/state/state.db");
    expect(layout.needHelpLedgerPath()).toBe("/tmp/ahelpa-isolated/state/need-help.jsonl");
    expect(layout.tmpDir).toBe("/tmp/ahelpa-isolated/runtime");
  });

  test("resolves explicit relative runtime roots and a relative home directory", () => {
    const layout = new RuntimeLayout({ homeDir: "relative-home", tmpDir: "relative-runtime" });
    const isolated = new RuntimeLayout({ ahelpaDir: "relative-state" });

    expect(layout.homeDir).toBe(resolve("relative-home"));
    expect(layout.ahelpaHomeDir()).toBe(resolve("relative-home/.ahelpa"));
    expect(layout.tmpDir).toBe(resolve("relative-runtime"));
    expect(isolated.ahelpaHomeDir()).toBe(resolve("relative-state"));
    expect(layout.needHelpLedgerPath()).toBe(resolve("relative-home/.ahelpa/need-help.jsonl"));
    expect(isolated.needHelpLedgerPath()).toBe(resolve("relative-state/need-help.jsonl"));
  });

  test("relative environment roots remain stable and are inherited after the caller changes directory", async () => {
    const moduleDir = join(import.meta.dir, "../src");
    const child = Bun.spawn([process.execPath, "-e", `
      import { StateDB } from ${JSON.stringify(join(moduleDir, "state.ts"))};
      import { planLaunch } from ${JSON.stringify(join(moduleDir, "commands/launch.ts"))};
      import { defaultRuntimeLayout } from ${JSON.stringify(join(moduleDir, "runtime-layout.ts"))};
      const base = process.cwd();
      const db = new StateDB(":memory:");
      process.chdir("/tmp");
      const plan = planLaunch({ db, agentType: "codex", task: "task", projectPath: base, parentId: "test" });
      console.log(JSON.stringify({ base, home: defaultRuntimeLayout.ahelpaHomeDir(), tmp: defaultRuntimeLayout.tmpDir, command: plan.launchCmd }));
      db.close();
    `], {
      env: { ...process.env, AHELPA_HOME: "relative state", AHELPA_TMP_DIR: "relative runtime" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const result = JSON.parse(stdout) as { base: string; home: string; tmp: string; command: string };
    expect(result.home).toBe(join(result.base, "relative state"));
    expect(result.tmp).toBe(join(result.base, "relative runtime"));
    expect(result.command).toContain(`AHELPA_HOME=${shellEscape(result.home)}`);
    expect(result.command).toContain(`AHELPA_TMP_DIR=${shellEscape(result.tmp)}`);
  });

  test("uses environment overrides for the default runtime layout", () => {
    const previousHome = process.env.AHELPA_HOME;
    const previousTmp = process.env.AHELPA_TMP_DIR;
    try {
      process.env.AHELPA_HOME = "/tmp/ahelpa-env/state";
      process.env.AHELPA_TMP_DIR = "/tmp/ahelpa-env/runtime";
      const layout = new RuntimeLayout();

      expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-env/state");
      expect(layout.needHelpLedgerPath()).toBe("/tmp/ahelpa-env/state/need-help.jsonl");
      expect(layout.tmpDir).toBe("/tmp/ahelpa-env/runtime");

      expect(new RuntimeLayout({ ahelpaDir: "/tmp/explicit-state" }).needHelpLedgerPath())
        .toBe("/tmp/explicit-state/need-help.jsonl");
      expect(new RuntimeLayout({ homeDir: "/tmp/explicit-home" }).needHelpLedgerPath())
        .toBe("/tmp/explicit-home/.ahelpa/need-help.jsonl");
    } finally {
      if (previousHome === undefined) delete process.env.AHELPA_HOME;
      else process.env.AHELPA_HOME = previousHome;
      if (previousTmp === undefined) delete process.env.AHELPA_TMP_DIR;
      else process.env.AHELPA_TMP_DIR = previousTmp;
    }
  });

  test("a delivery root moves the results; without one they stay in the project, whatever git says", () => {
    const layout = new RuntimeLayout({ homeDir: "/tmp/ahelpa-home", tmpDir: "/tmp/ahelpa-runtime" });

    expect(layout.projectDeliveryDir("/tmp/wt", "/tmp/main")).toBe("/tmp/main/.ahelpa");
    expect(layout.sessionDeliveryDir("/tmp/wt", "codex-abc", "/tmp/main")).toBe("/tmp/main/.ahelpa/codex-abc");
    expect(layout.turnsLogPath("/tmp/wt", "codex-abc", "/tmp/main")).toBe("/tmp/main/.ahelpa/codex-abc/turns.log");
    expect(layout.sessionDeliveryDir("/tmp/wt", "codex-abc")).toBe("/tmp/wt/.ahelpa/codex-abc");
    expect(layout.turnsLogPath("/tmp/wt", "codex-abc")).toBe("/tmp/wt/.ahelpa/codex-abc/turns.log");
  });

  test("ignores blank environment overrides", () => {
    const previousHome = process.env.AHELPA_HOME;
    const previousTmp = process.env.AHELPA_TMP_DIR;
    try {
      process.env.AHELPA_HOME = "   ";
      process.env.AHELPA_TMP_DIR = "";
      const layout = new RuntimeLayout({ homeDir: "/tmp/ahelpa-blank-env-home" });

      expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-blank-env-home/.ahelpa");
      expect(layout.needHelpLedgerPath()).toBe("/tmp/ahelpa-blank-env-home/.ahelpa/need-help.jsonl");
      expect(layout.tmpDir).toBe("/tmp/ahelpa");
    } finally {
      if (previousHome === undefined) delete process.env.AHELPA_HOME;
      else process.env.AHELPA_HOME = previousHome;
      if (previousTmp === undefined) delete process.env.AHELPA_TMP_DIR;
      else process.env.AHELPA_TMP_DIR = previousTmp;
    }
  });
});

describe("main checkout of a path", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), "main-checkout-test-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (!run.success) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  };
  function repo(name: string): string {
    const path = join(root, name);
    mkdirSync(path);
    git(path, "init", "-q");
    git(path, "commit", "-q", "--allow-empty", "-m", "init");
    return path;
  }

  test("a main checkout and its subdirectories are not linked", () => {
    const main = repo("main");
    mkdirSync(join(main, "pkg", "deep"), { recursive: true });
    expect(mainCheckoutOf(main)).toEqual({ main, linked: false });
    expect(mainCheckoutOf(join(main, "pkg", "deep"))).toEqual({ main, linked: false });
    expect(deliveryRootFor(main)).toBeUndefined();
    expect(deliveryRootFor(join(main, "pkg"))).toBeUndefined();
  });

  test("a linked worktree and its subdirectories point at the main checkout", () => {
    const main = repo("main");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", "-b", "b1", wt);
    mkdirSync(join(wt, "pkg"));
    for (const path of [wt, join(wt, "pkg")]) {
      expect(mainCheckoutOf(path)).toEqual({ main, linked: true });
      expect(deliveryRootFor(path)).toBe(main);
    }
  });

  test("a worktree with a relative gitdir resolves too", () => {
    const main = repo("main");
    const wt = join(root, "wt");
    git(main, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "-b", "b1", wt);
    expect(mainCheckoutOf(wt)).toEqual({ main, linked: true });
  });

  test("a symlinked path resolves to the canonical main checkout", () => {
    const main = repo("main");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", "-b", "b1", wt);
    symlinkSync(wt, join(root, "link-to-wt"));
    symlinkSync(main, join(root, "link-to-main"));
    expect(mainCheckoutOf(join(root, "link-to-wt"))).toEqual({ main, linked: true });
    expect(mainCheckoutOf(join(root, "link-to-main"))).toEqual({ main, linked: false });
  });

  test("layouts it cannot place give null, so results stay in the project", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(mainCheckoutOf(plain)).toBeNull();
    expect(deliveryRootFor(plain)).toBeUndefined();

    // A .git file without a gitdir line.
    const odd = join(root, "odd");
    mkdirSync(odd);
    writeFileSync(join(odd, ".git"), "not a gitdir pointer\n");
    expect(mainCheckoutOf(odd)).toBeNull();

    // A submodule's .git file names a git dir that has no commondir.
    const sub = join(root, "sub");
    mkdirSync(join(root, "modules", "sub"), { recursive: true });
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), "gitdir: ../modules/sub\n");
    expect(mainCheckoutOf(sub)).toBeNull();

    // --separate-git-dir: the work tree and its worktrees have a common dir not named .git.
    const separate = join(root, "separate");
    git(root, "init", "-q", "--separate-git-dir", join(root, "separate.git"), separate);
    git(separate, "commit", "-q", "--allow-empty", "-m", "init");
    expect(mainCheckoutOf(separate)).toBeNull();
    git(separate, "worktree", "add", "-q", "-b", "b1", join(root, "separate-wt"));
    expect(mainCheckoutOf(join(root, "separate-wt"))).toBeNull();

    // A bare repository's worktrees.
    const source = repo("source");
    git(root, "clone", "-q", "--bare", source, join(root, "bare.git"));
    git(join(root, "bare.git"), "worktree", "add", "-q", "-b", "b1", join(root, "bare-wt"));
    expect(mainCheckoutOf(join(root, "bare-wt"))).toBeNull();
  });

  test("a main checkout that moved or vanished gives null", () => {
    const main = repo("main");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", "-b", "b1", wt);
    renameSync(main, join(root, "main-moved"));
    expect(mainCheckoutOf(wt)).toBeNull();
    rmSync(join(root, "main-moved"), { recursive: true });
    expect(mainCheckoutOf(wt)).toBeNull();
  });
});
