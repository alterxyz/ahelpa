import { describe, expect, test } from "bun:test";
import { COMMAND_CONTRACTS, renderHelpText, renderModelsText, resolveParentId, resolveWaitTimeoutMs } from "../src/command-contract";
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

  test("renders all available agent model catalogs", () => {
    const text = renderModelsText();

    expect(text).toContain("Available models");
    expect(text).toContain("codex");
    expect(text).toContain("gpt-5.6 (effort: low, medium, high, xhigh; default: low)");
    expect(text).toContain("gpt-5.6-sol (effort: low, medium, high, xhigh; default: low)");
    expect(text).toContain("gpt-5.6-terra (effort: low, medium, high, xhigh; default: medium)");
    expect(text).toContain("gpt-5.6-luna (effort: low, medium, high, xhigh; default: medium)");
    expect(text).toContain("gpt-5.5 (effort: low, medium, high, xhigh; default: medium)");
    expect(text).toContain("claude-code");
    expect(text).toContain("sonnet");
  });

  test("renders one agent model catalog by name", () => {
    const text = renderModelsText("codex");

    expect(text).toContain("Available models");
    expect(text).toContain("codex");
    expect(text).toContain("gpt-5.6");
    expect(text).toContain("gpt-5.6-sol");
    expect(text).toContain("gpt-5.4-mini");
    expect(text).not.toContain("claude-code");
  });

  test("rejects an unknown model catalog agent", () => {
    expect(() => renderModelsText("unknown")).toThrow('Unknown driver: "unknown"');
  });

  test("rejects an empty-string model catalog agent", () => {
    expect(() => renderModelsText("")).toThrow('Unknown driver: ""');
  });
});
