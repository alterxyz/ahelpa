import { describe, test, expect } from "bun:test";
import { getDriver } from "../src/drivers/registry";
import { codexNeedsHooksTrustEscape } from "../src/drivers/codex";

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
    expect(cmd).toContain("codex -s workspace-write -a never");
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
