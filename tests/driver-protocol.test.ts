import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

// Source-derived layouts from the adversarial review of Claude 2.1.291;
// these are synthetic screens, not recordings of a live helper.
const claudeTrustFixtures: Record<string, string> = JSON.parse(
  readFileSync(new URL("./fixtures/claude-trust.json", import.meta.url), "utf8"),
);
const claudeSubmitFixtures: Record<string, string> = JSON.parse(
  readFileSync(new URL("./fixtures/claude-submit.json", import.meta.url), "utf8"),
);

describe("claude-code queued-task submit nudge", () => {
  test.each(["queued-ctx-only", "queued-no-footer", "queued-zero-tokens", "queued-after-old-reply"])(
    "%s sends one Enter and waits for submission evidence",
    async (name) => {
      const queued = claudeSubmitFixtures[name];
      const beforeOutput = name === "queued-after-old-reply"
        ? `${queued.slice(0, queued.indexOf("────────────────"))}❯`
        : "❯\n  0% ctx";
      const runtime = probeRuntime([queued, queued, `${queued}\n✢ Working…`]);
      expect(await getDriver("claude-code").afterTaskSubmitted("claude-test", runtime, { beforeOutput })).toBe(true);
      expect(runtime.sent).toEqual([""]);
      expect(runtime.keys).toEqual([]);
      expect(runtime.captures).toHaveLength(3);
    },
  );

  test.each([
    "submitted-working", "submitted-answered", "submitted-answered-header-scrolled-out",
    "submitted-done-no-bullet", "submitted-need-help-no-bullet",
    "submitted-empty-composer", "submitted-placeholder-composer", "indented-task-echo", "echo-in-reply",
    "permission-menu", "permission-menu-column-zero", "question-menu",
  ])("%s never sends Enter, with or without a pre-submit snapshot", async (name) => {
    for (const context of [undefined, { beforeOutput: "❯" }]) {
      const runtime = probeRuntime([claudeSubmitFixtures[name]]);
      await getDriver("claude-code").afterTaskSubmitted("claude-test", runtime, context);
      expect(runtime.sent).toEqual([]);
      expect(runtime.keys).toEqual([]);
    }
  });

  test.each(["wide-with-source-padding", "backstop-yes-selected", "option-wrap-24-yes-selected"])(
    "%s never receives a submit nudge even with a preceding task echo and zero-token footer",
    async (name) => {
      const screen = `${claudeSubmitFixtures["queued-zero-tokens"]}\n${claudeTrustFixtures[name]}`;
      const runtime = probeRuntime([screen]);
      expect(await getDriver("claude-code").afterTaskSubmitted("claude-test", runtime)).toBe(false);
      expect(runtime.sent).toEqual([]);
      expect(runtime.keys).toEqual([]);
    },
  );
});

describe("claude-code adversarial readiness and turn isolation", () => {
  describe.each([
    "backstop-no-selected",
    "backstop-yes-selected",
    "option-wrap-24-no-selected",
    "option-wrap-24-yes-selected",
  ])("live trust fixture %s", (name) => {
    test.each(["prepareForTask", "prepareForResume"] as const)("%s rejects the consent dialog without sending input", async (prepare) => {
      const runtime = probeRuntime([claudeTrustFixtures[name]]);
      await expect(getDriver("claude-code")[prepare]("claude-test", runtime)).rejects.toThrow("has not trusted");
      expect(runtime.captures).toHaveLength(1);
      expect(runtime.sent).toEqual([]);
      expect(runtime.keys).toEqual([]);
    });
  });

  test("indented post-option chevron does not establish a normal composer", async () => {
    const screen = "Accessing workspace:\n/tmp/project\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm\n  ❯ example";
    const runtime = probeRuntime([screen]);
    await expect(getDriver("claude-code").prepareForResume("claude-test", runtime)).rejects.toThrow("has not trusted");
    expect(runtime.sent).toEqual([]);
    expect(runtime.keys).toEqual([]);
  });

  test("a single Yes trust option blocks readiness when there is no later real composer", async () => {
    // Fail closed even if the overlapping label belongs to another menu.
    const screen = "Select a phrase\n  ❯ Yes, I trust this folder\n Enter to confirm";
    const runtime = probeRuntime([screen]);
    const driver = getDriver("claude-code");
    await expect(driver.prepareForResume("claude-test", runtime)).rejects.toThrow("has not trusted");
    expect(driver.detectActivity(screen)).toBe("booting");
    expect(runtime.sent).toEqual([]);
    expect(runtime.keys).toEqual([]);
  });

  test.each([
    "Yes, I trust this folder",
    "Accessing workspace:",
    "Quick safety check:",
    "Do you trust the files in this folder?",
    "Do you trust the contents of this directory?",
  ])("trust fragment '%s' survives character wrapping and only a later composer clears it", async (fragment) => {
    const wrapped = [...fragment].join("\n\u00a0");
    const driver = getDriver("claude-code");
    for (const prepare of ["prepareForTask", "prepareForResume"] as const) {
      const blocked = probeRuntime([`${wrapped}\n  ❯ 1. Example choice`]);
      await expect(driver[prepare]("claude-test", blocked)).rejects.toThrow("has not trusted");
      expect(blocked.sent).toEqual([]);
      expect(blocked.keys).toEqual([]);
      const ready = probeRuntime([`${wrapped}\n❯\u00a0\n  bypass permissions on`]);
      await driver[prepare]("claude-test", ready);
      expect(ready.captures).toHaveLength(1);
      expect(ready.sent).toEqual([]);
      expect(ready.keys).toEqual([]);
    }
  });

  test("column-0 trust choices after the last fragment cannot clear a live dialog", async () => {
    const driver = getDriver("claude-code");
    for (const choice of [
      "❯ No, exit",
      "❯\u00a0No, continue without these permissions",
      "❯ 2. No, exit",
      "❯ N\n  o, exit",
      "❯ Y\n  es, proceed",
    ]) {
      const runtime = probeRuntime([`Accessing workspace:\n  Yes, I trust this folder\n${choice}\nEnter to confirm`]);
      await expect(driver.prepareForResume("claude-test", runtime)).rejects.toThrow("has not trusted");
      expect(runtime.sent).toEqual([]);
      expect(runtime.keys).toEqual([]);
    }
  });

  test("a composer before the last dialog fragment does not clear the later consent prompt", async () => {
    const screen = "Accessing workspace:\n❯ Try asking about this codebase\nQuick safety check: Is this a project you created or one you trust?\n ❯ No, exit";
    await expect(getDriver("claude-code").prepareForResume("claude-test", probeRuntime([screen])))
      .rejects.toThrow("has not trusted");
  });

  test.each(["[AHELPA:DONE]", "[AHELPA:NEED_HELP:review]"])("NBSP composer excludes old %s from an unanswered turn and submission confirmation", async (old) => {
    const driver = getDriver("claude-code");
    for (const composer of ["❯\u00a0", "❯\u00a0Try asking about this codebase"]) {
      for (const reply of ["", "我会读取本轮任务"]) {
        const screen = [
          "❯ Old task",
          `⏺ ${old}`,
          "❯ New task",
          reply,
          composer,
          "  bypass permissions on",
        ].join("\n");
        expect(driver.detectOutcome(screen)).toEqual({ status: "running", needHelpTags: null });
        const runtime = probeRuntime([screen]);
        expect(await driver.afterTaskSubmitted("claude-test", runtime)).toBe(false);
        expect(runtime.captures).toHaveLength(10);
        expect(runtime.sent).toEqual([]);
        expect(runtime.keys).toEqual([]);
      }
    }
  });

  test.each(["prepareForTask", "prepareForResume"] as const)("%s rejects a line-wrapped safety dialog regardless of cursor selection", async (prepare) => {
    const driver = getDriver("claude-code");
    for (const screen of [
      claudeTrustFixtures["narrow-52-no-selected"],
      claudeTrustFixtures["narrow-52-yes-selected"],
      claudeTrustFixtures["narrow-52-no-selected"].replace("❯ No, exit", "  No, exit"),
      "  No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel",
    ]) {
      const runtime = probeRuntime([screen]);
      await expect(driver[prepare]("claude-test", runtime)).rejects.toThrow(
        "Claude Code has not trusted the project directory; run `claude` there once and choose 'Yes, I trust this folder', then relaunch",
      );
      expect(runtime.captures).toHaveLength(1);
      expect(runtime.sent).toEqual([]);
      expect(runtime.keys).toEqual([]);
      expect(driver.detectActivity(screen)).toBe("booting");
    }
  });

  test.each(["quickSafetyCheck.ts", "accessingWorkspace.ts", "yesItrustthisfolder.md"])(
    "the default placeholder quoting a repo file such as %s is an ordinary composer",
    async (file) => {
      const driver = getDriver("claude-code");
      const screen = `Claude Code v2.1.291\nOpus | 0 tokens\n❯ Try "how does ${file} work?"\n  bypass permissions on (shift+tab to cycle)`;
      for (const prepare of ["prepareForTask", "prepareForResume"] as const) {
        const runtime = probeRuntime([screen]);
        await driver[prepare]("claude-test", runtime);
        expect(runtime.sent).toEqual([]);
      }
    },
  );

  test("resume accepts a trusted screen discussing the dialog text or showing old menu scrollback", async () => {
    const driver = getDriver("claude-code");
    const quoted = [
      "❯ Explain the safety dialog",
      "⏺ It says:",
      "  Quick safety check: Is this a project you created or one you trust?",
      "  No, exit",
      "  Yes, I trust this folder",
      "❯\u00a0",
      "  bypass permissions on",
    ].join("\n");
    const legacy = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n❯ Try asking about this codebase";
    for (const screen of [
      quoted,
      legacy,
      claudeTrustFixtures["normal-reply-quoting-dialog"],
      claudeTrustFixtures["trusted-scrollback"],
    ]) {
      for (const prepare of ["prepareForTask", "prepareForResume"] as const) {
        const runtime = probeRuntime([screen]);
        await driver[prepare]("claude-test", runtime);
        expect(runtime.captures).toHaveLength(1);
        expect(runtime.sent).toEqual([]);
        expect(runtime.keys).toEqual([]);
      }
    }
  });
});

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

  test("codex treats a slow MCP startup as booting, not as no response", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      ...Array.from({ length: 30 }, () => "Starting MCP servers"),
      "› Implement {feature}",
    ]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures.length).toBe(31);
  });

  test.each(["prepareForTask", "prepareForResume"] as const)("codex %s grants the full slow-MCP budget", async (prepare) => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      ...Array.from({ length: 60 }, () => "Starting MCP servers"),
      "› Implement {feature}",
    ]);

    await driver[prepare]("codex-test", runtime);

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toHaveLength(61);
    expect(runtime.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(63_000);
  });

  test("codex bounds a startup that never exposes its input prompt", async () => {
    const runtime = probeRuntime(["Starting MCP servers"]);

    await expect(getDriver("codex").prepareForTask("codex-test", runtime))
      .rejects.toThrow("did not reach its input prompt");

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toHaveLength(80);
    expect(runtime.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(82_000);
  });

  test("codex accepts the in-turn MCP spinner as turn evidence without an extra Enter", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      [
        "› Please read and complete the task described in /tmp/ahelpa/x.md",
        "• Starting MCP servers (2/3): codex_apps (5s • esc to interrupt)",
      ].join("\n"),
    ]);

    const submitted = await driver.afterTaskSubmitted("codex-test", runtime, {
      beforeOutput: "› Improve documentation in @filename",
    });

    expect(submitted).toBe(true);
    expect(runtime.sent).toEqual([]);
  });

  test("codex does not nudge Enter on the MCP spinner when no pre-submit snapshot exists", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime([
      [
        "› Please read and complete the task described in /tmp/ahelpa/x.md",
        "• Starting MCP servers (2/3): codex_apps (5s • esc to interrupt)",
      ].join("\n"),
    ]);

    const submitted = await driver.afterTaskSubmitted("codex-test", runtime, {});

    expect(submitted).toBe(true);
    expect(runtime.sent).toEqual([]);
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

  test("codex skips the 0.160 update menu and never mistakes it for the input prompt", async () => {
    const driver = getDriver("codex");
    const menu = [
      "  Update available · 0.160.0 → 0.160.1",
      "  Release notes: https://github.com/openai/codex/releases/latest",
      "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)",
      "  2. Skip",
      "  3. Skip until next version",
      "  enter continue · esc skip",
    ].join("\n");
    const runtime = probeRuntime([menu, "› Implement {feature}"]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual(["2"]);
  });

  test("codex keeps waiting past an unknown numbered menu instead of typing into it", async () => {
    const driver = getDriver("codex");
    const runtime = probeRuntime(["› 1. Do something irreversible\n  2. Cancel", "› Implement {feature}"]);

    await driver.prepareForTask("codex-test", runtime);

    expect(runtime.sent).toEqual([]);
    expect(runtime.captures.length).toBeGreaterThanOrEqual(2);
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
      "Claude Code has not trusted the project directory",
    );

    expect(runtime.sent).toEqual([]);
    expect(runtime.keys).toEqual([]);
    expect(runtime.captures).toHaveLength(1);
  });

  test.each(["prepareForTask", "prepareForResume"] as const)("claude-code %s fails fast without typing into the workspace safety dialog", async (prepare) => {
    const dialog = [
      "  Accessing workspace:",
      "  /tmp/project with spaces",
      "  Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or",
      "  work from your team). If not, take a moment to review what's in this folder first.",
      "  Claude Code'll be able to read, edit, and execute files here.",
      "  Security guide",
      "  ❯ No, exit",
      "    Yes, I trust this folder",
      "  Enter to confirm · Esc to cancel",
    ].join("\n");
    const driver = getDriver("claude-code");
    const runtime = probeRuntime([dialog]);

    await expect(driver[prepare]("claude-test", runtime)).rejects.toThrow(
      "Claude Code has not trusted the project directory; run `claude` there once and choose 'Yes, I trust this folder', then relaunch",
    );
    expect(runtime.captures).toHaveLength(1);
    expect(runtime.sent).toEqual([]);
    expect(runtime.keys).toEqual([]);
    expect(driver.detectActivity(dialog)).toBe("booting");
  });

  test("claude-code nudges when the submitted task remains queued", async () => {
    const driver = getDriver("claude-code");
    const runtime = probeRuntime([
      [
        "❯ Please read and complete the task described in /tmp/ahelpa-task-placeholder.md.",
        "  When you are finished, output [AHELPA:DONE] on its own line.",
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
  test.each(["[AHELPA:DONE]", "[AHELPA:NEED_HELP:review]"])("claude-code never reuses an older %s while the new task has no recognized evidence", (sentinel) => {
    const driver = getDriver("claude-code");
    for (const reply of ["", "╭─ Pending response ─╮\n╰────────────────────╯", "我会读取本轮任务"]) {
      for (const composer of ["❯ Try asking about this codebase", "❯"]) {
        const screen = [
          "❯ Previous review task",
          `⏺ ${sentinel}`,
          "❯ Please read and complete the task described in /tmp/ahelpa/ahelpa-task-x.md. Use /p/.ahelpa/x as your",
          "  result directory. Tags: see the end of the task file.",
          reply,
          composer,
        ].join("\n");
        expect(driver.detectStatus(screen)).toBe("running");
        expect(driver.detectOutcome(screen)).toEqual({ status: "running", needHelpTags: null });
      }
    }
  });

  test.each(["❯ Try asking about this codebase", "❯"])("claude-code settles on DONE when only the composer %s is on screen", (composer) => {
    expect(getDriver("claude-code").detectStatus(`⏺ Wrote the review.\n  [AHELPA:DONE]\n${composer}`)).toBe("idle");
  });

  test.each([
    "❯ Complete the review\n⏺ Completed it.\n  [AHELPA:DONE]\n  ❯ transcript example A\n  ❯ transcript example B\n❯ Try asking about this codebase",
    "❯ Complete the review\n⏺ Completed it.\n  [AHELPA:DONE]\n❯ Draft transcript for later\n  ❯ example A\n  ❯ example B",
  ])("claude-code ignores indented literal chevrons when finding the current turn", (screen) => {
    expect(getDriver("claude-code").detectStatus(screen)).toBe("idle");
  });

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

  test("codex keeps a resumed turn that opened with a non-English reply instead of reusing the old DONE", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus([
      "› Previous review task",
      "• Wrote the review.",
      "  [AHELPA:DONE]",
      "› Please read and complete the task described in /tmp/ahelpa/ahelpa-task-x.md. Use /p/.ahelpa/x as your",
      "  result directory. Tags: see the end of the task file.",
      "• 我会读取本轮任务",
      "› Ask Codex to do anything",
      "  GPT-6.1-Sol xhigh · ~/Desktop/project · Complete the ahelpa task",
    ].join("\n"))).toBe("running");
  });

  test("codex never reuses an older DONE while the new task turn has no reply yet", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus([
      "› Previous review task",
      "• Wrote the review.",
      "  [AHELPA:DONE]",
      "› Please read and complete the task described in /tmp/ahelpa/ahelpa-task-x.md.",
      "› Ask Codex to do anything",
    ].join("\n"))).toBe("running");
  });

  test("codex settles on DONE when only the composer is left on screen", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus("• Wrote the review.\n  [AHELPA:DONE]\n› Ask Codex to do anything\n  gpt-5.5 high")).toBe("idle");
  });

  test.each(["Queued follow-up inputs", "Messages to be submitted after next tool call", "Messages to be submitted at end of turn"])(
    "codex does not treat the pending-input header '%s' as activity",
    (header) => {
      expect(getDriver("codex").detectActivity(`• ${header}\n  ↳ Continue the review\n› Ask Codex to do anything`)).toBe("idle");
    },
  );

  test.each([
    "› Complete the review\n• Completed it.\n  [AHELPA:DONE]\n  › transcript example A\n  › transcript example B\n› Ask Codex to do anything",
    "› Complete the review\n• Completed it.\n  [AHELPA:DONE]\n› Draft transcript for later\n  › example A\n  › example B",
  ])("codex ignores indented literal chevrons when finding the current turn", (screen) => {
    expect(getDriver("codex").detectStatus(screen)).toBe("idle");
  });

  test("codex does not treat indented bullets in the user's text as a reply", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus([
      "› Please read and complete the task described in /tmp/ahelpa/ahelpa-task-x.md.",
      "  • Acceptance criterion: preserve behaviour",
      "■ The model is not supported when using Codex with a ChatGPT account.",
    ].join("\n"))).toBe("error");
  });

  test("codex still settles when its idle placeholder trails DONE", () => {
    const driver = getDriver("codex");
    expect(driver.detectStatus(
      "› Task\n• [AHELPA:DONE]\n› Implement {feature}\n  gpt-5.5 high",
    )).toBe("idle");
  });
});
