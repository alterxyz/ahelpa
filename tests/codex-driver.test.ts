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

  test("codex launch command shell-quotes cwd", () => {
    const driver = getDriver("codex");
    const cmd = driver.buildLaunchCommand({ cwd: "/tmp/project with spaces/it's ok" });
    expect(cmd).toContain(`cd '/tmp/project with spaces/it'\\''s ok' && codex`);
  });

  test("codex uses same signal protocol", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus("output\n[AHELPA:DONE]\n")).toBe("idle");
    expect(driver.detectStatus("[AHELPA:NEED_HELP]")).toBe("error");
    expect(driver.detectStatus("still working")).toBe("running");
  });

  test("codex detects an unsupported ChatGPT-account model request as error", () => {
    const driver = getDriver("codex");
    const output = [
      "Please read and complete the task described in /tmp/ahelpa/task.md.",
      "■ {\"type\":\"error\",\"status\":400,\"error\":",
      "{\"message\":\"The 'gpt-5.6' model is not supported",
      "when using Codex with a ChatGPT account.\"}}",
      "› Explain this codebase",
    ].join("\n");

    expect(driver.detectStatus(output)).toBe("error");
  });

  test("codex ignores a stale unsupported-model error after later task progress", () => {
    const driver = getDriver("codex");
    const output = [
      "ERROR: The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
      "Working (1s)",
      "• Reading file src/cli.ts",
    ].join("\n");

    expect(driver.detectStatus(output)).toBe("running");
  });

  test("codex ignores unsupported-model error text quoted after task progress", () => {
    const driver = getDriver("codex");
    const output = [
      "Please read and complete the task described in /tmp/ahelpa/task.md.",
      "Working (1s)",
      "• Ran codex exec --model gpt-5.6",
      "ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.\"}}",
      "› Explain this codebase",
    ].join("\n");

    expect(driver.detectStatus(output)).toBe("running");
  });
});
