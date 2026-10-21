import { afterEach, describe, test, expect, mock, spyOn } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDriver } from "../src/drivers/registry";
import { codexNeedsHooksTrustEscape } from "../src/drivers/codex";
import * as capabilities from "../src/drivers/codex-capabilities";
import { shellEscape } from "../src/shell";

describe("Drivers", () => {
  test("claude-code driver exists", () => {
    const driver = getDriver("claude-code");
    expect(driver).not.toBeNull();
    expect(driver.name).toBe("claude-code");
    expect(driver.sessionPrefix).toBe("claude");
  });

  test("claude-code safe mode omits danger flag", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project", safe: true });
    expect(cmd).toContain("claude --verbose");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  test("claude-code danger mode includes danger flag by default", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project" });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  test("claude-code launch command accepts model and effort", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildLaunchCommand({
      cwd: "/tmp/project",
      model: "sonnet",
      effort: "high",
    });
    expect(cmd).toContain("--model 'sonnet'");
    expect(cmd).toContain("--effort 'high'");
  });

  test("claude-code launch command shell-quotes cwd", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project with spaces/it's ok" });
    expect(cmd).toContain(`cd '/tmp/project with spaces/it'\\''s ok' && claude`);
  });

  test("codex safe mode uses workspace-write sandbox", () => {
    const driver = getDriver("codex");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project", safe: true });
    expect(cmd).toContain(" -s workspace-write -a never");
    expect(cmd).not.toContain("--dangerously-bypass");
  });

  test("codex danger mode includes bypass flag by default", () => {
    const driver = getDriver("codex");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project" });
    expect(cmd).toContain("--dangerously-bypass");
  });

  test("codex launch command accepts model and effort", () => {
    const driver = getDriver("codex");
    const cmd = driver.buildLaunchCommand({
      cwd: "/tmp/project",
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(cmd).toContain("--model 'gpt-5.5'");
    expect(cmd).toContain("-c 'model_reasoning_effort=\"xhigh\"'");
  });

  test("codex routes the gpt-5.6 alias to gpt-5.6-sol for launch and resume", () => {
    const driver = getDriver("codex");
    const launch = driver.buildLaunchCommand({
      cwd: "/tmp/project",
      model: "gpt-5.6",
      effort: "xhigh",
    });
    const resume = driver.buildResumeCommand({
      cwd: "/tmp/project",
      resumeId: "resume-token",
      model: "gpt-5.6",
      effort: "xhigh",
    });

    expect(launch).toContain("--model 'gpt-5.6-sol'");
    expect(launch).not.toContain("--model 'gpt-5.6'");
    expect(resume).toContain("--model 'gpt-5.6-sol'");
    expect(resume).not.toContain("--model 'gpt-5.6'");
  });

  test("codex preserves explicit gpt-5.6 variant names", () => {
    const driver = getDriver("codex");
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const command = driver.buildLaunchCommand({ cwd: "/tmp/project", model });
      expect(command).toContain(`--model '${model}'`);
    }
  });

  test("codex hooks trust screens trigger an escape", () => {
    expect(codexNeedsHooksTrustEscape(
      "SessionStart hooks\n  Press t to trust all; enter to review hooks; esc to close",
    )).toBe(true);
    expect(codexNeedsHooksTrustEscape(
      "[ ] Hook 1\n  Press space or enter to toggle; esc to go back",
    )).toBe(true);
    expect(codexNeedsHooksTrustEscape("› Implement {feature}\n  gpt-5.5 high")).toBe(false);
  });

  test("claude-code detects status via sentinel", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectStatus("some output\n[AHELPA:DONE]\n")).toBe("idle");
    expect(driver.detectStatus("still working...")).toBe("running");
    expect(driver.detectStatus("oops\n[AHELPA:NEED_HELP]\n")).toBe("error");
    expect(driver.detectStatus("normal output")).toBe("running");
  });

  test("unknown driver throws", () => {
    expect(() => getDriver("unknown")).toThrow();
  });
});

// A linked worktree's results live in the main checkout, outside the cwd and
// outside a safe helper's writable workspace, so --safe must grant that directory.
describe("safe mode and a result directory outside the project", () => {
  let cwd: string | undefined;
  afterEach(() => { mock.restore(); if (cwd) rmSync(cwd, { recursive: true, force: true }); cwd = undefined; });
  function project(): string {
    cwd = mkdtempSync(join(realpathSync(tmpdir()), "drivers-add-dir-"));
    spyOn(capabilities, "getCodexCapabilities").mockReturnValue({ executable: "/bin/echo", noDaemon: false });
    return cwd;
  }
  const outside = "/tmp/main repo's checkout/.ahelpa/helper-1";

  test("claude-code adds the directory last, after --settings, for launch and resume", () => {
    const driver = getDriver("claude-code");
    const base = { cwd: project(), sessionId: "helper-1", deliveryDir: outside, safe: true };
    const settings = `--settings ${shellEscape(join(outside, "claude-settings.json"))}`;
    for (const command of [driver.buildLaunchCommand(base), driver.buildResumeCommand({ ...base, resumeId: "native" })]) {
      expect(command).toEndWith(` --add-dir ${shellEscape(outside)}`);
      expect(command.indexOf(settings)).toBeGreaterThan(-1);
      expect(command.indexOf(settings)).toBeLessThan(command.indexOf("--add-dir"));
    }
  });

  test("codex adds the directory for launch and resume, quoted for the shell", async () => {
    const driver = getDriver("codex");
    const base = { cwd: project(), sessionId: "helper-1", deliveryDir: outside, safe: true };
    for (const command of [driver.buildLaunchCommand(base), driver.buildResumeCommand({ ...base, resumeId: "native" })]) {
      expect(command).toContain(` -s workspace-write -a never --add-dir ${shellEscape(outside)} `);
      // The shell must see the path as one argument, whatever characters it holds.
      const child = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
      expect(await new Response(child.stdout).text()).toContain(`--add-dir ${outside} -c notify=`);
      expect(await child.exited).toBe(0);
    }
  });

  test.each(["claude-code", "codex"])("%s adds nothing when not safe, or when the directory is inside the project", agent => {
    const driver = getDriver(agent);
    const dir = project();
    const inside = join(dir, ".ahelpa", "helper-1");
    const resume = { resumeId: "native" };
    for (const opts of [
      { cwd: dir, sessionId: "helper-1", deliveryDir: outside },
      { cwd: dir, sessionId: "helper-1", deliveryDir: outside, safe: false },
      { cwd: dir, sessionId: "helper-1", deliveryDir: inside, safe: true },
      { cwd: dir, sessionId: "helper-1", safe: true },
      { cwd: dir, safe: true },
    ]) {
      expect(driver.buildLaunchCommand(opts)).not.toContain("--add-dir");
      expect(driver.buildResumeCommand({ ...opts, ...resume })).not.toContain("--add-dir");
    }
  });
});
