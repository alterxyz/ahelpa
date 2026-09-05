import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions, TaskSubmissionContext } from "./types";
import { ModelSwitchAppliedError } from "./types";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelStatus } from "./sentinels";
import { findModelChoice, parseModelMenuChoices, waitForOutput } from "./model-menu";
import { restoreCodexConfig, snapshotCodexConfig } from "./codex-config";

function codexNeedsSubmitNudge(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !codexHasStartedTask(captureOutput);
}

function codexNeedsPromptNudge(captureOutput: string): boolean {
  return /Press enter to continue/i.test(captureOutput)
    || /Do you trust the contents of this directory\?/i.test(captureOutput);
}

// Codex >=0.141 asks to trust configured plugin hooks before the prompt.
// Escape declines-for-now and proceeds; Enter would open the hooks review
// sub-screen and strand the session there.
export function codexNeedsHooksTrustEscape(captureOutput: string): boolean {
  return /Press t to trust all/i.test(captureOutput)
    || /Press space or enter to toggle/i.test(captureOutput);
}

function codexNeedsUpdateSkip(captureOutput: string): boolean {
  return /Update available!/i.test(captureOutput)
    && /2\.\s*Skip/i.test(captureOutput)
    && /Press enter to continue/i.test(captureOutput);
}

function codexIsStarting(captureOutput: string): boolean {
  return captureOutput.includes("Starting MCP servers");
}

function codexHasStartedTask(captureOutput: string): boolean {
  return captureOutput.includes("Working (")
    // Codex >=0.145 in-turn spinner, e.g. "Starting MCP servers (2/3): codex_apps (5s • esc to interrupt)".
    || /\(\d+[hms](?:\s+\d+[ms])?\s*•\s*esc to interrupt\)/i.test(captureOutput)
    || /\n\s*• (Reading|Explored|Using|Ran|Updated|Edited|Searching|Checked|Inspecting|Analyzing|Planning|Summarizing|Opened)\b/.test(captureOutput);
}

function codexHasUnsupportedModelError(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !codexHasStartedTask(captureOutput)
    && /(?:^|\n)\s*(?:■|ERROR:)[\s\S]{0,1000}?model\s+is\s+not\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account/i.test(captureOutput);
}

function userTurnMatches(captureOutput: string) {
  return [...captureOutput.matchAll(/^\s*›\s+\S.*$/gmu)];
}

function codexTurnEvidence(segment: string): "working" | "idle" | "error" | null {
  const settled = detectSentinelStatus(segment);
  if (settled !== "running") return settled;
  if (codexHasUnsupportedModelError(segment)) return "error";
  return codexHasStartedTask(segment) ? "working" : null;
}

function evidencedUserTurns(captureOutput: string): string[] {
  const turns = userTurnMatches(captureOutput);
  const evidenced: string[] = [];
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (turn.index === undefined) continue;
    const end = turns[index + 1]?.index ?? captureOutput.length;
    const evidence = codexTurnEvidence(captureOutput.slice(turn.index, end));
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
    if (codexTurnEvidence(captureOutput.slice(turn.index, end))) {
      return captureOutput.slice(turn.index);
    }
  }
  return captureOutput;
}

function hasNewUserTurn(beforeOutput: string, captureOutput: string): boolean {
  const beforeTurns = evidencedUserTurns(beforeOutput);
  const currentTurns = evidencedUserTurns(captureOutput);
  if (currentTurns.length > beforeTurns.length) return true;
  const currentLatest = currentTurns.at(-1);
  return currentLatest !== undefined && currentLatest !== beforeTurns.at(-1);
}

// Input-prompt budget: 2s grace + CODEX_INPUT_POLLS x 1s once Codex is past MCP
// startup. While "Starting MCP servers" is visible, up to CODEX_STARTING_POLLS
// extra 1s polls are granted so a slow MCP boot (Codex 0.145 under load) does
// not read as "no response". Worst case ~2 + 20 + 60 = 82s (launch ≈ 88s, 30s under a 120s host timeout).
const CODEX_INPUT_POLLS = 20;
const CODEX_STARTING_POLLS = 60;

function codexHasInputPrompt(captureOutput: string): boolean {
  const prompts = [...captureOutput.matchAll(/^\s*›(?:\s+.*)?$/gmu)];
  const latest = prompts.at(-1);
  if (latest?.index === undefined) return false;
  return !codexTurnEvidence(captureOutput.slice(latest.index));
}

async function waitForCodexInput(sessionId: string, runtime: DriverRuntime): Promise<void> {
  let nudged = false;
  let startingPolls = 0;

  await runtime.sleep(2000);
  for (let attempt = 0; attempt < CODEX_INPUT_POLLS; attempt++) {
    await runtime.sleep(1000);
    const recentOutput = await runtime.capture(sessionId, 20);
    if (codexIsStarting(recentOutput)) {
      // MCP startup must not consume the "no response" budget: refund the
      // poll while the startup banner is visible, up to CODEX_STARTING_POLLS.
      if (++startingPolls <= CODEX_STARTING_POLLS) attempt--;
      continue;
    }
    // Not gated on `nudged`: the trust flow can need one Escape per screen.
    if (codexNeedsHooksTrustEscape(recentOutput)) {
      await runtime.sendKey(sessionId, "Escape");
      continue;
    }
    if (!nudged && codexNeedsUpdateSkip(recentOutput)) {
      await runtime.sendKeys(sessionId, "2");
      nudged = true;
      continue;
    }
    if (!nudged && codexNeedsPromptNudge(recentOutput)) {
      await runtime.sendKeys(sessionId, "");
      nudged = true;
      continue;
    }
    if (codexHasInputPrompt(recentOutput)) return;
  }
  const startupNote = startingPolls > 0 ? ` (waited ${startingPolls}s in MCP startup)` : "";
  throw new Error(`Codex session ${sessionId} did not reach its input prompt${startupNote}`);
}

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const CODEX_MAX_EFFORTS = [...CODEX_EFFORTS, "max"] as const;
const CODEX_ULTRA_EFFORTS = [...CODEX_MAX_EFFORTS, "ultra"] as const;
const CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.6": "gpt-5.6-sol",
};

function resolveCodexModel(model: string): string {
  return CODEX_MODEL_ALIASES[model] ?? model;
}

function postureArgs(safe?: boolean): string[] {
  return safe
    ? ["-s", "workspace-write", "-a", "never"]
    : ["--dangerously-bypass-approvals-and-sandbox"];
}

function modelArgs(opts: { model?: string; effort?: string }): string[] {
  const args: string[] = [];
  const model = opts.model ? resolveCodexModel(opts.model) : undefined;
  if (model) args.push("--model", shellEscape(model));
  if (opts.effort) args.push("-c", shellEscape(`model_reasoning_effort=${JSON.stringify(opts.effort)}`));
  return args;
}

function normalizeEffort(effort: string): string {
  const normalized = effort.toLowerCase().replace(/[-_\s]+/g, "");
  if (normalized === "extrahigh") return "xhigh";
  if (normalized === "maximum") return "max";
  return normalized;
}

function reasoningKey(output: string, effort?: string): string {
  if (!effort) return "Enter";
  const wanted = normalizeEffort(effort);
  const choices = parseModelMenuChoices(output);
  const choice = choices.find((candidate) => wanted === "default"
    ? /\(default\)/i.test(candidate.label)
    : normalizeEffort(candidate.label.replace(/\s*\(.*$/, "")) === wanted);
  if (!choice) throw new Error(`Codex effort "${effort}" is not available in the reasoning menu`);
  if (choice.disabled) throw new Error(`Codex effort "${effort}" is disabled in the reasoning menu`);
  return choice.number;
}

type ModelEvent =
  | { kind: "model" | "reasoning"; line: number }
  | { kind: "confirmation"; line: number; model: string; text: string };

function modelEvents(output: string): ModelEvent[] {
  return output.split("\n").flatMap((text, line): ModelEvent[] => {
    if (text.includes("Select Model and Effort")) return [{ kind: "model", line }];
    if (text.includes("Select Reasoning Level")) return [{ kind: "reasoning", line }];
    const match = text.match(/\bModel changed to ([a-z0-9][a-z0-9.-]*)(?=\s|$)/i);
    return match ? [{ kind: "confirmation", line, model: match[1], text: text.trim() }] : [];
  });
}

function currentMenu(output: string, kind: "model" | "reasoning"): string | undefined {
  const event = modelEvents(output).at(-1);
  return event?.kind === kind ? output.split("\n").slice(event.line).join("\n") : undefined;
}

function freshModelConfirmation(output: string, model: string, baseline: ModelEvent[]): string | undefined {
  const events = modelEvents(output);
  const latest = events.at(-1);
  if (latest?.kind !== "confirmation" || latest.model !== model) return undefined;

  // Only the latest event can confirm the switch, even when older pickers
  // remain in scrollback. Require a new line or occurrence relative to the
  // menu snapshot so a disappearing picker cannot expose an old confirmation
  // for the same model and make it appear to have just completed.
  const occurrences = (items: ModelEvent[]) => items.filter((event) =>
    event.kind === "confirmation" && event.text === latest.text,
  ).length;
  return occurrences(events) > occurrences(baseline) ? latest.text : undefined;
}

export const codexDriver: AgentDriver = {
  name: "codex",
  sessionPrefix: "codex",
  resumeTokenAvailableAfterSubmit: false,
  modelCatalog: {
    models: [
      { name: "gpt-6-astra", efforts: CODEX_ULTRA_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.6", efforts: CODEX_ULTRA_EFFORTS, defaultEffort: "low" },
      { name: "gpt-5.6-sol", efforts: CODEX_ULTRA_EFFORTS, defaultEffort: "low" },
      { name: "gpt-5.6-terra", efforts: CODEX_ULTRA_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.6-luna", efforts: CODEX_MAX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.5", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.4", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.4-mini", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.2", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "codex-auto-review", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
    ],
  },

  buildLaunchCommand(opts: LaunchOptions): string {
    const args = [...postureArgs(opts.safe), ...modelArgs(opts)];
    return `cd ${shellEscape(opts.cwd)} && codex ${args.join(" ")}`;
  },

  buildResumeCommand(opts: ResumeOptions): string {
    const args = [...postureArgs(opts.safe), ...modelArgs(opts)];
    return `cd ${shellEscape(opts.cwd)} && codex resume ${shellEscape(opts.resumeId)} ${args.join(" ")}`;
  },

  extractResumeToken(captureOutput: string): string | null {
    const match = captureOutput.match(/codex resume\s+(\S+)/);
    return match?.[1] ?? null;
  },

  async prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await waitForCodexInput(sessionId, runtime);
  },

  async prepareForResume(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await waitForCodexInput(sessionId, runtime);
  },

  async afterTaskSubmitted(
    sessionId: string,
    runtime: DriverRuntime,
    context?: TaskSubmissionContext,
  ): Promise<boolean> {
    let nudged = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await runtime.sleep(500);
      const recentOutput = await runtime.capture(sessionId, 30);
      if (context?.beforeOutput !== undefined
        && hasNewUserTurn(context.beforeOutput, recentOutput)) {
        return true;
      }
      if (!nudged && codexNeedsSubmitNudge(recentOutput)) {
        await runtime.sendKeys(sessionId, "");
        nudged = true;
        if (context?.beforeOutput === undefined) return true;
        continue;
      }
      if (context?.beforeOutput !== undefined) {
        continue;
      }
      const current = currentTurnOutput(recentOutput);
      if (codexTurnEvidence(current)) {
        return true;
      }
    }
    return false;
  },

  async switchModel(sessionId: string, runtime: DriverRuntime, opts: ModelSwitchOptions): Promise<string> {
    const configSnapshot = opts.persist ? null : snapshotCodexConfig();
    const model = resolveCodexModel(opts.model);
    let menuOpen = false;
    let switchError: unknown;
    try {
      await runtime.sendKeys(sessionId, "/model");
      menuOpen = true;
      const menu = await waitForOutput(
        sessionId,
        runtime,
        (output) => currentMenu(output, "model") !== undefined,
        "Codex model menu",
      );
      const baseline = modelEvents(menu);
      const target = findModelChoice(currentMenu(menu, "model")!, model);
      await runtime.sendKey(sessionId, target.number);

      const next = await waitForOutput(
        sessionId,
        runtime,
        (output) => currentMenu(output, "reasoning") !== undefined
          || freshModelConfirmation(output, model, baseline) !== undefined,
        "Codex reasoning menu",
      );
      const reasoningMenu = currentMenu(next, "reasoning");
      if (reasoningMenu !== undefined) {
        await runtime.sendKey(sessionId, reasoningKey(reasoningMenu, opts.effort));
      }

      const result = await waitForOutput(
        sessionId,
        runtime,
        (output) => freshModelConfirmation(output, model, baseline) !== undefined,
        "Codex model switch confirmation",
      );
      menuOpen = false;
      return freshModelConfirmation(result, model, baseline)!;
    } catch (error) {
      switchError = error;
      // An unavailable model/effort must not strand the helper in a picker.
      if (menuOpen) await runtime.sendKey(sessionId, "Escape").catch(() => {});
      throw error;
    } finally {
      if (configSnapshot) {
        try {
          restoreCodexConfig(configSnapshot);
        } catch (restoreError) {
          const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
          if (switchError !== undefined) {
            const switchMessage = switchError instanceof Error ? switchError.message : String(switchError);
            throw new AggregateError([switchError, restoreError], `${switchMessage}; ${message}`);
          }
          throw new ModelSwitchAppliedError(`Model changed to ${model}, but ${message}`);
        }
      }
    }
  },

  detectStatus(captureOutput: string): DetectedStatus {
    const evidence = codexTurnEvidence(currentTurnOutput(captureOutput));
    return evidence === "idle" || evidence === "error" ? evidence : "running";
  },

  detectActivity(captureOutput: string): "working" | "booting" | "idle" {
    const current = currentTurnOutput(captureOutput);
    if (codexHasStartedTask(current)) return "working";
    if (codexIsStarting(current)) return "booting";
    // Config banner visible = CLI just opened, not yet ready
    if (/OpenAI Codex/i.test(current)) return "booting";
    return "idle";
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    // Exiting prints the resume command; Escape only dismisses UI elements.
    await runtime.sendKeys(sessionId, "/exit");
  },
};
