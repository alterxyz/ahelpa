import type {
  AgentDriver,
  DetectedStatus,
  DriverRuntime,
  LaunchOptions,
  ModelSwitchOptions,
  ResumeOptions,
  TaskSubmissionContext,
} from "./types";
import { shellEscape } from "../shell";
import { detectSentinelStatus } from "./sentinels";

const KIMI_BOXED_PROMPT = /^\s*│\s*>\s*│\s*$/gmu;
const KIMI_SESSION = /^\s*│\s*Session:\s+(session_[A-Za-z0-9._-]+)\s*│\s*$/m;
const KIMI_RESUME_HINT = /To resume this session:\s+kimi\s+-r\s+(session_[A-Za-z0-9._-]+)/m;

function postureArgs(safe?: boolean): string[] {
  return safe ? [] : ["--yolo"];
}

function modelArgs(opts: { model?: string; effort?: string }): string[] {
  if (opts.effort) {
    throw new Error(
      "Kimi does not support --effort; configure the Kimi Code model alias separately",
    );
  }

  return opts.model ? ["--model", shellEscape(opts.model)] : [];
}

function lastEmptyPromptIndex(captureOutput: string): number {
  KIMI_BOXED_PROMPT.lastIndex = 0;
  let lastIndex = -1;
  for (const match of captureOutput.matchAll(KIMI_BOXED_PROMPT)) {
    lastIndex = match.index;
  }
  return lastIndex;
}

interface PositionedSignal {
  index: number;
  kind: "generation" | "attention" | "prompt" | "sentinel";
}

interface PositionedSentinel extends PositionedSignal {
  kind: "sentinel";
  status: Exclude<DetectedStatus, "running">;
}

function generationSignals(captureOutput: string): Array<{ index: number; text: string }> {
  return [...captureOutput.matchAll(
    /\b(?:thinking|working)\.\.\.|\bRetrying\s*\(\d+\/\d+\)|^\s*[🌑🌒🌓🌔🌕🌖🌗🌘](?:\s|$)/gimu,
  )].map((match) => ({ index: match.index, text: match[0].trim() }));
}

function lastGeneratingIndex(captureOutput: string): number {
  return generationSignals(captureOutput).at(-1)?.index ?? -1;
}

function lastActiveToolUseIndex(captureOutput: string): number {
  const matches = [...captureOutput.matchAll(/^\s*[●•]\s+Using\s+\S.*$/gmu)];
  return matches.at(-1)?.index ?? -1;
}

function lastApprovalPromptIndex(captureOutput: string): number {
  const matches = [...captureOutput.matchAll(
    /^\s*[▶›❯]\s*(?:Run this command\?|Write this file\?|Apply these edits\?|Stop this task\?|Ready to build with this plan\?|Approve .+\?)\s*$/gimu,
  )];
  return matches.at(-1)?.index ?? -1;
}

function kimiNeedsFolderTrust(captureOutput: string): boolean {
  return captureOutput.includes("Trust this folder?")
    && captureOutput.includes("Don't trust");
}

function lastQuestionPromptIndex(captureOutput: string): number {
  const questionHeading = [...captureOutput.matchAll(
    /^\s*(?:[▶›❯]\s*)?question\s*$/gimu,
  )].at(-1)?.index ?? -1;
  const questionBody = [...captureOutput.matchAll(
    /^\s*(?:[▶›❯]\s*)?\?\s+\S.*$/gmu,
  )].at(-1)?.index ?? -1;
  const questionCancel = [...captureOutput.matchAll(/esc\s+cancel/gimu)].at(-1)?.index ?? -1;
  const interactiveQuestion = questionHeading >= 0 && questionBody >= 0 && questionCancel >= 0
    ? Math.max(questionHeading, questionBody, questionCancel)
    : -1;
  const review = [...captureOutput.matchAll(
    /Review your answer before submit|Ready to submit your answers\?/gimu,
  )].at(-1)?.index ?? -1;
  return Math.max(interactiveQuestion, review);
}

function lastAttentionPromptIndex(captureOutput: string): number {
  return Math.max(
    lastApprovalPromptIndex(captureOutput),
    lastQuestionPromptIndex(captureOutput),
  );
}

function latestSentinel(captureOutput: string): PositionedSentinel | null {
  const matches = [...captureOutput.matchAll(
    /^\s*(?:[-•●⏺]\s*)?\[AHELPA:(DONE|NEED_HELP)\]\s*$/gmu,
  )];
  const latest = matches.at(-1);
  if (!latest) return null;
  return {
    index: latest.index,
    kind: "sentinel",
    status: latest[1] === "NEED_HELP" ? "error" : "idle",
  };
}

function latestTurnEvidence(captureOutput: string): PositionedSignal | PositionedSentinel | null {
  const signals: Array<PositionedSignal | PositionedSentinel> = [];
  const generationIndex = lastGeneratingIndex(captureOutput);
  const attentionIndex = lastAttentionPromptIndex(captureOutput);
  const promptIndex = lastEmptyPromptIndex(captureOutput);
  const sentinel = latestSentinel(captureOutput);
  if (generationIndex >= 0) signals.push({ index: generationIndex, kind: "generation" });
  if (attentionIndex >= 0) signals.push({ index: attentionIndex, kind: "attention" });
  if (promptIndex >= 0) signals.push({ index: promptIndex, kind: "prompt" });
  if (sentinel) signals.push(sentinel);
  return signals.sort((left, right) => left.index - right.index).at(-1) ?? null;
}

function kimiHasActiveToolUse(captureOutput: string): boolean {
  const toolUseIndex = lastActiveToolUseIndex(captureOutput);
  if (toolUseIndex < 0) return false;
  // Kimi keeps the boxed composer visible while a tool is executing, so that
  // prompt is not an idle signal. A later sentinel or attention panel does
  // settle/suspend the tool use, and prevents historical `Using ...` output
  // from keeping a resumed session busy forever.
  return toolUseIndex > Math.max(
    latestSentinel(captureOutput)?.index ?? -1,
    lastAttentionPromptIndex(captureOutput),
  );
}

function kimiIsGenerating(captureOutput: string): boolean {
  return kimiHasActiveToolUse(captureOutput)
    || latestTurnEvidence(captureOutput)?.kind === "generation";
}

function kimiIsReady(captureOutput: string): boolean {
  return !kimiHasActiveToolUse(captureOutput)
    && latestTurnEvidence(captureOutput)?.kind === "prompt";
}

function extractSessionId(captureOutput: string): string | null {
  return captureOutput.match(KIMI_SESSION)?.[1]
    ?? captureOutput.match(KIMI_RESUME_HINT)?.[1]
    ?? null;
}

function currentTurnOutput(captureOutput: string): string {
  const turns = [...captureOutput.matchAll(/^\s*✨\s/gmu)];
  const latest = turns.at(-1);
  return latest?.index === undefined ? captureOutput : captureOutput.slice(latest.index);
}

function userTurns(captureOutput: string): string[] {
  return [...captureOutput.matchAll(/^\s*✨\s+.*$/gmu)]
    .map((match) => match[0].trim());
}

function hasNewUserTurn(beforeOutput: string, captureOutput: string): boolean {
  const beforeTurns = userTurns(beforeOutput);
  const currentTurns = userTurns(captureOutput);
  if (currentTurns.length > beforeTurns.length) return true;
  const beforeLatest = beforeTurns.at(-1);
  const currentLatest = currentTurns.at(-1);
  return currentLatest !== undefined && currentLatest !== beforeLatest;
}

function hasNewTurnEvidence(beforeOutput: string, captureOutput: string): boolean {
  if (hasNewUserTurn(beforeOutput, captureOutput)) return true;

  // Kimi keeps an approval/question answer inside the same `✨` turn. A
  // repeated task can also slide the old turn out of an 80-line capture while
  // preserving the exact same `✨` text. In both cases the reliable evidence
  // is a settled/attention snapshot transitioning to a newer generation
  // signal, not a changed prompt string.
  const beforeCurrent = currentTurnOutput(beforeOutput);
  const current = currentTurnOutput(captureOutput);
  const beforeEvidence = latestTurnEvidence(beforeCurrent);
  const beforeWasWaiting = beforeEvidence?.kind === "attention"
    || beforeEvidence?.kind === "prompt"
    || beforeEvidence?.kind === "sentinel";
  if (beforeWasWaiting && kimiIsGenerating(current)) return true;
  // A very fast approval/question continuation can finish before the first
  // 500ms probe, so no generation frame is observable between panel and DONE.
  if (!beforeWasWaiting) return false;
  const beforeSentinel = latestSentinel(beforeCurrent);
  const currentSentinel = latestSentinel(current);
  if (!currentSentinel) return false;
  const sentinelChanged = !beforeSentinel || beforeSentinel.status !== currentSentinel.status;
  // A retained approval panel followed by an old DONE can remain visible
  // behind the boxed composer. Position alone cannot prove a new submission:
  // the sentinel itself must be new (or have changed outcome) relative to the
  // pre-submit snapshot.
  return sentinelChanged;
}

async function waitForKimiInput(sessionId: string, runtime: DriverRuntime): Promise<void> {
  let handledTrust = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await runtime.sleep(1000);
    const recentOutput = await runtime.capture(sessionId, 60);
    if (kimiIsReady(recentOutput)) return;
    if (!handledTrust && kimiNeedsFolderTrust(recentOutput)) {
      await runtime.sendKey(sessionId, "Up");
      await runtime.sendKeys(sessionId, "");
      handledTrust = true;
    }
  }
  throw new Error(`Kimi session ${sessionId} did not reach its input prompt`);
}

export const kimiDriver: AgentDriver = {
  name: "kimi",
  sessionPrefix: "kimi",
  resumeTokenAvailableAfterSubmit: true,
  modelCatalog: {
    models: [],
    effortNote: "models are dynamic; pass a configured Kimi Code model alias via --model; --effort is not supported",
  },

  buildLaunchCommand(opts: LaunchOptions): string {
    const args = [...postureArgs(opts.safe), ...modelArgs(opts)];
    const suffix = args.length ? ` ${args.join(" ")}` : "";
    return `cd ${shellEscape(opts.cwd)} && KIMI_CODE_NO_AUTO_UPDATE=1 kimi${suffix}`;
  },

  buildResumeCommand(opts: ResumeOptions): string {
    const args = ["--session", shellEscape(opts.resumeId), ...postureArgs(opts.safe), ...modelArgs(opts)];
    return `cd ${shellEscape(opts.cwd)} && KIMI_CODE_NO_AUTO_UPDATE=1 kimi ${args.join(" ")}`;
  },

  extractResumeToken(captureOutput: string): string | null {
    return extractSessionId(captureOutput);
  },

  async prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await waitForKimiInput(sessionId, runtime);
  },

  async prepareForResume(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await waitForKimiInput(sessionId, runtime);
  },

  async afterTaskSubmitted(
    sessionId: string,
    runtime: DriverRuntime,
    context?: TaskSubmissionContext,
  ): Promise<boolean> {
    const beforeOutput = context?.beforeOutput;
    for (let attempt = 0; attempt < 10; attempt++) {
      await runtime.sleep(500);
      const recentOutput = await runtime.capture(sessionId, 80);
      if (!extractSessionId(recentOutput)) continue;

      if (beforeOutput !== undefined) {
        if (hasNewTurnEvidence(beforeOutput, recentOutput)) return true;
        continue;
      }

      // A caller without a pre-submit snapshot still must not accept an old
      // settled turn merely because a resumed pane already has a session ID.
      if (detectSentinelStatus(currentTurnOutput(recentOutput)) === "running") return true;
    }
    return false;
  },

  async switchModel(
    _sessionId: string,
    _runtime: DriverRuntime,
    _opts: ModelSwitchOptions,
  ): Promise<string> {
    throw new Error(
      "Kimi runtime model switching is not supported; launch or resume with --model <configured-alias> instead",
    );
  },

  detectStatus(captureOutput: string): DetectedStatus {
    // Resumed Kimi panes include earlier turns. Only the latest user turn may
    // settle the new ahelpa session; an old DONE must not end it immediately.
    const current = currentTurnOutput(captureOutput);
    const sentinel = latestSentinel(current);
    // A host answer to NEED_HELP stays in the same `✨` turn. Once Kimi emits
    // newer generation evidence, the historical sentinel is no longer the
    // state of the live turn.
    const latestGeneration = Math.max(
      lastGeneratingIndex(current),
      lastActiveToolUseIndex(current),
    );
    if (sentinel && sentinel.index > latestGeneration) return sentinel.status;
    return "running";
  },

  detectActivity(captureOutput: string): "working" | "booting" | "idle" {
    const current = currentTurnOutput(captureOutput);
    if (kimiNeedsFolderTrust(current)) return "booting";
    if (kimiHasActiveToolUse(current)) return "working";
    const evidence = latestTurnEvidence(current);
    if (evidence?.kind === "generation") return "working";
    if (evidence) return "idle";
    if (current.includes("Welcome to Kimi Code!")) return "booting";
    return "idle";
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKeys(sessionId, "/exit");
  },
};
