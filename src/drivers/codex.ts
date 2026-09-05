import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentDriver, DetectedStatus, DriverRuntime, LaunchOptions, ModelSwitchOptions, ResumeOptions } from "./types";
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

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
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

function codexHasUnsupportedModelError(captureOutput: string): boolean {
  return isTaskInstructionEcho(captureOutput)
    && !codexHasStartedTask(captureOutput)
    && /(?:^|\n)\s*(?:■|ERROR:)[\s\S]{0,1000}?model\s+is\s+not\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account/i.test(captureOutput);
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
  modelCatalog: {
    models: [
      { name: "gpt-5.6", efforts: CODEX_EFFORTS, defaultEffort: "low" },
      { name: "gpt-5.6-sol", efforts: CODEX_EFFORTS, defaultEffort: "low" },
      { name: "gpt-5.6-terra", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
      { name: "gpt-5.6-luna", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
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
    const model = resolveCodexModel(opts.model);
    try {
      await runtime.sendKeys(sessionId, "/model");
      const menu = await waitForOutput(
        sessionId,
        runtime,
        (output) => output.includes("Select Model and Effort"),
        "Codex model menu",
      );
      const target = findModelChoice(menu, model);
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
        ?? `Model changed to ${model}`;
    } finally {
      if (configSnapshot) writeFileSync(configSnapshot.path, configSnapshot.content);
    }
  },

  detectStatus(captureOutput: string): DetectedStatus {
    const sentinelStatus = detectSentinelStatus(captureOutput);
    if (sentinelStatus !== "running") return sentinelStatus;
    return codexHasUnsupportedModelError(captureOutput) ? "error" : "running";
  },

  detectActivity(captureOutput: string): "working" | "booting" | "idle" {
    if (codexHasStartedTask(captureOutput)) return "working";
    if (codexIsStarting(captureOutput)) return "booting";
    // Config banner visible = CLI just opened, not yet ready
    if (/OpenAI Codex/i.test(captureOutput)) return "booting";
    return "idle";
  },

  async gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void> {
    await runtime.sendKey(sessionId, "Escape");
  },
};
