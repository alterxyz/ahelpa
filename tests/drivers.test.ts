import { describe, test, expect } from "bun:test";
import { getDriver } from "../src/drivers/registry";

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
