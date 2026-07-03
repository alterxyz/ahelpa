import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions } from "./types";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelStatus, hasInlineSentinel } from "./sentinels";
import { findModelChoice, findSelectedChoice, waitForOutput } from "./model-menu";

function claudeNeedsSubmitNudge(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && /\b0 tokens\b/.test(captureOutput)
    && !captureOutput.includes("⏺");
}

function claudeIsReadyForInput(captureOutput: string): boolean {
  return /\b0 tokens\b/.test(captureOutput)
    && (captureOutput.includes("❯") || captureOutput.includes("bypass permissions"));
}

async function waitForInput(sessionId: string, runtime: DriverRuntime): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    await runtime.sleep(1000);
    const recentOutput = await runtime.capture(sessionId, 30);
    if (claudeIsReadyForInput(recentOutput)) {
      return;
    }
  }
}

async function sendSteps(sessionId: string, runtime: DriverRuntime, key: "Up" | "Down", count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await runtime.sendKey(sessionId, key);
    await runtime.sleep(50);
  }
}

function postureArgs(safe?: boolean): string[] {
  return safe ? ["--verbose"] : ["--dangerously-skip-permissions", "--verbose"];
}

function modelArgs(opts: { model?: string; effort?: string }): string[] {
  const args: string[] = [];
  if (opts.model) args.push("--model", shellEscape(opts.model));
  if (opts.effort) args.push("--effort", shellEscape(opts.effort));
  return args;
}

export const claudeCodeDriver: AgentDriver = {
  name: "claude-code",
  sessionPrefix: "claude",
  modelCatalog: {
    models: [
      { name: "fable" },
      { name: "opus" },
      { name: "sonnet" },
    ],
    effortNote: "effort: low, medium, high, xhigh, max (via --effort <level>)",
  },

  buildLaunchCommand(opts: LaunchOptions): string {
    const args = [...postureArgs(opts.safe), ...modelArgs(opts)];
    return `cd ${shellEscape(opts.cwd)} && claude ${args.join(" ")}`;
  },

  buildResumeCommand(opts: ResumeOptions): string {
    const args = [...postureArgs(opts.safe), ...modelArgs(opts)];
    return `cd ${shellEscape(opts.cwd)} && claude --resume ${shellEscape(opts.resumeId)} ${args.join(" ")}`;
  },

  extractResumeToken(captureOutput: string): string | null {
    const match = captureOutput.match(/claude --resume\s+(\S+)/);
    return match?.[1] ?? null;
  },

  async prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sleep(2000);
    await waitForInput(sessionId, runtime);
  },

  async afterTaskSubmitted(sessionId: string, runtime: DriverRuntime): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await runtime.sleep(1000);
      const recentOutput = await runtime.capture(sessionId, 30);
      if (claudeNeedsSubmitNudge(recentOutput)) {
        await runtime.sendKeys(sessionId, "");
        break;
      }
      if (recentOutput.includes("⏺") || hasInlineSentinel(recentOutput)) {
        break;
      }
    }
  },

  async switchModel(sessionId: string, runtime: DriverRuntime, opts: ModelSwitchOptions): Promise<string> {
    await runtime.sendKeys(sessionId, "/model");
    const menu = await waitForOutput(
      sessionId,
      runtime,
      (output) => output.includes("Select model"),
      "Claude model menu",
    );
    const selected = findSelectedChoice(menu);
    const target = findModelChoice(menu, opts.model);
    const delta = target.lineIndex - selected.lineIndex;

    await sendSteps(sessionId, runtime, delta < 0 ? "Up" : "Down", Math.abs(delta));
    await runtime.sendKey(sessionId, "s");

    const result = await waitForOutput(
      sessionId,
      runtime,
      (output) => /Set model to .* for this session only/i.test(output),
      "Claude session-only model switch",
    );
    return result.split("\n").find((line) => /Set model to/i.test(line))?.trim()
      ?? `Set model to ${opts.model} for this session only`;
  },

  detectStatus(captureOutput: string): DetectedStatus {
    return detectSentinelStatus(captureOutput);
  },

  detectActivity(captureOutput: string): "working" | "booting" | "idle" {
    // ⏺ is the only reliable active-turn indicator — token counters persist
    // at the idle prompt after a turn completes, so they can't distinguish
    // "working" from "idle with history".
    if (captureOutput.includes("⏺")) return "working";
    // Prompt visible with 0 tokens = just started, ready for task
    if (claudeIsReadyForInput(captureOutput)) return "booting";
    // Header/banner appearing = CLI still loading
    if (/Claude Code v/i.test(captureOutput)) return "booting";
    return "idle";
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKeys(sessionId, "/exit");
  },
};
