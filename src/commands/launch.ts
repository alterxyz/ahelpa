import { StateDB } from "../state";
import { Tmux } from "../tmux";
import { defaultWakeup } from "../wakeup";
import { getDriver } from "../drivers/registry";
import type { AgentDriver, DriverRuntime, TaskSubmissionContext } from "../drivers/types";
import * as daemon from "../daemon";
import { getPendingLaunchNestingInfo, getMaxNestingDepth } from "../nesting";
import { mkdirSync, existsSync, rmSync, unlinkSync } from "fs";
import { defaultRuntimeLayout } from "../runtime-layout";
import { isTaskInstructionEcho, planFileHandoff, prepareFileHandoff, type FileHandoffPlan } from "../file-handoff";
import { requireAuthorizedSession } from "../session-access";
import { SESSION_STATUS } from "../session-lifecycle";
import { shellEscape } from "../shell";

export interface LaunchInput {
  db: StateDB;
  agentType: string;
  task: string;
  projectPath: string;
  parentId: string;
  label?: string;
  safe?: boolean;
  model?: string;
  effort?: string;
}

export interface LaunchResult {
  sessionId: string;
  ownerToken: string;
  tmuxSession: string;
  // Set when the task was delivered to the agent but the driver could not
  // confirm it started a new turn. The session is kept alive as
  // needs_attention instead of being killed.
  warning?: string;
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

function generateAvailableSessionId(db: StateDB, prefix: string): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const candidate = `${prefix}-${random}`;
    if (!db.getSession(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique ${prefix} session ID`);
}

function assertFileHandoffAvailable(fileHandoff: FileHandoffPlan): void {
  if (existsSync(fileHandoff.taskFilePath) || existsSync(fileHandoff.sessionDeliveryDir)) {
    throw new Error(
      `Refusing to overwrite existing handoff resources for ${fileHandoff.sessionDeliveryDir}`,
    );
  }
}

function helperEnvironmentPrefix(sessionId: string, maxDepth: number): string {
  const assignments = [
    `AHELPA_PARENT_ID=${sessionId}`,
    `AHELPA_MAX_NESTING_DEPTH=${maxDepth}`,
  ];
  const ahelpaHome = process.env.AHELPA_HOME?.trim();
  const ahelpaTmpDir = process.env.AHELPA_TMP_DIR?.trim();
  if (ahelpaHome) assignments.push(`AHELPA_HOME=${shellEscape(ahelpaHome)}`);
  if (ahelpaTmpDir) assignments.push(`AHELPA_TMP_DIR=${shellEscape(ahelpaTmpDir)}`);
  return `export ${assignments.join(" ")};`;
}

export function planLaunch(input: LaunchInput): LaunchPlan {
  const driver = getDriver(input.agentType);
  const sessionId = generateAvailableSessionId(input.db, driver.sessionPrefix);
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
  const baseLaunchCmd = driver.buildLaunchCommand({
    cwd: input.projectPath,
    safe: input.safe,
    model: input.model,
    effort: input.effort,
  });
  const launchCmd = `${helperEnvironmentPrefix(sessionId, maxDepth)} ${baseLaunchCmd}`;

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

  let tmuxCreated = false;
  let handoffOwned = false;
  let dbCreated = false;
  let wakeupOwned = false;
  let submissionUnconfirmed = false;
  try {
    if (plan.input.db.getSession(plan.sessionId)) {
      throw new Error(`Session ID already exists: ${plan.sessionId}`);
    }
    assertFileHandoffAvailable(plan.fileHandoff);
    await Tmux.create(plan.sessionId, plan.launchCmd);
    tmuxCreated = true;
    // Re-check after tmux creation so a concurrent/stale handoff is never
    // overwritten by this launch. We own the tmux, but not those files.
    assertFileHandoffAvailable(plan.fileHandoff);
    handoffOwned = true;
    prepareFileHandoff(plan.fileHandoff, plan.input.task);
    await plan.driver.prepareForTask(plan.sessionId, driverRuntime);
    const submissionContext: TaskSubmissionContext = {};
    try {
      submissionContext.beforeOutput = await driverRuntime.capture(plan.sessionId, 80);
    } catch {
      // The snapshot only helps history-aware drivers reject stale sentinels.
    }
    await driverRuntime.sendKeys(plan.sessionId, plan.fileHandoff.taskInstruction);
    const submitted = await plan.driver.afterTaskSubmitted(
      plan.sessionId,
      driverRuntime,
      submissionContext,
    );
    if (!submitted) {
      // If the task instruction is visibly on the pane, the agent has it: do not
      // kill a healthy session just because turn evidence is late (Codex 0.145
      // slow MCP startup). Only an undelivered task is a launch failure.
      let pane = "";
      try {
        pane = await driverRuntime.capture(plan.sessionId, 80);
      } catch {
        // No pane: fall through to the delivery failure below.
      }
      if (!isTaskInstructionEcho(pane)) {
        throw new Error(`${plan.driver.name} did not expose the submitted task as a new turn`);
      }
      submissionUnconfirmed = true;
    }

    let initialResumeId: string | null = null;
    if (plan.driver.resumeTokenAvailableAfterSubmit) {
      try {
        const startupOutput = await driverRuntime.capture(plan.sessionId, 80);
        initialResumeId = plan.driver.extractResumeToken(startupOutput);
      } catch {
        // Post-submit capture is best-effort. The daemon still extracts tokens during drain.
      }
    }

    plan.input.db.createSession({
      id: plan.sessionId,
      parentId: plan.input.parentId,
      agentType: plan.input.agentType,
      task: plan.input.task,
      ownerToken: plan.ownerToken,
      projectPath: plan.input.projectPath,
      label: plan.input.label,
      depth: plan.depth,
      model: plan.input.model,
      effort: plan.input.effort,
      safe: plan.input.safe,
    });
    dbCreated = true;
    if (initialResumeId) {
      plan.input.db.updateResumeId(plan.sessionId, initialResumeId);
    }
    if (submissionUnconfirmed) {
      // Keep the tmux alive without daemon settlement; the host decides.
      plan.input.db.updateStatus(plan.sessionId, SESSION_STATUS.NeedsAttention);
    }

    wakeupOwned = true;
    await defaultWakeup.prepare(plan.sessionId);

    if (!daemon.isDaemonRunning()) {
      daemon.startDaemon();
    }
  } catch (error) {
    if (tmuxCreated) {
      try { await Tmux.kill(plan.sessionId); } catch {}
    }
    if (wakeupOwned) defaultWakeup.cleanup(plan.sessionId);
    if (dbCreated) {
      try { plan.input.db.deleteSession(plan.sessionId); } catch {}
    }
    if (handoffOwned) {
      try { unlinkSync(plan.fileHandoff.taskFilePath); } catch {}
      try { rmSync(plan.fileHandoff.sessionDeliveryDir, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }

  const result: LaunchResult = { sessionId: plan.sessionId, ownerToken: plan.ownerToken, tmuxSession: plan.sessionId };
  if (submissionUnconfirmed) {
    result.warning = `${plan.driver.name} received the task but did not confirm a new turn; session marked needs_attention`;
  }
  return result;
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

  if (oldSession.status !== SESSION_STATUS.Dead && oldSession.status !== SESSION_STATUS.Idle) {
    throw new Error(
      `Cannot resume: session ${input.sessionId} must be idle or dead (current status: ${oldSession.status})`,
    );
  }
  if (!oldSession.agentResumeId) {
    throw new Error(`Session ${input.sessionId} has no resume token`);
  }
  // Settlement publishes idle before graceful exit starts draining. Do not
  // open the same native conversation twice during that cleanup window.
  if (oldSession.status === SESSION_STATUS.Idle && await Tmux.hasSession(oldSession.id)) {
    throw new Error(`Cannot resume: session ${input.sessionId} still has an active terminal`);
  }

  const driver = getDriver(oldSession.agentType);
  const sessionId = generateAvailableSessionId(input.db, driver.sessionPrefix);
  const ownerToken = crypto.randomUUID().replace(/-/g, "");
  const maxDepth = getMaxNestingDepth();
  // Safe posture is sticky across native resumes. `--safe` may upgrade an
  // older/default session, but omission must never silently remove safety.
  const safe = oldSession.safe || input.safe === true;

  const resumeCmd = driver.buildResumeCommand({
    cwd: oldSession.projectPath,
    resumeId: oldSession.agentResumeId,
    safe,
    model: oldSession.model ?? undefined,
    effort: oldSession.effort ?? undefined,
  });
  const launchCmd = `${helperEnvironmentPrefix(sessionId, maxDepth)} ${resumeCmd}`;

  if (!existsSync(defaultRuntimeLayout.tmpDir)) {
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
  }

  let tmuxCreated = false;
  let dbCreated = false;
  let wakeupOwned = false;
  try {
    await Tmux.create(sessionId, launchCmd);
    tmuxCreated = true;
    // Do not hand the new tmux session back until the driver's startup/trust
    // flow has had a chance to reach an input prompt. Otherwise an immediate
    // `send` can be typed into a loading or confirmation screen.
    await driver.prepareForResume(sessionId, driverRuntime);
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
      model: oldSession.model,
      effort: oldSession.effort,
      safe,
    });
    dbCreated = true;
    input.db.updateResumeId(sessionId, oldSession.agentResumeId);
    // A resumed native conversation has no new ahelpa task yet. Keep its tmux
    // alive without daemon settlement until the host sends the next turn.
    input.db.updateStatus(sessionId, SESSION_STATUS.NeedsAttention);

    wakeupOwned = true;
    await defaultWakeup.prepare(sessionId);

    if (!daemon.isDaemonRunning()) {
      daemon.startDaemon();
    }
  } catch (error) {
    if (tmuxCreated) {
      try { await Tmux.kill(sessionId); } catch {}
    }
    if (wakeupOwned) defaultWakeup.cleanup(sessionId);
    if (dbCreated) {
      try { input.db.deleteSession(sessionId); } catch {}
    }
    throw error;
  }

  return { sessionId, ownerToken, tmuxSession: sessionId, resumedFrom: oldSession.id };
}
