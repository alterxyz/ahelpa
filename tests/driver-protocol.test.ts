import { describe, expect, test } from "bun:test";
import { getDriver } from "../src/drivers/registry";
import type { DriverRuntime } from "../src/drivers/types";

type ProbeRuntime = DriverRuntime & {
  captures: Array<{ sessionId: string; lines?: number }>;
  sent: string[];
  sleeps: number[];
};

function probeRuntime(outputs: string[]): ProbeRuntime {
  const captures: Array<{ sessionId: string; lines?: number }> = [];
  const sent: string[] = [];
  const sleeps: number[] = [];
  let outputIndex = 0;

  return {
    captures,
    sent,
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
      "Working (1s)",
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
      "Working (1s)",
    ]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures.length).toBe(2);
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
});
