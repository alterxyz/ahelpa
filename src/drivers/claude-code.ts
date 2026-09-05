import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions, TaskSubmissionContext } from "./types";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelStatus } from "./sentinels";
import { findModelChoice, findSelectedChoice, waitForOutput } from "./model-menu";

function claudeNeedsSubmitNudge(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && /\b0 tokens\b/.test(captureOutput)
    && !captureOutput.includes("⏺");
}

function claudeIsWorking(captureOutput: string): boolean {
  return captureOutput.includes("⏺")
    || /^\s*[✢✽✶✻✳]\s+\S.*…(?:\s+\(|\s*$)/mu.test(captureOutput);
}

function claudeNeedsFolderTrust(captureOutput: string): boolean {
  return /Do you trust (?:the files in this folder|the contents of this directory)\?/i
    .test(captureOutput);
}

function userTurnMatches(captureOutput: string) {
  return [...captureOutput.matchAll(/^\s*❯\s+\S.*$/gmu)];
}

function claudeTurnEvidence(segment: string): "working" | "idle" | "error" | null {
  const settled = detectSentinelStatus(segment);
  if (settled !== "running") return settled;
  return claudeIsWorking(segment) ? "working" : null;
}

function evidencedUserTurns(captureOutput: string): string[] {
  const turns = userTurnMatches(captureOutput);
  const evidenced: string[] = [];
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (turn.index === undefined) continue;
    const end = turns[index + 1]?.index ?? captureOutput.length;
    const segment = captureOutput.slice(turn.index, end);
    const evidence = claudeTurnEvidence(segment);
    if (evidence) evidenced.push(`${turn[0].trim()}\0${evidence}`);
  }
  return evidenced;
}

function currentTurnOutput(captureOutput: string): string {
  const turns = userTurnMatches(captureOutput);
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.index === undefined) continue;
    const end = turns[index + 1]?.index ?? captureOutput.length;
    const segment = captureOutput.slice(turn.index, end);
    if (claudeTurnEvidence(segment)) {
      return captureOutput.slice(turn.index);
    }
  }
  return captureOutput;
}

function claudeHasInputPrompt(captureOutput: string): boolean {
  // A numbered workspace-trust choice also uses Claude's `❯` cursor. It is
  // not the chat prompt and must never receive the task instruction.
  if (claudeNeedsFolderTrust(captureOutput)) return false;
  if (/\b0 tokens\b/.test(captureOutput)
    && (captureOutput.includes("❯") || captureOutput.includes("bypass permissions"))) {
    return true;
  }
  const prompts = [...captureOutput.matchAll(/^\s*❯(?:\s+.*)?$/gmu)];
  const latest = prompts.at(-1);
  if (latest?.index === undefined) return false;
  const trailing = captureOutput.slice(latest.index);
  return !claudeIsWorking(trailing) && detectSentinelStatus(trailing) === "running";
}

async function waitForInput(sessionId: string, runtime: DriverRuntime): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    await runtime.sleep(1000);
    const recentOutput = await runtime.capture(sessionId, 30);
    if (claudeHasInputPrompt(recentOutput)) {
      return;
    }
  }
  throw new Error(`Claude Code session ${sessionId} did not reach its input prompt`);
}

function hasNewUserTurn(beforeOutput: string, captureOutput: string): boolean {
  const beforeTurns = evidencedUserTurns(beforeOutput);
  const currentTurns = evidencedUserTurns(captureOutput);
  if (currentTurns.length > beforeTurns.length) return true;
  const currentLatest = currentTurns.at(-1);
  return currentLatest !== undefined && currentLatest !== beforeTurns.at(-1);
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
  resumeTokenAvailableAfterSubmit: false,
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

  async prepareForResume(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sleep(2000);
    await waitForInput(sessionId, runtime);
  },

  async afterTaskSubmitted(
    sessionId: string,
    runtime: DriverRuntime,
    context?: TaskSubmissionContext,
  ): Promise<boolean> {
    let nudged = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await runtime.sleep(1000);
      const recentOutput = await runtime.capture(sessionId, 30);
      if (context?.beforeOutput !== undefined
        && hasNewUserTurn(context.beforeOutput, recentOutput)) {
        return true;
      }
      if (!nudged && claudeNeedsSubmitNudge(recentOutput)) {
        await runtime.sendKeys(sessionId, "");
        nudged = true;
        if (context?.beforeOutput === undefined) return true;
        continue;
      }
      if (context?.beforeOutput !== undefined) {
        continue;
      }
      const current = currentTurnOutput(recentOutput);
      if (claudeIsWorking(current) || detectSentinelStatus(current) !== "running") {
        return true;
      }
    }
    return false;
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
    return detectSentinelStatus(currentTurnOutput(captureOutput));
  },

  detectActivity(captureOutput: string): "working" | "booting" | "idle" {
    const current = currentTurnOutput(captureOutput);
    if (claudeNeedsFolderTrust(current)) return "booting";
    // Token counters persist at the idle prompt, so use Claude's tool bullet
    // or animated verb line (for example `✢ Gitifying… (2m)`) instead.
    if (claudeIsWorking(current)) return "working";
    // Prompt visible with 0 tokens = just started, ready for task
    if (/\b0 tokens\b/.test(current) && claudeHasInputPrompt(current)) return "booting";
    // Header/banner appearing = CLI still loading
    if (/Claude Code v/i.test(current)) return "booting";
    return "idle";
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKeys(sessionId, "/exit");
  },
};
