import { describe, test, expect } from "bun:test";
import { getDriver } from "../src/drivers/registry";

describe("Codex Driver", () => {
  test("codex driver exists", () => {
    const driver = getDriver("codex");
    expect(driver.name).toBe("codex");
    expect(driver.sessionPrefix).toBe("codex");
  });

  test("codex builds launch command", () => {
    const driver = getDriver("codex");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project" });
    expect(cmd).toContain("codex");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("codex uses same signal protocol", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus("output\n[AHELPA:DONE]\n")).toBe("idle");
    expect(driver.detectStatus("[AHELPA:NEED_HELP]")).toBe("error");
    expect(driver.detectStatus("still working")).toBe("running");
  });
});
