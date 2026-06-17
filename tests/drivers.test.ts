import { describe, test, expect } from "bun:test";
import { getDriver } from "../src/drivers/registry";

describe("Drivers", () => {
  test("claude-code driver exists", () => {
    const driver = getDriver("claude-code");
    expect(driver).not.toBeNull();
    expect(driver.name).toBe("claude-code");
    expect(driver.sessionPrefix).toBe("claude");
  });

  test("claude-code builds launch command", () => {
    const driver = getDriver("claude-code");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project" });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
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
