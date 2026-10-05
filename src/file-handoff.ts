import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SENTINEL } from "./drivers/sentinels";
import { defaultRuntimeLayout, RuntimeLayout } from "./runtime-layout";

const TASK_INSTRUCTION_PREFIX = "Please read and complete the task described in";

export interface FileHandoffPlan {
  taskFilePath: string;
  projectDeliveryDir: string;
  sessionDeliveryDir: string;
  summaryPath: string;
  artifactsDir: string;
  taskInstruction: string;
}

export function planFileHandoff(
  projectPath: string,
  sessionId: string,
  layout: RuntimeLayout = defaultRuntimeLayout,
): FileHandoffPlan {
  const projectDeliveryDir = layout.projectDeliveryDir(projectPath);
  const sessionDeliveryDir = join(projectDeliveryDir, sessionId);
  const summaryPath = join(sessionDeliveryDir, "summary.md");
  const artifactsDir = join(sessionDeliveryDir, "artifacts");
  const taskFilePath = layout.taskFilePath(sessionId);

  return {
    taskFilePath,
    projectDeliveryDir,
    sessionDeliveryDir,
    summaryPath,
    artifactsDir,
    taskInstruction: buildTaskInstruction({ taskFilePath, sessionDeliveryDir, summaryPath, artifactsDir }),
  };
}

export function prepareFileHandoff(plan: FileHandoffPlan, task: string): void {
  mkdirSync(dirname(plan.taskFilePath), { recursive: true });
  mkdirSync(plan.artifactsDir, { recursive: true });
  writeFileSync(plan.taskFilePath, `${task}\n\n---\n\n## ahelpa signals\n\n${[
    `Print the applicable signal alone on a line: finished output ${SENTINEL.Done}; stuck output ${SENTINEL.NeedHelp}.`,
    `If you are blocked because an external review (auto-review/auto mode/sandbox) or project rule/validator refused an action, do not bypass it: first write the refused action and verbatim refusal into ${plan.summaryPath}, then output [AHELPA:NEED_HELP:review].`,
    `Legitimate in-task recovery from a refusal does not require stopping.`,
    `For a missing/truncated/contradictory task output [AHELPA:NEED_HELP:input]; for both output [AHELPA:NEED_HELP:review,input].`,
    `Punctuation after a signal is not part of it. If writing the summary fails, still print the signal.`,
  ].join("\n")}\n`);
}

// ponytail: TUI input ceiling is HEAD + 60 chars; Claude truncated ~1.2k but accepted ~0.6k, so details belong in the task file.
export function buildTaskInstruction(paths: Pick<FileHandoffPlan, "taskFilePath" | "sessionDeliveryDir" | "summaryPath" | "artifactsDir">): string {
  return [
    `${TASK_INSTRUCTION_PREFIX} ${paths.taskFilePath}.`,
    `Use ${paths.sessionDeliveryDir} as your result directory.`,
    `For any written result, create ${paths.summaryPath} and put supporting artifacts under ${paths.artifactsDir}.`,
    `When you are finished, output ${SENTINEL.Done} on its own line.`,
    `If you are stuck and need help, output ${SENTINEL.NeedHelp} on its own line.`,
    `Tags: see the end of the task file.`,
  ].join(" ");
}

export function isTaskInstructionEcho(captureOutput: string): boolean {
  return captureOutput.includes(TASK_INSTRUCTION_PREFIX);
}
