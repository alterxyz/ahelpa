import { describe, expect, test } from "bun:test";
import { getDriver } from "../src/drivers/registry";
import type { DriverRuntime } from "../src/drivers/types";

type ProbeRuntime = DriverRuntime & {
  captures: Array<{ sessionId: string; lines?: number }>;
  sent: string[];
  keys: string[];
  sleeps: number[];
};

function probeRuntime(outputs: string[]): ProbeRuntime {
  const captures: Array<{ sessionId: string; lines?: number }> = [];
  const sent: string[] = [];
  const keys: string[] = [];
  const sleeps: number[] = [];
  let outputIndex = 0;

  return {
    captures,
    sent,
    keys,
    sleeps,

    async sleep(ms: number): Promise<void> {
      sleeps.push(ms);
    },

    async capture(sessionId: string, lines?: number): Promise<string> {
      captures.push({ sessionId, lines });
      const output = outputs[Math.min(outputIndex, outputs.length - 1)] ?? "";
      outputIndex++;
      return output;
    },

    async sendKeys(_sessionId: string, text: string): Promise<void> {
      sent.push(text);
    },

    async sendKey(_sessionId: string, key: string): Promise<void> {
      keys.push(key);
    },
  };
}

describe("driver launch protocol", () => {
  test("codex nudges directory trust prompt before task submission", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      [
        "You are in /private/tmp",
        "Do you trust the contents of this directory?",
        "Press enter to continue",
      ].join("\n"),
      "› Implement {feature}",
    ]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual([""]);
    expect(runtime.captures).toEqual([
      { sessionId: "codex-test", lines: 20 },
      { sessionId: "codex-test", lines: 20 },
    ]);
    expect(runtime.sleeps).toEqual([2000, 1000, 1000]);
  });

  test("codex waits through startup text without nudging", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      "Starting MCP servers",
      "› Implement {feature}",
    ]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures.length).toBe(2);
  });

  test("codex skips update prompt instead of accepting update", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      [
        "Update available! 0.128.0 -> 0.140.0",
        "1. Update now",
        "2. Skip",
        "3. Skip until next version",
        "Press enter to continue",
      ].join("\n"),
      "› Implement {feature}",
    ]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual(["2"]);
  });

  test("claude-code waits for the input prompt before task submission", async () => {
    const driver = getDriver("claude-code");
    const runtime = probeRuntime([
      "Claude Code is still starting",
      "Claude Code is still starting",
      "Opus 4.6 (1M context) | 0 tokens\nbypass permissions on",
    ]);

    await driver.prepareForTask("claude-test", runtime);

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toEqual([
      { sessionId: "claude-test", lines: 30 },
      { sessionId: "claude-test", lines: 30 },
      { sessionId: "claude-test", lines: 30 },
    ]);
    expect(runtime.sleeps).toEqual([2000, 1000, 1000, 1000]);
  });

  test("claude-code does not mistake workspace trust for the chat prompt", async () => {
    const driver = getDriver("claude-code");
    const runtime = probeRuntime([
      [
        "Do you trust the files in this folder?",
        "❯ 1. Yes, proceed",
        "  2. No, exit",
      ].join("\n"),
    ]);

    await expect(driver.prepareForTask("claude-test", runtime)).rejects.toThrow(
      "did not reach its input prompt",
    );

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toHaveLength(15);
  });

  test("claude-code nudges when the submitted task remains queued", async () => {
    const driver = getDriver("claude-code");
    const runtime = probeRuntime([
      [
        "Please read and complete the task described in /tmp/ahelpa-task-placeholder.md.",
        "When you are finished, output [AHELPA:DONE] on its own line.",
        "",
        "0 tokens",
      ].join("\n"),
    ]);

    await driver.afterTaskSubmitted("claude-test", runtime);

    expect(runtime.sent).toEqual([""]);
    expect(runtime.captures).toEqual([{ sessionId: "claude-test", lines: 30 }]);
    expect(runtime.sleeps).toEqual([1000]);
  });

  test("claude-code waits past a stale DONE until a new user turn appears", async () => {
    const driver = getDriver("claude-code");
    const previous = "❯ First task\n[AHELPA:DONE]\n❯";
    const runtime = probeRuntime([
      previous,
      `${previous}\n❯ Follow-up task\n✢ Working…`,
    ]);

    const submitted = await driver.afterTaskSubmitted(
      "claude-test",
      runtime,
      { beforeOutput: previous },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(2);
  });

  test("claude-code does not treat inline handoff sentinel text as a submitted turn", async () => {
    const driver = getDriver("claude-code");
    const before = "0 tokens\n❯ Try asking about this codebase";
    const queued = [
      before,
      "❯ Please read and complete the task described in /tmp/task.md; output [AHELPA:DONE] when finished.",
      "0 tokens",
    ].join("\n");
    const runtime = probeRuntime([
      queued,
      `${queued}\n✢ Working…`,
    ]);

    const submitted = await driver.afterTaskSubmitted(
      "claude-test",
      runtime,
      { beforeOutput: before },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(2);
    expect(runtime.sent).toEqual([""]);
  });

  test("codex waits past stale NEED_HELP until a new user turn appears", async () => {
    const driver = getDriver("codex");
    const previous = "› First task\n[AHELPA:NEED_HELP]\n›";
    const runtime = probeRuntime([
      previous,
      `${previous}\n› Follow-up task\nWorking (1s)`,
    ]);

    const submitted = await driver.afterTaskSubmitted(
      "codex-test",
      runtime,
      { beforeOutput: previous },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(2);
  });

  test("claude-code accepts a repeated prompt when its new evidence is working", async () => {
    const driver = getDriver("claude-code");
    const runtime = probeRuntime(["❯ Repeat this task\n✢ Working…"]);

    const submitted = await driver.afterTaskSubmitted(
      "claude-test",
      runtime,
      { beforeOutput: "❯ Repeat this task\n[AHELPA:DONE]" },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(1);
  });

  test("codex accepts a repeated prompt when its new evidence is working", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime(["› Repeat this task\nWorking (1s)"]);

    const submitted = await driver.afterTaskSubmitted(
      "codex-test",
      runtime,
      { beforeOutput: "› Repeat this task\n[AHELPA:DONE]" },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(1);
  });

  test("codex accepts an unsupported-model response as new turn evidence", async () => {
    const driver = getDriver("codex");
    const before = "› Implement {feature}";
    const failed = [
      before,
      "› Please read and complete the task described in /tmp/ahelpa/task.md.",
      "■ {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.\"}}",
      "› Explain this codebase",
    ].join("\n");
    const runtime = probeRuntime([failed]);

    const submitted = await driver.afterTaskSubmitted(
      "codex-test",
      runtime,
      { beforeOutput: before },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(1);
    expect(runtime.sent).toEqual([]);
  });

  test("claude-code switches model with cursor navigation and session-only select", async () => {
    const driver = getDriver("claude-code");
    const runtime = probeRuntime([
      [
        "  1. Default",
        "  2. Opus",
        "  3. Sonnet",
        "  4. Haiku",
        "❯ 5. Opus 4.6 ✔",
        "Select model",
      ].join("\n"),
      "Set model to Sonnet 4.6 for this session only",
    ]);

    const result = await driver.switchModel("claude-test", runtime, { model: "sonnet" });

    expect(result).toContain("Set model to Sonnet 4.6");
    expect(runtime.sent).toEqual(["/model"]);
    expect(runtime.keys).toEqual(["Up", "Up", "s"]);
  });

  test("codex switches model through model and reasoning menus", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      [
        "Select Model and Effort",
        "❯ 1. gpt-5.5 (current)",
        "  2. gpt-5.4",
      ].join("\n"),
      [
        "Select Reasoning Level for gpt-5.4",
        "  1. Low",
        "❯ 2. Medium (default)",
        "  3. High",
        "  4. Extra high",
      ].join("\n"),
      "Model changed to gpt-5.4 xhigh",
    ]);

    const result = await driver.switchModel("codex-test", runtime, {
      model: "gpt-5.4",
      effort: "xhigh",
      persist: true,
    });

    expect(result).toContain("Model changed to gpt-5.4 xhigh");
    expect(runtime.sent).toEqual(["/model"]);
    expect(runtime.keys).toEqual(["2", "4"]);
  });

  test("codex routes the gpt-5.6 alias to sol when switching models", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      [
        "Select Model and Effort",
        "❯ 1. gpt-5.6-terra (current)",
        "  2. gpt-5.6-sol",
      ].join("\n"),
      [
        "Select Reasoning Level for gpt-5.6-sol",
        "  1. Low",
        "  2. Medium (default)",
        "  3. High",
        "  4. Extra high",
      ].join("\n"),
      "Model changed to gpt-5.6-sol xhigh",
    ]);

    const result = await driver.switchModel("codex-test", runtime, {
      model: "gpt-5.6",
      effort: "xhigh",
      persist: true,
    });

    expect(result).toContain("Model changed to gpt-5.6-sol xhigh");
    expect(runtime.sent).toEqual(["/model"]);
    expect(runtime.keys).toEqual(["2", "4"]);
  });
});

describe("detectActivity", () => {
  test("claude-code: ⏺ = working", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectActivity("⏺ Reading file src/cli.ts\n0 tokens")).toBe("working");
    expect(driver.detectActivity("✢ Gitifying… (2m 7s · ↓ 7.8k tokens)\n❯")).toBe("working");
  });

  test("claude-code: non-zero token counter without ⏺ = idle (persists after turn)", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectActivity("Opus 4.6 | 1234 tokens")).toBe("idle");
  });

  test("claude-code: prompt with 0 tokens = booting", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectActivity("0 tokens\n❯")).toBe("booting");
    expect(driver.detectActivity("Claude Code v2.1.191")).toBe("booting");
  });

  test("claude-code: unrecognized output = idle", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectActivity("Press enter to view hooks; esc to close")).toBe("idle");
    expect(driver.detectActivity("Do you trust the files in this folder?")).toBe("booting");
  });

  test("codex: active task = working", () => {
    const driver = getDriver("codex");
    expect(driver.detectActivity("Working (5s)\n• Reading file src/cli.ts")).toBe("working");
  });

  test("codex: MCP startup = booting", () => {
    const driver = getDriver("codex");
    expect(driver.detectActivity("Starting MCP servers")).toBe("booting");
    expect(driver.detectActivity("OpenAI Codex (v0.141.0)\nmodel: loading")).toBe("booting");
  });

  test("codex: unrecognized output = idle", () => {
    const driver = getDriver("codex");
    expect(driver.detectActivity("Press enter to view hooks; esc to close")).toBe("idle");
    expect(driver.detectActivity("Select Model and Effort\n❯ 1. gpt-5.5")).toBe("idle");
  });
});

describe("resumed turn status", () => {
  test("claude-code ignores a DONE sentinel from an earlier turn", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectStatus(
      "❯ First task\n[AHELPA:DONE]\n❯ Follow-up task\n✢ Working…",
    )).toBe("running");
  });

  test("codex ignores NEED_HELP from an earlier turn", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus(
      "› First task\n[AHELPA:NEED_HELP]\n› Follow-up task\nWorking (1s)",
    )).toBe("running");
  });

  test("claude-code still settles when a non-empty idle placeholder trails DONE", () => {
    const driver = getDriver("claude-code");
    expect(driver.detectStatus(
      "❯ Task\n⏺ [AHELPA:DONE]\n❯ Try asking about this codebase",
    )).toBe("idle");
  });

  test("codex still settles when its idle placeholder trails DONE", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus(
      "› Task\n• [AHELPA:DONE]\n› Implement {feature}\n  gpt-5.5 high",
    )).toBe("idle");
  });
});
