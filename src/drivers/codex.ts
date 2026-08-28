import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions, TaskSubmissionContext } from "./types";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelStatus } from "./sentinels";
import { findModelChoice, waitForOutput } from "./model-menu";

function codexNeedsSubmitNudge(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !captureOutput.includes("Working (");
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
    || /\n\s*• (Reading|Explored|Using|Ran|Updated|Edited|Searching|Checked|Inspecting|Analyzing|Planning|Summarizing|Opened)\b/.test(captureOutput);
}

function userTurnMatches(captureOutput: string) {
  return [...captureOutput.matchAll(/^\s*›\s+\S.*$/gmu)];
}

function codexTurnEvidence(segment: string): "working" | "idle" | "error" | null {
  const settled = detectSentinelStatus(segment);
  if (settled !== "running") return settled;
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

function codexHasInputPrompt(captureOutput: string): boolean {
  const prompts = [...captureOutput.matchAll(/^\s*›(?:\s+.*)?$/gmu)];
  const latest = prompts.at(-1);
  if (latest?.index === undefined) return false;
  return !codexTurnEvidence(captureOutput.slice(latest.index));
}

async function waitForCodexInput(sessionId: string, runtime: DriverRuntime): Promise<void> {
  let nudged = false;

  await runtime.sleep(2000);
  for (let attempt = 0; attempt < 20; attempt++) {
    await runtime.sleep(1000);
    const recentOutput = await runtime.capture(sessionId, 20);
    if (codexIsStarting(recentOutput)) continue;
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
  throw new Error(`Codex session ${sessionId} did not reach its input prompt`);
}

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

function postureArgs(safe?: boolean): string[] {
  return safe
    ? ["-s", "workspace-write", "-a", "never"]
    : ["--dangerously-bypass-approvals-and-sandbox"];
}

function modelArgs(opts: { model?: string; effort?: string }): string[] {
  const args: string[] = [];
  if (opts.model) args.push("--model", shellEscape(opts.model));
  if (opts.effort) args.push("-c", shellEscape(`model_reasoning_effort=${JSON.stringify(opts.effort)}`));
  return args;
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

function snapshotCodexConfig(): { path: string; content: string } | null {
  const path = codexConfigPath();
  return existsSync(path) ? { path, content: readFileSync(path, "utf-8") } : null;
}

function reasoningKey(effort?: string): string {
  switch ((effort || "").toLowerCase().replace(/[-_\s]+/g, "")) {
    case "":
      return "Enter";
    case "low":
      return "1";
    case "medium":
    case "default":
      return "2";
    case "high":
      return "3";
    case "xhigh":
    case "extrahigh":
      return "4";
    default:
      throw new Error(`Unsupported Codex effort: ${effort}`);
  }
}

export const codexDriver: AgentDriver = {
  name: "codex",
  sessionPrefix: "codex",
  resumeTokenAvailableAfterSubmit: false,
  modelCatalog: {
    models: [
      { name: "gpt-5.5", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.4", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.4-mini", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.3-codex-spark", efforts: CODEX_EFFORTS, defaultEffort: "high" },
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
      if (codexHasStartedTask(current) || detectSentinelStatus(current) !== "running") {
        return true;
      }
    }
    return false;
  },

  async switchModel(sessionId: string, runtime: DriverRuntime, opts: ModelSwitchOptions): Promise<string> {
    const configSnapshot = opts.persist ? null : snapshotCodexConfig();
    try {
      await runtime.sendKeys(sessionId, "/model");
      const menu = await waitForOutput(
        sessionId,
        runtime,
        (output) => output.includes("Select Model and Effort"),
        "Codex model menu",
      );
      const target = findModelChoice(menu, opts.model);
      await runtime.sendKey(sessionId, target.number);

      const next = await waitForOutput(
        sessionId,
        runtime,
        (output) => output.includes("Select Reasoning Level") || /Model changed to/i.test(output),
        "Codex reasoning menu",
      );
      if (next.includes("Select Reasoning Level")) {
        await runtime.sendKey(sessionId, reasoningKey(opts.effort));
      }

      const result = await waitForOutput(
        sessionId,
        runtime,
        (output) => /Model changed to/i.test(output),
        "Codex model switch confirmation",
      );
      return result.split("\n").find((line) => /Model changed to/i.test(line))?.trim()
        ?? `Model changed to ${opts.model}`;
    } finally {
      if (configSnapshot) writeFileSync(configSnapshot.path, configSnapshot.content);
    }
  },

  detectStatus(captureOutput: string): DetectedStatus {
    return detectSentinelStatus(currentTurnOutput(captureOutput));
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
    await runtime.sendKey(sessionId, "Escape");
  },
};
