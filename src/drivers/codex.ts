import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions } from "./types.ts";
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

  buildLaunchCommand(opts: LaunchOptions): string {
    const args = opts.safe ? "-s workspace-write -a never" : "--dangerously-bypass-approvals-and-sandbox";
    return `cd ${shellEscape(opts.cwd)} && codex ${args}`;
  },

  buildResumeCommand(opts: ResumeOptions): string {
    const args = opts.safe ? "-s workspace-write -a never" : "--dangerously-bypass-approvals-and-sandbox";
    return `cd ${shellEscape(opts.cwd)} && codex resume ${shellEscape(opts.resumeId)} ${args}`;
  },

  extractResumeToken(captureOutput: string): string | null {
    const match = captureOutput.match(/codex resume\s+(\S+)/);
    return match?.[1] ?? null;
  },

  async prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void> {
    let nudged = false;

    await runtime.sleep(2000);
    for (let attempt = 0; attempt < 12; attempt++) {
      await runtime.sleep(1000);
      const recentOutput = await runtime.capture(sessionId, 20);
      if (codexHasStartedTask(recentOutput)) {
        break;
      }
      if (codexIsStarting(recentOutput)) {
        continue;
      }
      if (!nudged && codexNeedsUpdateSkip(recentOutput)) {
        await runtime.sendKeys(sessionId, "2");
        nudged = true;
        continue;
      }
      if (
        !nudged
        && (codexNeedsSubmitNudge(recentOutput) || codexNeedsPromptNudge(recentOutput))
      ) {
        await runtime.sendKeys(sessionId, "");
        nudged = true;
      }
    }
  },

  async afterTaskSubmitted(): Promise<void> {
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
    return detectSentinelStatus(captureOutput);
  },

  isWorking(captureOutput: string): boolean {
    if (codexHasStartedTask(captureOutput)) return true;
    if (codexIsStarting(captureOutput)) return true;
    return false;
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKey(sessionId, "Escape");
  },
};
