import { defaultRuntimeLayout } from "../runtime-layout";
import { turnHookCommand } from "../turn-hooks";
import type { AgentDriver, DetectedOutcome, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions, StartupNotes, TaskSubmissionContext } from "./types";
import { codexTrustNote, ModelSwitchAppliedError } from "./types";
import { isTaskInstructionEcho } from "../file-handoff";
import { checkCodexReadiness } from "./codex-readiness";
import { shellEscape } from "../shell";
import { detectSentinelOutcome } from "./sentinels";
import { findModelChoice, parseModelMenuChoices, waitForOutput } from "./model-menu";
import { restoreCodexConfig, snapshotCodexConfig } from "./codex-config";
import { getCodexCapabilities } from "./codex-capabilities";
import { join, resolve } from "path";

function codexNeedsSubmitNudge(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !codexHasStartedTask(captureOutput);
}

function codexNeedsPromptNudge(captureOutput: string): boolean {
  return /Press enter to continue/i.test(captureOutput)
    || /Do you trust the contents of this directory\?/i.test(captureOutput);
}

// Codex >=0.141 asks to trust configured plugin hooks before the prompt ("Press t to trust all"); >=0.16x draws a
// numbered menu instead ("Hooks need review … 1. Review hooks / 2. Trust all and continue / 3. Continue without
// trusting … esc skip"). Escape declines-for-now and proceeds without the hooks: Enter would open the review
// sub-screen or trust them, and whether a project's hooks may run for helpers is the host's decision, not ahelpa's.
// The menu is live only while every "›" row after its latest header is one of its own numbered options; a composer
// below it means the menu is scrollback.
export function codexNeedsHooksTrustEscape(captureOutput: string): boolean {
  if (/Press t to trust all/i.test(captureOutput) || /Press space or enter to toggle/i.test(captureOutput)) return true;
  const header = [...captureOutput.matchAll(/^[^\S\n]*Hooks need review[^\S\n]*$/gm)].at(-1);
  if (header?.index === undefined) return false;
  const rows = [...captureOutput.slice(header.index).matchAll(/^[^\S\n]*›.*$/gm)];
  return rows.length > 0 && rows.every((row) => /^[^\S\n]*›[^\S\n]*\d+\.\s/.test(row[0]));
}

// Codex <=0.15x: "Update available! … Press enter to continue"; 0.160: "Update available · … enter continue · esc skip".
// Live only while every "›" row after the latest header is one of its own options: a later prompt
// or another menu (e.g. directory trust) means the update rows are scrollback or quoted history.
function codexNeedsUpdateSkip(captureOutput: string): boolean {
  const header = [...captureOutput.matchAll(/Update available/gi)].at(-1);
  if (header?.index === undefined) return false;
  const menu = captureOutput.slice(header.index);
  return /^[^\S\n]*(?:›[^\S\n]*)?2\.\s*Skip\b/im.test(menu)
    && [...menu.matchAll(/^[^\S\n]*›.*$/gm)].every((row) => /^[^\S\n]*›[^\S\n]*\d+\.\s*(?:Update now|Skip)\b/.test(row[0]));
}

// Codex >=0.163 "Folder access": an untrusted git repository asks once before the prompt. Live only while every "›" row
// after the latest header is one of its own numbered options: a later composer, or the update/hooks menus that
// can follow it, mean these rows are scrollback.
function codexFolderScreen(captureOutput: string): string | undefined {
  const header = [...captureOutput.matchAll(/^[^\S\n]*Folder access[^\S\n]*$/gm)].at(-1);
  if (header?.index === undefined) return undefined;
  const screen = captureOutput.slice(header.index);
  const rows = [...screen.matchAll(/^[^\S\n]*›.*$/gm)];
  return rows.length > 0 && rows.every((row) => /^[^\S\n]*›[^\S\n]*\d+\.\s/.test(row[0]))
    && !/Update available|Press t to trust all|Press space or enter to toggle/i.test(screen)
    ? screen : undefined;
}

// Enter is safe only on "1. Trust and continue". Never match row 2 ("Quit", or "Back to Agent Command Center" on a
// shared daemon) or the footer, and never the "Open restricted" screen shown for a root marked untrusted.
function codexFolderTrust(screen: string): boolean {
  const rows = [...screen.matchAll(/^[^\S\n]*›.*$/gm)];
  return /Trust\s+this\s+folder\?/.test(screen)
    && rows.length === 1 && /^›[^\S\n]+1\.[^\S\n]+Trust and continue[^\S\n]*$/.test(rows[0][0]);
}

// The root Codex says it trusts: the line after "…repository root:" (shown only inside a subdirectory or linked
// worktree), else the directory under the header. A long path hard-wraps with an indent, so rows are joined with "".
// The path ends at a blank line or at the question: a screen taller than the pane loses its blank lines.
// ponytail: a path wrapped at a space loses that space; the note is for the reader, nothing parses it.
function codexFolderRoot(screen: string): string {
  const lines = screen.split("\n");
  const note = lines.findIndex((line) => /\broot:\s*$/.test(line));
  const root: string[] = [];
  for (const line of lines.slice(note < 0 ? 1 : note + 1)) {
    if (!line.trim() || /^\s*Trust\s+this\s+folder\?/.test(line)) break;
    root.push(line.trim());
  }
  return root.join("") || "unknown";
}

function codexIsStarting(captureOutput: string): boolean {
  return captureOutput.includes("Starting MCP servers");
}

// The live in-turn spinner. Work rows ("• Ran …") stay on screen after the turn.
function codexSpinnerVisible(captureOutput: string): boolean {
  return captureOutput.includes("Working (")
    // Codex >=0.145 in-turn spinner, e.g. "Starting MCP servers (2/3): codex_apps (5s • esc to interrupt)".
    || /\(\d+[hms](?:\s+\d+[ms])?\s*•\s*esc to interrupt\)/i.test(captureOutput);
}

function codexHasStartedTask(captureOutput: string): boolean {
  return codexSpinnerVisible(captureOutput)
    || /\n\s*• (Reading|Explored|Using|Ran|Updated|Edited|Searching|Checked|Inspecting|Analyzing|Planning|Summarizing|Opened)\b/.test(captureOutput);
}

// The free-form question view also draws a "›" row ("› Type your answer") with
// "enter to submit answer | esc to interrupt" below it; text sent there becomes
// the answer. Only the rows below the last "›" count: a finished reply above
// may quote the same words.
function codexInputHasOtherFocus(captureOutput: string): boolean {
  const latest = [...captureOutput.matchAll(/^\s*›(?:\s+.*)?$/gmu)].at(-1);
  if (latest?.index === undefined) return false;
  return /esc to interrupt|enter to submit answer/i.test(captureOutput.slice(latest.index + latest[0].length));
}

function codexComposerReady(captureOutput: string): boolean {
  return codexHasInputPrompt(captureOutput)
    && !codexNeedsPromptNudge(captureOutput)
    && !codexNeedsHooksTrustEscape(captureOutput)
    && !codexNeedsUpdateSkip(captureOutput)
    && !codexInputHasOtherFocus(captureOutput);
}

function codexHasUnsupportedModelError(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !codexHasStartedTask(captureOutput)
    && /(?:^|\n)\s*(?:■|ERROR:)[\s\S]{0,1000}?model\s+is\s+not\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account/i.test(captureOutput);
}

// Codex draws "›" at column 0 only on a user turn's first row (and the composer); continuation rows are indented,
// so a literal "›" inside a message or draft must not count as a turn.
function userTurnMatches(captureOutput: string) {
  return [...captureOutput.matchAll(/^›\s+\S.*$/gmu)];
}

function codexModelStopReason(segment: string): string | undefined {
  // Inspect the latest error only. Earlier tool bullets/spinners belong to the
  // failed attempt; evidence after the error means it recovered or is retrying.
  const error = [...segment.matchAll(/^[■⚠][^\n]*$/gm)].at(-1);
  if (error?.index === undefined) return;
  // Codex 0.154 uses a warning cell for capacity; other warnings can be retries.
  const reason = /^[■⚠][^\S\r\n]+Selected model is at capacity\.(?:\s|$)/i.test(error[0]) ? "model_capacity"
    : /^■[^\S\r\n]+(?:Usage limit reached|You've hit your usage limit)\b/i.test(error[0]) ? "usage_limit"
    : undefined;
  if (!reason) return;
  const after = segment.slice(error.index + error[0].length);
  if (codexHasStartedTask(after) || /esc to interrupt/i.test(after)) return;
  // Require the idle composer after the error, never a numbered menu row.
  // Do not call codexHasInputPrompt here: it depends on turn outcome detection.
  const composer = [...after.matchAll(/^›[^\S\n]*[^\n]*$/gm)].at(-1);
  if (!composer || /^›[\t ]*\d+\.\s/.test(composer[0])) return;
  return reason;
}

function codexTurnOutcome(segment: string): DetectedOutcome {
  const outcome = detectSentinelOutcome(segment);
  if (outcome.status !== "running") return outcome;
  if (codexHasUnsupportedModelError(segment)) return { status: "error", needHelpTags: null };
  const reason = codexModelStopReason(segment);
  return reason ? { status: "needs_attention", needHelpTags: null, reason } : outcome;
}

function codexTurnEvidence(segment: string): "working" | Exclude<DetectedStatus, "running"> | null {
  const outcome = codexTurnOutcome(segment);
  if (outcome.status !== "running") return outcome.status;
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
  // The last "›" row is normally the idle composer, so step back over it at most once: a new task turn with no
  // reply yet must never fall back to an older turn's DONE/NEED_HELP (that reclaimed a resumed helper mid-task).
  // ponytail: under non-default tui.raw_output_mode a column-0 literal "›" printed after the sentinel delays
  // settlement to needs_attention (safe); add a structural turn boundary if raw mode is ever used for helpers.
  const candidates = turns.slice(-2);
  for (let index = candidates.length - 1; index >= 0; index--) {
    const turn = candidates[index];
    if (turn.index === undefined) continue;
    const end = candidates[index + 1]?.index ?? captureOutput.length;
    if (codexTurnEvidence(captureOutput.slice(turn.index, end))) {
      return captureOutput.slice(turn.index);
    }
  }
  // With only the composer on screen the task row scrolled out, so the whole capture is the current turn.
  return candidates.length === 2 && candidates[0].index !== undefined
    ? captureOutput.slice(candidates[0].index)
    : captureOutput;
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
  // ponytail: a numbered latest "›" row is always treated as a live menu (typing could pick an option) and an older
  // "›" above it never counts. Startup composers are empty, so a numbered draft only costs a safe timeout.
  if (/^\s*›\s+\d+\.\s/.test(latest[0])) return false;
  return !codexTurnEvidence(captureOutput.slice(latest.index));
}

async function waitForCodexInput(sessionId: string, runtime: DriverRuntime): Promise<StartupNotes | undefined> {
  let nudged = false;
  let updateSkipped = false;
  let trustedRoot: string | undefined;
  let hooksSkipped = false;
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
    // Before the hooks check, whose pattern matches anywhere in the capture: an answered hooks screen in scrollback
    // above a live Folder access screen must not turn into Escape, which quits or goes back there instead of Enter.
    // Hooks text below the header makes the Folder screen not live (codexFolderScreen), so the hooks check still runs then.
    const folder = codexFolderScreen(recentOutput);
    if (folder) {
      // Never fall through while the screen is live, whatever is highlighted: a later Enter nudge could pick row 2.
      // Accepted in every mode: helpers run with the host's permissions by design (see docs/security.md).
      if (!trustedRoot && codexFolderTrust(folder)) {
        await runtime.sendKey(sessionId, "Enter");
        trustedRoot = codexFolderRoot(folder);
      }
      continue;
    }
    // Not gated on `nudged`: the trust flow can need one Escape per screen.
    if (codexNeedsHooksTrustEscape(recentOutput)) {
      await runtime.sendKey(sessionId, "Escape");
      hooksSkipped = true;
      continue;
    }
    if (codexNeedsUpdateSkip(recentOutput)) {
      // Never fall through while the menu is live: Enter would accept "1. Update now".
      if (!updateSkipped) await runtime.sendKeys(sessionId, "2");
      updateSkipped = true;
      continue;
    }
    if (!nudged && codexNeedsPromptNudge(recentOutput)) {
      await runtime.sendKeys(sessionId, "");
      nudged = true;
      continue;
    }
    if (codexHasInputPrompt(recentOutput)) {
      if (!trustedRoot && !hooksSkipped) return undefined;
      const notes: StartupNotes = {};
      if (trustedRoot) notes.codexTrust = trustedRoot;
      if (hooksSkipped) notes.codexHooksSkipped = true;
      return notes;
    }
  }
  const startupNote = startingPolls > 0 ? ` (waited ${startingPolls}s in MCP startup)` : "";
  // Codex saved the trust when Enter was pressed, whatever happens next: say so, the rollback discards the note.
  const trustNote = trustedRoot ? `; ${codexTrustNote(trustedRoot)}` : "";
  throw new Error(`Codex session ${sessionId} did not reach its input prompt${startupNote}${trustNote}`);
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

function sessionDir(opts: LaunchOptions & { sessionId: string }): string {
  return opts.deliveryDir ?? defaultRuntimeLayout.sessionDeliveryDir(opts.cwd, opts.sessionId);
}

function notifyArgs(opts: LaunchOptions & { resumeId?: string }): string[] {
  if (!opts.sessionId) return [];
  const command = turnHookCommand(sessionDir({ ...opts, sessionId: opts.sessionId }), "codex", opts.resumeId);
  // JSON string arrays are valid TOML basic-string arrays; shell-quote once.
  return ["-c", shellEscape(`notify=${JSON.stringify(command)}`)];
}

// A linked worktree's results live in the main checkout, outside the
// workspace-write sandbox; without this a safe helper cannot write its summary.
function resultDirArgs(opts: LaunchOptions): string[] {
  if (!opts.safe || !opts.sessionId) return [];
  const dir = sessionDir({ ...opts, sessionId: opts.sessionId });
  return dir === join(opts.cwd, ".ahelpa", opts.sessionId) ? [] : ["--add-dir", shellEscape(dir)];
}

export const codexDriver: AgentDriver = {
  checkReadiness: checkCodexReadiness,
  name: "codex",
  sessionPrefix: "codex",
  launchProfiles: {
    defaultRole: "worker",
    profiles: {
      worker: { model: "gpt-6-astra", effort: "medium" },
      reviewer: { model: "gpt-6-astra", effort: "medium" },
    },
  },
  resumeTokenAvailableAfterSubmit: false,
  modelCatalog: {
    models: [
      { name: "gpt-6.1-sol", efforts: CODEX_MAX_EFFORTS, defaultEffort: "medium" },
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

  turnHooks: true,

  buildLaunchCommand(opts: LaunchOptions): string {
    const cwd = resolve(opts.cwd);
    const capabilities = getCodexCapabilities(cwd);
    const executable = capabilities.executable ? shellEscape(capabilities.executable) : "codex";
    // Shared servers outlive terminal clients. Keep supported Codex versions
    // inside ahelpa's tmux lifecycle, including sessions without effort overrides.
    const args = [...postureArgs(opts.safe), ...resultDirArgs(opts), ...modelArgs(opts), ...notifyArgs(opts), ...(capabilities.noDaemon ? ["--no-daemon"] : [])];
    return `cd ${shellEscape(cwd)} && ${executable} ${args.join(" ")}`;
  },

  buildResumeCommand(opts: ResumeOptions): string {
    const cwd = resolve(opts.cwd);
    const capabilities = getCodexCapabilities(cwd);
    const executable = capabilities.executable ? shellEscape(capabilities.executable) : "codex";
    const args = [...postureArgs(opts.safe), ...resultDirArgs(opts), ...modelArgs(opts), ...notifyArgs(opts), ...(capabilities.noDaemon ? ["--no-daemon"] : [])];
    return `cd ${shellEscape(cwd)} && ${executable} resume ${shellEscape(opts.resumeId)} ${args.join(" ")}`;
  },

  extractResumeToken(captureOutput: string): string | null {
    const match = captureOutput.match(/codex resume\s+(\S+)/);
    return match?.[1] ?? null;
  },

  prepareForTask(sessionId: string, runtime: DriverRuntime) {
    return waitForCodexInput(sessionId, runtime);
  },

  prepareForResume(sessionId: string, runtime: DriverRuntime) {
    return waitForCodexInput(sessionId, runtime);
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
    return codexDriver.detectOutcome(captureOutput).status;
  },

  detectOutcome(captureOutput: string) {
    return codexTurnOutcome(currentTurnOutput(captureOutput));
  },

  detectActivity(captureOutput: string): "working" | "booting" | "idle" {
    const current = currentTurnOutput(captureOutput);
    if (codexHasStartedTask(current)) return "working";
    if (codexIsStarting(current)) return "booting";
    // Config banner visible = CLI just opened, not yet ready
    if (/OpenAI Codex/i.test(current)) return "booting";
    return "idle";
  },

  acceptsInput(captureOutput: string): boolean {
    return codexComposerReady(captureOutput) && !codexHasStartedTask(captureOutput);
  },

  // After a turn end from a verified main thread the work rows above the
  // composer are history: of 399 archived end-of-turn panes, 204 still showed
  // one. Only the live spinner means the turn is still going. (While a reply
  // streams Codex hides the spinner, so this is not safe without that event.)
  acceptsInputAfterTurn(captureOutput: string): boolean {
    return codexComposerReady(captureOutput) && !codexSpinnerVisible(captureOutput);
  },

  workingAfterTurn: codexSpinnerVisible,

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    // Exiting prints the resume command; Escape only dismisses UI elements.
    await runtime.sendKeys(sessionId, "/exit");
  },
};
