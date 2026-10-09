import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SENTINEL } from "./drivers/sentinels";
import type { HelperRole } from "./drivers/types";
import { defaultRuntimeLayout, RuntimeLayout } from "./runtime-layout";

export const TASK_INSTRUCTION_PREFIX = "Please read and complete the task described in";

export interface FileHandoffPlan {
  taskFilePath: string;
  projectDeliveryDir: string;
  sessionDeliveryDir: string;
  summaryPath: string;
  artifactsDir: string;
  // Durable copy of what the helper was asked, beside its summary. The tmp
  // task file is reclaimed with the session; this one survives for the record.
  taskCopyPath: string;
  taskInstruction: string;
}

export interface HandoffContext {
  role?: HelperRole | null;
  // Acceptance command the host will rerun on the final diff (see --check).
  check?: string | null;
  // The hand this one follows (see --after): where to read its ask and claims.
  previous?: { sessionId: string; taskCopyPath: string; summaryPath: string; artifactsDir: string } | null;
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
  const taskCopyPath = join(sessionDeliveryDir, "task.md");
  const taskFilePath = layout.taskFilePath(sessionId);

  return {
    taskFilePath,
    projectDeliveryDir,
    sessionDeliveryDir,
    summaryPath,
    artifactsDir,
    taskCopyPath,
    taskInstruction: buildTaskInstruction({ taskFilePath, sessionDeliveryDir, summaryPath, artifactsDir }),
  };
}

export function buildPreviousHandSection(previous: NonNullable<HandoffContext["previous"]>): string {
  return `## ahelpa previous hand\n\n${[
    `This task follows session ${previous.sessionId}. Before starting, read what it was asked and what it claims:`,
    `- Its task: ${previous.taskCopyPath}`,
    `- Its summary: ${previous.summaryPath}`,
    `- Its artifacts: ${previous.artifactsDir}`,
    `Treat its claims as claims. Verify what your task depends on; do not repeat its verification narrative as your own.`,
  ].join("\n")}`;
}

// Every clause targets a failure seen in archived helper sessions: "all green"
// from a cached or pre-final-edit run, summaries with no verification at all,
// tests weak enough for most mutations to survive, and reviewers that judged
// from the author's summary instead of their own run.
export function buildContractSection(
  plan: Pick<FileHandoffPlan, "summaryPath" | "artifactsDir" | "sessionDeliveryDir">,
  context: HandoffContext = {},
): string {
  const lines = [
    `Result: write ${plan.summaryPath}; put supporting files under ${plan.artifactsDir}.`,
  ];
  if (context.check) {
    lines.push(`Acceptance command (the host reruns it on your final state; make it pass or explain in summary.md why it cannot): ${context.check}`);
  }
  if (context.role === "reviewer") {
    lines.push(
      `You are reviewing, not fixing. Do not modify, create, stash, or check out any file outside ${plan.sessionDeliveryDir}; temporary mutations for testing must be restored byte-for-byte before you finish.`,
      `summary.md must state:`,
      `- Verdict first: ship, or needs rework.`,
      `- Findings with path:line, severity (P1 blocks, P2 should fix), and the concrete failure each one causes.`,
      `- Verification you ran yourself on the code under review, each command with its exit code and caches disabled (e.g. go test -count=1). The author's summary is a claim, not evidence.`,
      `- When reviewing code: at least 3 temporary mutations, which tests caught each, and that every mutation was restored.`,
      `- Not checked: list explicitly.`,
      `- Changed files: N/A.`,
    );
  } else {
    lines.push(
      `summary.md must state:`,
      `- Changed files with path:line anchors, including anything touched outside the task scope.`,
      `- Verification: each command run on the final diff, with its exit code. Disable test caches (e.g. go test -count=1). A run before your last edit does not count; rerun.`,
      `- Not done / not verified: list explicitly. "No tests run" is acceptable; "passed" without a command is not.`,
      `Rules:`,
      `- Do not change tests or assertions to fit the implementation. If an existing assertion is wrong, say so in summary.md with the reason.`,
      `- New behavior needs a test that fails without your change.`,
      `- Before signaling done: reread the full diff; remove dead code, leftovers, and debug output.`,
      `- Read-only or review tasks: write "N/A" for changed files and tests. Never edit code or tests just to satisfy this contract.`,
    );
  }
  return `## ahelpa contract\n\n${lines.join("\n")}`;
}

export function buildTaskFileContent(plan: FileHandoffPlan, task: string, context: HandoffContext = {}): string {
  const sections = [task];
  if (context.previous) sections.push(buildPreviousHandSection(context.previous));
  sections.push(buildContractSection(plan, context));
  sections.push(`## ahelpa signals\n\n${[
    `Print the applicable signal alone on a line: finished output ${SENTINEL.Done}; stuck output ${SENTINEL.NeedHelp}.`,
    `If you are blocked because an external review (auto-review/auto mode/sandbox) or project rule/validator refused an action, do not bypass it: first write the refused action and verbatim refusal into ${plan.summaryPath}, then output [AHELPA:NEED_HELP:review].`,
    `Legitimate in-task recovery from a refusal does not require stopping.`,
    `For a missing/truncated/contradictory task output [AHELPA:NEED_HELP:input]; for both output [AHELPA:NEED_HELP:review,input].`,
    `Punctuation after a signal is not part of it. If writing the summary fails, still print the signal.`,
  ].join("\n")}`);
  return `${sections.join("\n\n---\n\n")}\n`;
}

export function prepareFileHandoff(plan: FileHandoffPlan, task: string, context: HandoffContext = {}): void {
  mkdirSync(dirname(plan.taskFilePath), { recursive: true });
  mkdirSync(plan.artifactsDir, { recursive: true });
  const content = buildTaskFileContent(plan, task, context);
  writeFileSync(plan.taskFilePath, content);
  // A follow-up task must not erase the record of the first ask.
  if (existsSync(plan.taskCopyPath)) appendFileSync(plan.taskCopyPath, `\n\n===== follow-up task =====\n\n${content}`);
  else writeFileSync(plan.taskCopyPath, content);
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
