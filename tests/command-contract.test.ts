import { describe, expect, test } from "bun:test";
import { COMMAND_CONTRACTS, renderHelpText, resolveParentId, resolveWaitTimeoutMs } from "../src/command-contract";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../src/commands/wait";

describe("command contract", () => {
  test("defines the default wait timeout once", () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(500000);
    expect(resolveWaitTimeoutMs()).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  test("converts wait timeout CLI seconds to internal milliseconds", () => {
    expect(resolveWaitTimeoutMs(2)).toBe(2000);
  });

  test("rejects negative wait timeout seconds", () => {
    expect(() => resolveWaitTimeoutMs(-1)).toThrow("--timeout must be >= 0 seconds");
  });

  test("resolves parent identity from agent environment", () => {
    expect(resolveParentId({ CODEX_THREAD_ID: "codex-thread" }, () => 123)).toBe("codex-thread");
    expect(resolveParentId({ CLAUDE_CODE_SESSION_ID: "claude-session", CODEX_THREAD_ID: "codex-thread" }, () => 123)).toBe("claude-session");
    expect(resolveParentId({}, () => 123)).toBe("cli-123");
  });

  test("renders help from the command catalog", () => {
    const help = renderHelpText();

    expect(help).toContain("ahelpa - Agent Help Agent");
    expect(help).toContain("wait <id...> [--all] [--timeout <seconds>]");
    for (const command of COMMAND_CONTRACTS) {
      expect(help).toContain(command.usage);
      expect(help).toContain(command.description);
    }
  });

  test("every contract names its required flags in its usage text", () => {
    for (const contract of COMMAND_CONTRACTS) {
      for (const [name, spec] of Object.entries(contract.flags ?? {})) {
        if (spec.required) {
          expect(contract.usage).toContain(`--${name}`);
        }
      }
    }
  });
});
