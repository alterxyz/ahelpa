import { StateDB } from "../state";
import { Tmux } from "../tmux";
import { defaultWakeup } from "../wakeup";
import { getDriver } from "../drivers/registry";
import type { AgentDriver, DriverRuntime } from "../drivers/types";
import * as daemon from "../daemon";
import { getPendingLaunchNestingInfo, getMaxNestingDepth } from "../nesting";
import { mkdirSync, existsSync } from "fs";
import { defaultRuntimeLayout } from "../runtime-layout";
import { planFileHandoff, prepareFileHandoff, type FileHandoffPlan } from "../file-handoff";
import { requireAuthorizedSession } from "../session-access";
import { SESSION_STATUS } from "../session-lifecycle";

export interface LaunchInput {
  db: StateDB;
  agentType: string;
  task: string;
  projectPath: string;
  parentId: string;
  label?: string;
  safe?: boolean;
}

export interface LaunchResult {
  sessionId: string;
  ownerToken: string;
  tmuxSession: string;
}

export interface LaunchPlan {
  sessionId: string;
  ownerToken: string;
  driver: AgentDriver;
  maxDepth: number;
  depth: number;
  tmpDir: string;
  launchCmd: string;
  fileHandoff: FileHandoffPlan;
  input: LaunchInput;
}

export function planLaunch(input: LaunchInput): LaunchPlan {
  const driver = getDriver(input.agentType);
  const uuid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const sessionId = `${driver.sessionPrefix}-${uuid}`;
  const ownerToken = crypto.randomUUID().replace(/-/g, "");
  const maxDepth = getMaxNestingDepth();
  const nesting = getPendingLaunchNestingInfo(input.db, input.parentId);

  if (nesting.depth > maxDepth) {
    const chain = nesting.lineage.join(" -> ");
    throw new Error(
      chain
        ? `Max nesting depth exceeded (${nesting.depth}/${maxDepth}). Existing chain: ${chain}`
        : `Max nesting depth exceeded (${nesting.depth}/${maxDepth}).`,
    );
  }

  const fileHandoff = planFileHandoff(input.projectPath, sessionId);
  const baseLaunchCmd = driver.buildLaunchCommand({ cwd: input.projectPath, safe: input.safe });
  const launchCmd = `export AHELPA_PARENT_ID=${sessionId} AHELPA_MAX_NESTING_DEPTH=${maxDepth}; ${baseLaunchCmd}`;

  return {
    sessionId,
    ownerToken,
    driver,
    maxDepth,
    depth: nesting.depth,
    tmpDir: defaultRuntimeLayout.tmpDir,
    launchCmd,
    fileHandoff,
    input,
  };
}

const driverRuntime: DriverRuntime = {
  sleep: (ms) => Bun.sleep(ms),
  capture: (sessionId, lines) => Tmux.capture(sessionId, lines),
  sendKeys: (sessionId, text) => Tmux.sendKeys(sessionId, text),
  sendKey: (sessionId, key) => Tmux.sendKey(sessionId, key),
};

export async function executeLaunch(plan: LaunchPlan): Promise<LaunchResult> {
  if (!existsSync(plan.tmpDir)) mkdirSync(plan.tmpDir, { recursive: true });

  prepareFileHandoff(plan.fileHandoff, plan.input.task);
  await Tmux.create(plan.sessionId, plan.launchCmd);

  await plan.driver.prepareForTask(plan.sessionId, driverRuntime);
  await driverRuntime.sendKeys(plan.sessionId, plan.fileHandoff.taskInstruction);
  await plan.driver.afterTaskSubmitted(plan.sessionId, driverRuntime);

  await defaultWakeup.prepare(plan.sessionId);

  plan.input.db.createSession({
    id: plan.sessionId,
    parentId: plan.input.parentId,
    agentType: plan.input.agentType,
    task: plan.input.task,
    ownerToken: plan.ownerToken,
    projectPath: plan.input.projectPath,
    label: plan.input.label,
    depth: plan.depth,
  });

  if (!daemon.isDaemonRunning()) {
    daemon.startDaemon();
  }

  return { sessionId: plan.sessionId, ownerToken: plan.ownerToken, tmuxSession: plan.sessionId };
}

export async function launch(input: LaunchInput): Promise<LaunchResult> {
  return executeLaunch(planLaunch(input));
}

export interface ResumeInput {
  db: StateDB;
  sessionId: string;
  ownerToken: string;
  safe?: boolean;
}

export interface ResumeResult {
  sessionId: string;
  ownerToken: string;
  tmuxSession: string;
  resumedFrom: string;
}

export async function resume(input: ResumeInput): Promise<ResumeResult> {
  const oldSession = requireAuthorizedSession(input.db, input.sessionId, input.ownerToken);

  if (oldSession.status === SESSION_STATUS.Running || oldSession.status === SESSION_STATUS.Draining) {
    throw new Error(`Cannot resume: session ${input.sessionId} is still ${oldSession.status}`);
  }
  if (!oldSession.agentResumeId) {
    throw new Error(`Session ${input.sessionId} has no resume token`);
  }

  const driver = getDriver(oldSession.agentType);
  const uuid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const sessionId = `${driver.sessionPrefix}-${uuid}`;
  const ownerToken = crypto.randomUUID().replace(/-/g, "");
  const maxDepth = getMaxNestingDepth();

  const resumeCmd = driver.buildResumeCommand({
    cwd: oldSession.projectPath,
    resumeId: oldSession.agentResumeId,
    safe: input.safe,
  });
  const launchCmd = `export AHELPA_PARENT_ID=${sessionId} AHELPA_MAX_NESTING_DEPTH=${maxDepth}; ${resumeCmd}`;

  if (!existsSync(defaultRuntimeLayout.tmpDir)) {
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
  }

  await Tmux.create(sessionId, launchCmd);
  await defaultWakeup.prepare(sessionId);

  input.db.createSession({
    id: sessionId,
    parentId: oldSession.parentId,
    agentType: oldSession.agentType,
    task: `(resumed from ${oldSession.id})`,
    ownerToken,
    projectPath: oldSession.projectPath,
    label: oldSession.label,
    depth: oldSession.depth,
    resumedFrom: oldSession.id,
  });

  if (!daemon.isDaemonRunning()) {
    daemon.startDaemon();
  }

  return { sessionId, ownerToken, tmuxSession: sessionId, resumedFrom: oldSession.id };
}
