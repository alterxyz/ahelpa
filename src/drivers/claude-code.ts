import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions, TaskSubmissionContext } from "./types";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelOutcome, detectSentinelStatus } from "./sentinels";
import { findModelChoice, findSelectedChoice, parseModelMenuChoices, waitForOutput } from "./model-menu";

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
  // Both words and individual characters can wrap. Any stable fragment is
  // enough to block: typing into a live consent dialog is worse than an error.
  // Case and colons are part of the fragments: the default composer placeholder
  // quotes repo file names such as quickSafetyCheck.ts.
  const normalized = captureOutput.replace(/\s/gu, "");
  const fragments = [...normalized.matchAll(/Yes,Itrustthisfolder|Accessingworkspace:|Quicksafetycheck:|Doyoutrustthefilesinthisfolder\?|Doyoutrustthecontentsofthisdirectory\?/gu)];
  const lastFragment = fragments.at(-1);
  if (!lastFragment) return false;
  const dialogEnd = lastFragment.index! + lastFragment[0].length;
  // Only a column-0 composer after the LAST fragment establishes that the
  // dialog is now scrollback. Its own selected option is not a composer.
  return !userTurnMatches(captureOutput).some((prompt) =>
    captureOutput.slice(0, prompt.index).replace(/\s/gu, "").length >= dialogEnd
    && !claudeIsTrustOption(prompt[0]),
  );
}

function claudeIsTrustOption(prompt: string): boolean {
  const label = prompt.replace(/\s/gu, "").replace(/^❯(?:\d+\.)?/, "").toLowerCase();
  // A wrapped option may expose only the beginning of its label on this row.
  // Keep such ambiguous rows blocked, while an empty composer remains valid.
  return label.length > 0 && (/^(?:yes|no),/.test(label)
    || ["yes,itrustthisfolder", "yes,proceed", "no,exit", "no,continuewithoutthesepermissions"]
      .some((option) => option.startsWith(label)));
}

function userTurnMatches(captureOutput: string) {
  // User turns and the composer start at column 0; continuation rows are
  // indented. Include the empty composer, but not literal ❯ in continuations.
  return [...captureOutput.matchAll(/^❯(?:[^\S\r\n]+.*)?$/gmu)];
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
  // Step back over the idle composer at most once. A new task without evidence
  // must never inherit an older turn's DONE or NEED_HELP.
  const candidates = turns.slice(-2);
  for (let index = candidates.length - 1; index >= 0; index--) {
    const turn = candidates[index];
    if (turn.index === undefined) continue;
    const end = candidates[index + 1]?.index ?? captureOutput.length;
    const segment = captureOutput.slice(turn.index, end);
    if (claudeTurnEvidence(segment)) {
      return captureOutput.slice(turn.index);
    }
  }
  // If only the composer is visible, the task row has scrolled off screen.
  return candidates.length === 2 && candidates[0].index !== undefined
    ? captureOutput.slice(candidates[0].index)
    : captureOutput;
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
    if (claudeNeedsFolderTrust(recentOutput)) {
      throw new Error("Claude Code has not trusted the project directory; run `claude` there once and choose 'Yes, I trust this folder', then relaunch");
    }
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

function modelConfirmations(output: string): Array<{ model: string; text: string }> {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/\bSet model to (.+?) for this session only\b/i);
    return match ? [{ model: match[1].trim(), text: line.trim() }] : [];
  });
}

function normalizeModelLabel(model: string): string {
  return model.toLowerCase().replace(/\s*\(.*$/, "").replace(/\s+/g, " ").trim();
}

function freshModelConfirmation(output: string, target: string, baseline: string): string | undefined {
  const confirmations = modelConfirmations(output);
  const latest = confirmations.at(-1);
  if (!latest) return undefined;
  const actual = normalizeModelLabel(latest.model);
  const wanted = normalizeModelLabel(target);
  // Claude confirms the Default row using the resolved model's display name
  // followed by `(default)`, rather than echoing the menu label. Keep that
  // selection distinct from explicitly choosing the same concrete model.
  const confirmedDefault = /\(default\)/i.test(latest.model);
  if (confirmedDefault !== (wanted === "default")) return undefined;
  // An alias such as Sonnet can resolve to a versioned label, but a selected
  // version must not accept a different version or a suffixed model name.
  if (!confirmedDefault && actual !== wanted && !actual.startsWith(`${wanted} `)) return undefined;
  const count = (items: ReturnType<typeof modelConfirmations>) => items.filter(
    (confirmation) => confirmation.text === latest.text,
  ).length;
  return count(confirmations) > count(modelConfirmations(baseline)) ? latest.text : undefined;
}

export const claudeCodeDriver: AgentDriver = {
  name: "claude-code",
  sessionPrefix: "claude",
  launchProfiles: {
    defaultRole: "advisor",
    profiles: {
      advisor: { model: "claude-opus-5-5", effort: "xhigh" },
      worker: { model: "claude-sonnet-5-5", effort: "high" },
    },
  },
  resumeTokenAvailableAfterSubmit: false,
  modelCatalog: {
    models: [
      { name: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      { name: "claude-sonnet-5-5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
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
    // The verified interactive protocol only changes the session model.
    // Reject unsupported options before touching the terminal, so the caller
    // cannot persist a model/effort choice that was never actually applied.
    if (opts.effort !== undefined) {
      throw new Error("Claude Code runtime model switching does not support --effort; launch with --effort instead");
    }
    if (opts.persist) {
      throw new Error("Claude Code runtime model switching does not support --persist; only session-only changes are supported");
    }

    let menuOpen = false;
    try {
      await runtime.sendKeys(sessionId, "/model");
      menuOpen = true;
      const menu = await waitForOutput(
        sessionId,
        runtime,
        (output) => output.includes("Select model"),
        "Claude model menu",
      );
      const selected = findSelectedChoice(menu);
      const target = findModelChoice(menu, opts.model);
      const choices = parseModelMenuChoices(menu);
      // Arrow keys move between choices, not physical terminal lines. Model
      // descriptions may wrap onto several lines or have blank separators.
      const delta = choices.findIndex((choice) => choice.lineIndex === target.lineIndex)
        - choices.findIndex((choice) => choice.lineIndex === selected.lineIndex);

      await sendSteps(sessionId, runtime, delta < 0 ? "Up" : "Down", Math.abs(delta));
      await runtime.sendKey(sessionId, "s");

      const result = await waitForOutput(
        sessionId,
        runtime,
        (output) => freshModelConfirmation(output, target.label, menu) !== undefined,
        "Claude session-only model switch",
      );
      menuOpen = false;
      return freshModelConfirmation(result, target.label, menu)!;
    } catch (error) {
      if (menuOpen) await runtime.sendKey(sessionId, "Escape").catch(() => {});
      throw error;
    }
  },

  detectStatus(captureOutput: string): DetectedStatus {
    return claudeCodeDriver.detectOutcome(captureOutput).status;
  },

  detectOutcome(captureOutput: string) {
    return detectSentinelOutcome(currentTurnOutput(captureOutput));
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
