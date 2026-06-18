import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ResumeOptions } from "./types.ts";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelStatus } from "./sentinels";

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

  detectStatus(captureOutput: string): DetectedStatus {
    return detectSentinelStatus(captureOutput);
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKey(sessionId, "Escape");
  },
};
