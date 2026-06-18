import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions } from "./types.ts";
import { isTaskInstructionEcho } from "../file-handoff";
import { shellEscape } from "../shell";
import { detectSentinelStatus, hasInlineSentinel } from "./sentinels";

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

export const claudeCodeDriver: AgentDriver = {
  name: "claude-code",
  sessionPrefix: "claude",

  buildLaunchCommand(opts: LaunchOptions): string {
    const args = opts.safe ? "--verbose" : "--dangerously-skip-permissions --verbose";
    return `cd ${shellEscape(opts.cwd)} && claude ${args}`;
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

  detectStatus(captureOutput: string): DetectedStatus {
    return detectSentinelStatus(captureOutput);
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKeys(sessionId, "/exit");
  },
};
