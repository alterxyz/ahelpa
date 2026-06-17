import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions } from "./types.ts";
import { isTaskInstructionEcho } from "../file-handoff";
import { detectSentinelStatus } from "./sentinels";

function codexNeedsSubmitNudge(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !captureOutput.includes("Working (");
}

function codexNeedsPromptNudge(captureOutput: string): boolean {
  return /Press enter to continue/i.test(captureOutput)
    || /Do you trust the contents of this directory\?/i.test(captureOutput);
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
    return `cd ${opts.cwd} && codex --dangerously-bypass-approvals-and-sandbox`;
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
};
