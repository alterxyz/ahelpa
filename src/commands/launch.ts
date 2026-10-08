import { StateDB } from "../state";
import { Tmux } from "../tmux";
import { defaultWakeup } from "../wakeup";
import { getDriver } from "../drivers/registry";
import type { AgentDriver, DriverRuntime, HelperRole, TaskSubmissionContext } from "../drivers/types";
import * as daemon from "../daemon";
import { getPendingLaunchNestingInfo, getMaxActivePerTree, getMaxNestingDepth, listActiveSessionsInTree } from "../nesting";
import { $ } from "bun";
import { mkdirSync, existsSync, rmSync, rmdirSync, unlinkSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { defaultRuntimeLayout } from "../runtime-layout";
import { isTaskInstructionEcho, planFileHandoff, prepareFileHandoff, type FileHandoffPlan, type HandoffContext } from "../file-handoff";
import { requireAuthorizedSession } from "../session-access";
import { SESSION_STATUS } from "../session-lifecycle";
import { shellEscape } from "../shell";
import { resolveLaunchProfile } from "../launch-profiles";

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
  role?: HelperRole;
  // Acceptance command rerun by `wait` on the helper's final state.
  check?: string;
  // Session this hand follows; its task and summary paths go into the task file.
  after?: string;
  // Run in a fresh git worktree beside the project so one worktree has one writer.
  worktree?: boolean;
  // The task text came from --file, so a temp path inside it is content, not a pointer.
  taskFromFile?: boolean;
}

export interface LaunchResult {
  sessionId: string;
  ownerToken: string;
  tmuxSession: string;
  projectPath: string;
  role?: HelperRole;
  model?: string;
  effort?: string;
  // Set when the task was delivered to the agent but the driver could not
  // confirm it started a new turn. The session is kept alive as
  // needs_attention instead of being killed.
  warning?: string;
  // The task text looks like a pointer to a temp file that will not survive.
  taskWarning?: string;
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
  handoffContext: HandoffContext;
  // Set when --worktree asked for a new worktree of this repository.
  worktreeSource?: string;
  input: LaunchInput;
}

const TEMP_POINTER = /(^|[\s"'`(])(\/private)?\/tmp\/|scratchpad\//;

export function tempPointerWarning(task: string, taskFromFile = false): string | undefined {
  // ponytail: short --task + temp path = "go read that file"; --file content and long tasks that mention /tmp are fine.
  if (!taskFromFile && task.length < 600 && TEMP_POINTER.test(task)) {
    return "task points at a temp file that may not survive the session; pass the content with --file so the ask stays traceable";
  }
  return undefined;
}

export function worktreePathFor(projectPath: string, sessionId: string): string {
  return join(dirname(projectPath), `${basename(projectPath)}-worktrees`, sessionId);
}

function previousHandContext(db: StateDB, afterId: string): NonNullable<HandoffContext["previous"]> {
  const previous = db.getSession(afterId);
  if (!previous) throw new Error(`--after session not found: ${afterId}`);
  if (!isAbsolute(previous.projectPath)) {
    throw new Error(`--after session ${afterId} stores a relative project path; its result files cannot be located from another directory`);
  }
  const plan = planFileHandoff(previous.projectPath, previous.id);
  return { sessionId: previous.id, taskCopyPath: plan.taskCopyPath, summaryPath: plan.summaryPath, artifactsDir: plan.artifactsDir };
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
    `AHELPA_MAX_ACTIVE_PER_TREE=${getMaxActivePerTree()}`,
    `AHELPA_HOME=${shellEscape(defaultRuntimeLayout.ahelpaHomeDir())}`,
    `AHELPA_TMP_DIR=${shellEscape(defaultRuntimeLayout.tmpDir)}`,
  ];
  return `export ${assignments.join(" ")};`;
}

function resolveProjectPath(projectPath: string): string {
  const absolutePath = resolve(projectPath);
  if (!statSync(absolutePath).isDirectory()) {
    throw new Error(`Project path must be a directory: ${absolutePath}`);
  }
  return absolutePath;
}

export function planLaunch(input: LaunchInput): LaunchPlan {
  const driver = getDriver(input.agentType);
  // Resolve once in the caller's working directory. The helper changes cwd,
  // and a later resume may be invoked from an entirely different directory.
  input = {
    ...input,
    ...resolveLaunchProfile(driver, { role: input.role, model: input.model, effort: input.effort }),
    projectPath: resolveProjectPath(input.projectPath),
  };
  const sessionId = generateAvailableSessionId(input.db, driver.sessionPrefix);
  const ownerToken = crypto.randomUUID().replace(/-/g, "");
  const maxDepth = getMaxNestingDepth();
  const nesting = getPendingLaunchNestingInfo(input.db, input.parentId);
  const handoffContext: HandoffContext = {
    role: input.role,
    check: input.check,
    previous: input.after ? previousHandContext(input.db, input.after) : null,
  };
  let worktreeSource: string | undefined;
  if (input.worktree) {
    worktreeSource = input.projectPath;
    input = { ...input, projectPath: worktreePathFor(input.projectPath, sessionId) };
  }

  if (nesting.depth > maxDepth) {
    const chain = nesting.lineage.join(" -> ");
    throw new Error(
      chain
        ? `Max nesting depth exceeded (${nesting.depth}/${maxDepth}). Existing chain: ${chain}`
        : `Max nesting depth exceeded (${nesting.depth}/${maxDepth}).`,
    );
  }
  assertParentMayLaunch(input.db, input.parentId, nesting.rootSessionId);

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
    handoffContext,
    worktreeSource,
    input,
  };
}

// A reviewer's contract is read-only; launching a worker would be an edit by
// proxy and would let the author's reasoning reach the review. A helper's tree
// is bounded in width as well as depth so a legal depth cannot fan out forever.
function assertParentMayLaunch(db: StateDB, parentId: string, rootSessionId: string | null): void {
  const parent = db.getSession(parentId);
  if (!parent) return;
  if (parent.role === "reviewer") {
    throw new Error(`Session ${parentId} is a reviewer and may not launch helpers; review hands are read-only.`);
  }
  if (!rootSessionId) return;
  const maxActive = getMaxActivePerTree();
  const active = listActiveSessionsInTree(db, rootSessionId);
  if (active.length >= maxActive) {
    const ids = active.map((session) => `${session.id}(${session.status})`).join(", ");
    throw new Error(
      `Max active helpers per tree exceeded (${active.length}/${maxActive} under ${rootSessionId}). Wait for or kill one of: ${ids}`,
    );
  }
}

export async function createWorktree(source: string, path: string, sessionId: string): Promise<void> {
  const inRepo = await $`git -C ${source} rev-parse --is-inside-work-tree`.quiet().nothrow();
  if (inRepo.exitCode !== 0) throw new Error(`--worktree requires a git repository: ${source}`);
  if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const added = await $`git -C ${source} worktree add -b ${`ahelpa/${sessionId}`} ${path}`.quiet().nothrow();
  if (added.exitCode !== 0) {
    // A failing post-checkout hook leaves the directory, registration and
    // branch behind. The path did not exist before us, so reclaiming is safe.
    await removeWorktree(source, path, sessionId);
    throw new Error(`git worktree add failed: ${added.stderr.toString().trim()}`);
  }
}

export async function removeWorktree(source: string, path: string, sessionId: string): Promise<void> {
  await $`git -C ${source} worktree remove --force ${path}`.quiet().nothrow();
  await $`git -C ${source} branch -D ${`ahelpa/${sessionId}`}`.quiet().nothrow();
  try { rmdirSync(dirname(path)); } catch {} // only succeeds when we left it empty
}

async function currentCommit(projectPath: string): Promise<string | null> {
  const head = await $`git -C ${projectPath} rev-parse HEAD`.quiet().nothrow();
  return head.exitCode === 0 ? head.text().trim() : null;
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
  let worktreeCreated = false;
  let submissionUnconfirmed = false;
  try {
    if (plan.input.db.getSession(plan.sessionId)) {
      throw new Error(`Session ID already exists: ${plan.sessionId}`);
    }
    assertFileHandoffAvailable(plan.fileHandoff);
    if (plan.worktreeSource) {
      await createWorktree(plan.worktreeSource, plan.input.projectPath, plan.sessionId);
      worktreeCreated = true;
    }
    const baseCommit = await currentCommit(plan.input.projectPath);
    await Tmux.create(plan.sessionId, plan.launchCmd);
    tmuxCreated = true;
    // Re-check after tmux creation so a concurrent/stale handoff is never
    // overwritten by this launch. We own the tmux, but not those files.
    assertFileHandoffAvailable(plan.fileHandoff);
    handoffOwned = true;
    prepareFileHandoff(plan.fileHandoff, plan.input.task, plan.handoffContext);
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
      role: plan.input.role,
      safe: plan.input.safe,
      checkCmd: plan.input.check,
      baseCommit,
      afterId: plan.input.after,
    });
    dbCreated = true;
    if (initialResumeId) {
      plan.input.db.updateResumeId(plan.sessionId, initialResumeId);
    }
    if (submissionUnconfirmed) {
      // Keep the tmux alive without daemon settlement; the host decides.
      plan.input.db.updateStatus(plan.sessionId, SESSION_STATUS.NeedsAttention);
    }

    await defaultWakeup.prepare(plan.sessionId);
    wakeupOwned = true;

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
    if (worktreeCreated && plan.worktreeSource) {
      await removeWorktree(plan.worktreeSource, plan.input.projectPath, plan.sessionId);
    }
    throw error;
  }

  const result: LaunchResult = {
    sessionId: plan.sessionId,
    ownerToken: plan.ownerToken,
    tmuxSession: plan.sessionId,
    projectPath: plan.input.projectPath,
  };
  if (plan.input.role !== undefined) result.role = plan.input.role;
  if (plan.input.model !== undefined) result.model = plan.input.model;
  if (plan.input.effort !== undefined) result.effort = plan.input.effort;
  if (submissionUnconfirmed) {
    result.warning = `${plan.driver.name} received the task but did not confirm a new turn; session marked needs_attention`;
  }
  const taskWarning = tempPointerWarning(plan.input.task, plan.input.taskFromFile);
  if (taskWarning) result.taskWarning = taskWarning;
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
  role?: HelperRole;
  model?: string;
  effort?: string;
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
  if (!isAbsolute(oldSession.projectPath)) {
    throw new Error(
      `Cannot resume: session ${input.sessionId} stores a relative project path and its original working directory is unknown. Launch a new session with an absolute --project path.`,
    );
  }
  const projectPath = resolveProjectPath(oldSession.projectPath);

  const driver = getDriver(oldSession.agentType);
  const sessionId = generateAvailableSessionId(input.db, driver.sessionPrefix);
  const ownerToken = crypto.randomUUID().replace(/-/g, "");
  const maxDepth = getMaxNestingDepth();
  // Safe posture is sticky across native resumes. `--safe` may upgrade an
  // older/default session, but omission must never silently remove safety.
  const safe = oldSession.safe || input.safe === true;

  const resumeCmd = driver.buildResumeCommand({
    cwd: projectPath,
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
      projectPath,
      label: oldSession.label,
      depth: oldSession.depth,
      resumedFrom: oldSession.id,
      model: oldSession.model,
      effort: oldSession.effort,
      role: oldSession.role,
      safe,
      checkCmd: oldSession.checkCmd,
      baseCommit: oldSession.baseCommit,
      afterId: oldSession.afterId,
    });
    dbCreated = true;
    input.db.updateResumeId(sessionId, oldSession.agentResumeId);
    // A resumed native conversation has no new ahelpa task yet. Keep its tmux
    // alive without daemon settlement until the host sends the next turn.
    input.db.updateStatus(sessionId, SESSION_STATUS.NeedsAttention);

    await defaultWakeup.prepare(sessionId);
    wakeupOwned = true;

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

  const result: ResumeResult = { sessionId, ownerToken, tmuxSession: sessionId, resumedFrom: oldSession.id };
  if (oldSession.role != null) result.role = oldSession.role;
  if (oldSession.model != null) result.model = oldSession.model;
  if (oldSession.effort != null) result.effort = oldSession.effort;
  return result;
}
