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
  writeFileSync(plan.taskFilePath, task);
}

export function buildTaskInstruction(paths: Pick<FileHandoffPlan, "taskFilePath" | "sessionDeliveryDir" | "summaryPath" | "artifactsDir">): string {
  return [
    `${TASK_INSTRUCTION_PREFIX} ${paths.taskFilePath}.`,
    `Use ${paths.sessionDeliveryDir} as your result directory.`,
    `For any written result, create ${paths.summaryPath} and put supporting artifacts under ${paths.artifactsDir}.`,
    `When you are finished, output ${SENTINEL.Done} on its own line.`,
    `If you are stuck and need help, output ${SENTINEL.NeedHelp} on its own line.`,
  ].join(" ");
}

export function isTaskInstructionEcho(captureOutput: string): boolean {
  return captureOutput.includes(TASK_INSTRUCTION_PREFIX);
}
