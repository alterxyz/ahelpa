import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createCodexCapabilityProbe, readCodexHelp } from "../src/drivers/codex-capabilities";
import { shellEscape } from "../src/shell";

const fakeExecutable = () => "/test/codex";

describe("Codex capability parsing", () => {
  test.each([
    ["Codex CLI\nOptions:\n      --no-daemon\n          Run without the shared background server", true],
    ["Options:\n  --no-daemon  Run without the shared server", true],
    ["Options:\n  --model <MODEL>\n  --no-alt-screen", false],
    ["error: unexpected argument --no-daemon", false],
    ["  --no-daemon-extra  Another option", false],
    [undefined, false],
  ])("detects only an advertised no-daemon option", (help, supported) => {
    expect(createCodexCapabilityProbe(() => help, fakeExecutable)("/test/project").noDaemon).toBe(supported);
  });

  test.each([true, false])("caches a successful or unsupported probe (%s)", (supported) => {
    let calls = 0;
    const probe = createCodexCapabilityProbe(() => {
      calls++;
      return supported ? "  --no-daemon" : undefined;
    }, fakeExecutable);

    expect(probe("/test/project").noDaemon).toBe(supported);
    expect(probe("/test/project").noDaemon).toBe(supported);
    expect(calls).toBe(1);
  });

  test("falls back once when the help reader fails", () => {
    let calls = 0;
    const probe = createCodexCapabilityProbe(() => {
      calls++;
      throw new Error("CLI unavailable");
    }, fakeExecutable);

    expect(probe("/test/project").noDaemon).toBe(false);
    expect(probe("/test/project").noDaemon).toBe(false);
    expect(calls).toBe(1);
  });

  test("caches independently for each executable and project directory", () => {
    let executable = "/test/first/codex";
    const calls: string[][] = [];
    const probe = createCodexCapabilityProbe((binary, cwd) => {
      calls.push([binary, cwd]);
      return cwd === "/test/new" ? "  --no-daemon" : "  --model <MODEL>";
    }, () => executable);

    expect(probe("/test/new")).toEqual({ executable, noDaemon: true });
    expect(probe("/test/old")).toEqual({ executable, noDaemon: false });
    expect(probe("/test/new").noDaemon).toBe(true);
    executable = "/test/second/codex";
    expect(probe("/test/new")).toEqual({ executable, noDaemon: true });
    expect(calls).toEqual([
      ["/test/first/codex", "/test/new"],
      ["/test/first/codex", "/test/old"],
      ["/test/second/codex", "/test/new"],
    ]);
  });

  test("leaves login-shell resolution available when the host cannot find Codex", () => {
    let calls = 0;
    const probe = createCodexCapabilityProbe(() => { calls++; return "  --no-daemon"; }, () => null);

    expect(probe("/test/project")).toEqual({ executable: null, noDaemon: false });
    expect(calls).toBe(0);
  });
});

describe("Codex bounded help probe and command integration", () => {
  let root: string;
  let executable: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ahelpa-codex-capabilities it's-"));
    executable = join(root, "codex");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stub(body: string): void {
    writeFileSync(executable, `#!/bin/sh\n[ "$1" = "--help" ] || exit 99\n${body}\n`);
    chmodSync(executable, 0o755);
  }

  test("accepts the installed option surface only after a successful help exit", () => {
    stub("printf '%s\\n' '  --no-daemon'\nexit 1");
    expect(readCodexHelp(executable, root)).toBeUndefined();
    stub("printf '%s\\n' '  --no-daemon'");
    expect(readCodexHelp(executable, root)).toContain("--no-daemon");
  });

  test("falls back when the executable is unavailable", () => {
    expect(readCodexHelp(join(root, "missing"), root)).toBeUndefined();
  });

  test("kills a stuck help process within the timeout even when it ignores TERM", () => {
    stub("trap '' TERM\nwhile :; do :; done");
    const started = performance.now();

    expect(readCodexHelp(executable, root, 100)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("kills a timed-out shim's child even when it inherits the stdout pipe", async () => {
    const childFile = join(root, "child.pid");
    const sideEffect = join(root, "child-survived");
    const childScript = `/bin/sleep 0.6\nprintf 'survived' > ${shellEscape(sideEffect)}`;
    stub(`trap '' TERM\n/bin/sh -c ${shellEscape(childScript)} &\nprintf '%s' "$!" > ${shellEscape(childFile)}\nwait`);
    const started = performance.now();
    let child: number | undefined;
    try {
      const help = readCodexHelp(executable, root, 200);
      child = Number(readFileSync(childFile, "utf8"));
      expect(help).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(child).toBeGreaterThan(0);
      // Linux can retain a killed orphan as a zombie briefly. A delayed write
      // proves execution stopped without depending on when init reaps it.
      await Bun.sleep(650);
      expect(existsSync(sideEffect)).toBe(false);
    } finally {
      if (child) { try { process.kill(child, "SIGKILL"); } catch {} }
    }
  });

  test("bounds excessive help output", () => {
    stub("while :; do printf 'excessive help output\\n'; done");
    const started = performance.now();

    expect(readCodexHelp(executable, root, 500)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  function commandVariants(cwd = root, path = root): Record<string, string> {
    // Isolate the default cached probe and PATH; no test invokes the host's
    // installed Codex or starts a helper conversation.
    const modulePath = join(import.meta.dir, "../src/drivers/codex.ts");
    const result = Bun.spawnSync([process.execPath, "-e", `
      import { codexDriver } from ${JSON.stringify(modulePath)};
      console.log(JSON.stringify({
        launch: codexDriver.buildLaunchCommand({ cwd: ${JSON.stringify(cwd)}, model: "gpt-6.1-sol", effort: "high" }),
        safe: codexDriver.buildLaunchCommand({ cwd: ${JSON.stringify(cwd)}, safe: true }),
        resume: codexDriver.buildResumeCommand({ cwd: ${JSON.stringify(cwd)}, resumeId: "recorded", model: "gpt-6.1-sol", effort: "high" }),
        legacyResume: codexDriver.buildResumeCommand({ cwd: ${JSON.stringify(cwd)}, resumeId: "legacy", safe: true })
      }));
    `], {
      env: { ...process.env, PATH: path, AHELPA_TEST_CODEX_PROBE_LOG: join(root, "probe.log") },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4_000,
      killSignal: "SIGKILL",
    });
    expect(result.success).toBe(true);
    return JSON.parse(result.stdout.toString());
  }

  test("adds no-daemon to both permission modes and resumes without changing model choices", () => {
    stub("printf 'help\\n' >> \"$AHELPA_TEST_CODEX_PROBE_LOG\"\nprintf '%s\\n' '  --no-daemon'");
    const commands = commandVariants();

    for (const command of Object.values(commands)) expect(command).toEndWith("--no-daemon");
    expect(commands.launch).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(commands.safe).toContain("-s workspace-write -a never");
    for (const command of [commands.launch, commands.resume]) {
      expect(command).toContain("--model 'gpt-6.1-sol'");
      expect(command).toContain("-c 'model_reasoning_effort=\"high\"'");
    }
    expect(commands.legacyResume).toBe(`cd ${shellEscape(root)} && ${shellEscape(executable)} resume 'legacy' -s workspace-write -a never --no-daemon`);
    expect(readFileSync(join(root, "probe.log"), "utf8")).toBe("help\n");
  });

  test.each([
    ["old CLI", "printf '%s\\n' '  --model <MODEL>'"],
    ["failed help", "printf '%s\\n' '  --no-daemon'\nexit 1"],
    ["timed-out help", "trap '' TERM\nwhile :; do :; done"],
  ])("preserves the old command when the probe encounters %s", (_description, helpBody) => {
    stub(helpBody);
    const commands = commandVariants();

    for (const command of Object.values(commands)) expect(command).not.toContain("--no-daemon");
    expect(commands.legacyResume).toBe(`cd ${shellEscape(root)} && ${shellEscape(executable)} resume 'legacy' -s workspace-write -a never`);
    expect(commands.launch).toContain("--model 'gpt-6.1-sol'");
    expect(commands.launch).toContain("-c 'model_reasoning_effort=\"high\"'");
  });

  test("probes a cwd-dependent shim from the same directory used by the command", () => {
    const project = join(root, "project");
    mkdirSync(project);
    stub(`if [ "$PWD" = ${shellEscape(realpathSync(project))} ]; then printf '%s\\n' '  --no-daemon'; fi`);
    const commands = commandVariants(project);

    for (const command of Object.values(commands)) {
      expect(command).toStartWith(`cd ${shellEscape(project)} && ${shellEscape(executable)} `);
      expect(command).toEndWith("--no-daemon");
    }
    for (const command of Object.values(commandVariants(root))) expect(command).not.toContain("--no-daemon");
  });

  test("resolves a relative PATH entry against the project and binds the absolute executable", () => {
    const project = join(root, "relative-project");
    const bin = join(project, "bin");
    mkdirSync(bin, { recursive: true });
    executable = join(bin, "codex");
    stub("printf '%s\\n' '  --no-daemon'");
    const commands = commandVariants(project, "bin");

    for (const command of Object.values(commands)) {
      expect(command).toStartWith(`cd ${shellEscape(project)} && ${shellEscape(resolve(executable))} `);
      expect(command).toEndWith("--no-daemon");
    }
  });

  test("preserves the unbound command without no-daemon when PATH has no Codex", () => {
    const commands = commandVariants();

    expect(commands.legacyResume).toBe(`cd ${shellEscape(root)} && codex resume 'legacy' -s workspace-write -a never`);
    for (const command of Object.values(commands)) expect(command).not.toContain("--no-daemon");
  });
});
