import { StateDB, type CreateSessionInput } from "../state";
import { Tmux } from "../tmux";
import { defaultWakeup } from "../wakeup";
import { getDriver } from "../drivers/registry";
import type { AgentDriver, DriverRuntime, HelperRole, TaskSubmissionContext } from "../drivers/types";
import * as daemon from "../daemon";
import { activeSessionAncestorIds, getPendingLaunchNestingInfo, getSessionTreeId, getMaxActivePerTree, getMaxNestingDepth, listActiveSessionsInTree } from "../nesting";
import { $ } from "bun";
import { mkdirSync, existsSync, rmSync, rmdirSync, unlinkSync, statSync, realpathSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from "path";
import { defaultRuntimeLayout } from "../runtime-layout";
import { isTaskInstructionEcho, ORIGINAL_ASK_UNAVAILABLE, planFileHandoff, prepareFileHandoff, type FileHandoffPlan, type HandoffContext } from "../file-handoff";
import { requireAuthorizedSession } from "../session-access";
import { SESSION_STATUS } from "../session-lifecycle";
import { shellEscape } from "../shell";
import { deliverTurn } from "../turn-delivery";
import { resolveLaunchProfile } from "../launch-profiles";
import { computeTargetFingerprint, LAUNCH_FINGERPRINT_TIMEOUT_MS } from "../evidence";

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
  // Session this hand follows; reviewers receive its ask without its claims.
  after?: string;
  unblind?: boolean;
  // Run in a fresh git worktree beside the project so one worktree has one writer.
  worktree?: boolean;
  // The task text came from --file, so a temp path inside it is content, not a pointer.
  taskFromFile?: boolean;
  // Groups the hands of one change. Defaults to the --after session's job, then
  // to the job the launching helper itself belongs to.
  job?: string;
}

export interface WriterConflict {
  sessionId: string;
  role: HelperRole | null;
  status: string;
  projectPath: string;
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
  jobId?: string;
  // Active sessions sharing this tree where at least one side may write. The
  // launch proceeds; evidence can no longer say whose change is whose.
  writerConflict?: WriterConflict[];
}

export interface LaunchPlan {
  sessionId: string;
  ownerToken: string;
  driver: AgentDriver;
  maxDepth: number;
  depth: number;
  treeId: string;
  callerId?: string;
  tmpDir: string;
  launchCmd: string;
  fileHandoff: FileHandoffPlan;
  handoffContext: HandoffContext;
  // Set when --worktree asked for a new worktree of this repository.
  worktreeSource?: string;
  jobId: string | null;
  writerConflict: WriterConflict[];
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
  return {
    sessionId: previous.id,
    taskCopyPath: plan.taskCopyPath,
    ...(existsSync(plan.askPath) ? { askPath: plan.askPath, askIncomplete: readFileSync(plan.askPath, "utf8").startsWith(ORIGINAL_ASK_UNAVAILABLE) } : {}),
    summaryPath: plan.summaryPath,
    artifactsDir: plan.artifactsDir,
    ...(previous.baseCommit ? { baseCommit: previous.baseCommit } : {}),
  };
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

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The job id may later name a directory, so it is held to a filename-safe shape.
export function resolveJobId(db: StateDB, explicit: string | undefined, afterId: string | undefined, env = process.env): string | null {
  const inherited = afterId ? db.getSession(afterId)?.jobId : null;
  const caller = env.AHELPA_PARENT_ID ? db.getSession(env.AHELPA_PARENT_ID) : null;
  return validateJobId(explicit ?? inherited ?? caller?.jobId ?? null);
}

function validateJobId(job: string | null): string | null {
  if (job !== null && !JOB_ID.test(job)) {
    throw new Error(`Invalid job id "${job}": use 1-64 letters, digits, dot, underscore, or dash, starting with a letter or digit`);
  }
  return job;
}

function physicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try { return resolve(realpathSync(ancestor), ...missing); } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(path);
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function sharesTree(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  return contains(a, b) || contains(b, a);
}

// One worktree, one writer. Reviewer beside reviewer is the only quiet pair:
// any other pairing either collides on edits or reviews a moving tree. The
// launching helper is not its own child's conflict: it is the one delegating,
// and it is expected to wait rather than edit alongside.
export function findWriterConflicts(db: StateDB, projectPath: string, role: HelperRole | undefined, launcherId?: string): WriterConflict[] {
  const writer = role !== "reviewer";
  const physicalProject = physicalPath(projectPath);
  return db.listActiveSessions()
    .filter((session) => session.id !== launcherId)
    .filter((session) => session.status !== SESSION_STATUS.Draining)
    .filter((session) => sharesTree(physicalPath(session.projectPath), physicalProject))
    .filter((session) => writer || session.role !== "reviewer")
    .map((session) => ({ sessionId: session.id, role: session.role ?? null, status: session.status, projectPath: session.projectPath }));
}

function helperEnvironmentPrefix(sessionId: string, maxDepth: number, jobId: string | null = null): string {
  const assignments = [
    `AHELPA_PARENT_ID=${sessionId}`,
    `AHELPA_MAX_NESTING_DEPTH=${maxDepth}`,
    `AHELPA_MAX_ACTIVE_PER_TREE=${getMaxActivePerTree()}`,
    `AHELPA_HOME=${shellEscape(defaultRuntimeLayout.ahelpaHomeDir())}`,
    `AHELPA_TMP_DIR=${shellEscape(defaultRuntimeLayout.tmpDir)}`,
  ];
  // Always set, empty when there is no job: an inherited value would silently
  // put the helper in the job of whoever started the tmux server. An empty
  // export (not `unset`) keeps the prefix valid in every shell tmux may run.
  assignments.push(`AHELPA_JOB_ID=${jobId ? shellEscape(jobId) : "''"}`);
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
  if (input.unblind && input.role !== "reviewer") throw new Error("--unblind requires --role reviewer");
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
  const callerId = process.env.AHELPA_PARENT_ID && input.db.getSession(process.env.AHELPA_PARENT_ID)
    ? process.env.AHELPA_PARENT_ID : undefined;
  const treeId = nesting.rootSessionId ?? sessionId;
  const depth = assertCallerMayLaunch(input.db, callerId, treeId, nesting.depth);
  const handoffContext: HandoffContext = {
    role: input.role,
    check: input.check,
    previous: input.after ? previousHandContext(input.db, input.after) : null,
    ...(input.unblind ? { unblind: true } : {}),
  };
  const jobId = resolveJobId(input.db, input.job, input.after);
  let worktreeSource: string | undefined;
  if (input.worktree) {
    worktreeSource = input.projectPath;
    input = { ...input, projectPath: worktreePathFor(input.projectPath, sessionId) };
  }

  if (depth > maxDepth) {
    const chain = nesting.lineage.join(" -> ");
    throw new Error(
      chain
        ? `Max nesting depth exceeded (${depth}/${maxDepth}). Existing chain: ${chain}`
        : `Max nesting depth exceeded (${depth}/${maxDepth}).`,
    );
  }
  assertParentMayLaunch(input.db, input.parentId, treeId);

  const writerConflict = input.worktree ? [] : findWriterConflicts(input.db, input.projectPath, input.role, callerId ?? input.parentId);
  const fileHandoff = planFileHandoff(input.projectPath, sessionId);
  const baseLaunchCmd = driver.buildLaunchCommand({
    cwd: input.projectPath,
    sessionId,
    safe: input.safe,
    model: input.model,
    effort: input.effort,
  });
  const launchCmd = `${helperEnvironmentPrefix(sessionId, maxDepth, jobId)} ${baseLaunchCmd}`;

  return {
    sessionId,
    ownerToken,
    driver,
    maxDepth,
    depth,
    treeId,
    callerId,
    tmpDir: defaultRuntimeLayout.tmpDir,
    launchCmd,
    fileHandoff,
    handoffContext,
    worktreeSource,
    jobId,
    writerConflict,
    input,
  };
}

// A reviewer's contract is read-only; launching a worker would be an edit by
// proxy and would let the author's reasoning reach the review. A helper's tree
// is bounded in width as well as depth so a legal depth cannot fan out forever.
function assertParentMayLaunch(db: StateDB, parentId: string, rootSessionId: string | null): void {
  const parent = db.getSession(parentId);
  if (parent?.role === "reviewer") {
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

// The environment identifies the actual caller; --parent only selects lineage.
// Reparenting inside the same tree cannot reduce the caller's nesting depth.
function assertCallerMayLaunch(db: StateDB, callerId: string | undefined, treeId: string, depth: number): number {
  if (!callerId) return depth;
  const caller = db.getSession(callerId);
  if (!caller) throw new Error(`Launching helper disappeared: ${callerId}`);
  if (caller.role === "reviewer") {
    throw new Error(`Session ${callerId} is a reviewer and may not launch helpers; review hands are read-only.`);
  }
  if (getSessionTreeId(db, callerId) !== treeId) {
    throw new Error(`--parent may not move helper ${callerId} outside its own tree`);
  }
  return Math.max(depth, caller.depth + 1);
}

// No await inside this write transaction: checks and the counted row are one
// operation across CLI processes, before any external launch resource exists.
function reserveSession(db: StateDB, input: CreateSessionInput, callerId: string | undefined, maxDepth: number): void {
  db.immediateTransaction(() => {
    // Resume may have awaited terminal liveness while clean removed or changed
    // its source. Resolve its current ancestry under the reservation lock.
    const source = input.resumedFrom ? db.getSession(input.resumedFrom) : null;
    if (input.resumedFrom && !source) {
      throw new Error(`Cannot resume: source session ${input.resumedFrom} no longer exists`);
    }
    if (source) {
      if (source.status !== SESSION_STATUS.Idle && source.status !== SESSION_STATUS.Dead) {
        throw new Error(`Cannot resume: source session ${source.id} must be idle or dead`);
      }
      input = { ...input, parentId: source.parentId, depth: Math.max(input.depth ?? 1, source.depth) };
    }
    const nesting = getPendingLaunchNestingInfo(db, input.parentId);
    const rootId = source ? getSessionTreeId(db, source.id) : nesting.rootSessionId ?? input.id;
    const depth = assertCallerMayLaunch(db, callerId, rootId, Math.max(input.depth ?? 1, nesting.depth));
    if (depth > maxDepth) throw new Error(`Max nesting depth exceeded (${depth}/${maxDepth}).`);
    assertParentMayLaunch(db, input.parentId, rootId);
    db.createSession({ ...input, depth, launchPid: process.pid });
  });
}

function assertLaunchReservation(db: StateDB, sessionId: string): void {
  const session = db.getSession(sessionId);
  if (session?.status !== SESSION_STATUS.Running || session.launchPid !== process.pid) {
    throw new Error(`Launch cancelled: reservation ${sessionId} is no longer owned by this launcher`);
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

function rollbackReservation(db: StateDB, sessionId: string): void {
  db.immediateTransaction(() => {
    // Remove the reservation from the active set before checking ancestry.
    // A late child or active native resume still needs this lineage link;
    // clean can reclaim the tombstone once those sessions no longer need it.
    db.markLaunchRolledBack(sessionId);
    if (db.listSessions(sessionId).length === 0 && !activeSessionAncestorIds(db).has(sessionId)) {
      db.deleteSession(sessionId);
    }
  });
}

export async function executeLaunch(plan: LaunchPlan): Promise<LaunchResult> {
  let tmuxCreated = false;
  let handoffOwned = false;
  let taskFileOwned = false;
  let dbCreated = false;
  let wakeupOwned = false;
  let worktreeCreated = false;
  let submissionUnconfirmed = false;
  try {
    if (plan.input.db.getSession(plan.sessionId)) {
      throw new Error(`Session ID already exists: ${plan.sessionId}`);
    }
    reserveSession(plan.input.db, {
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
      afterId: plan.input.after,
      jobId: plan.jobId,
      targetResultDirs: plan.input.role === "reviewer" ? [plan.fileHandoff.sessionDeliveryDir] : null,
      unblind: plan.input.unblind,
    }, plan.callerId, plan.maxDepth);
    dbCreated = true;
    if (!existsSync(plan.tmpDir)) mkdirSync(plan.tmpDir, { recursive: true });
    assertFileHandoffAvailable(plan.fileHandoff);
    if (plan.worktreeSource) {
      await createWorktree(plan.worktreeSource, plan.input.projectPath, plan.sessionId);
      worktreeCreated = true;
    }
    const baseCommit = await currentCommit(plan.input.projectPath);
    if (plan.input.role === "reviewer" && plan.handoffContext.previous) {
      plan.handoffContext.previous.baseCommit ??= baseCommit;
    }
    const targetResultDirs = [plan.fileHandoff.sessionDeliveryDir];
    const targetFingerprint = plan.input.role === "reviewer"
      ? await computeTargetFingerprint(plan.input.projectPath, targetResultDirs, { deadline: Date.now() + LAUNCH_FINGERPRINT_TIMEOUT_MS })
      : null;
    plan.handoffContext.targetFingerprint = targetFingerprint;
    if (plan.driver.turnHooks) {
      mkdirSync(plan.fileHandoff.projectDeliveryDir, { recursive: true });
      mkdirSync(plan.fileHandoff.sessionDeliveryDir);
      handoffOwned = true;
      plan.driver.prepareLaunchFiles?.({ cwd: plan.input.projectPath, sessionId: plan.sessionId });
    }
    await Tmux.create(plan.sessionId, plan.launchCmd);
    tmuxCreated = true;
    assertLaunchReservation(plan.input.db, plan.sessionId);
    // Hook-enabled drivers reserved their delivery directory before startup.
    // Re-check the separate tmp task path after tmux creation as well.
    if (!handoffOwned) assertFileHandoffAvailable(plan.fileHandoff);
    else if (existsSync(plan.fileHandoff.taskFilePath)) throw new Error("Refusing to overwrite existing task file");
    handoffOwned = true;
    taskFileOwned = true;
    prepareFileHandoff(plan.fileHandoff, plan.input.task, plan.handoffContext);
    await plan.driver.prepareForTask(plan.sessionId, driverRuntime);
    const submissionContext: TaskSubmissionContext = {};
    try {
      submissionContext.beforeOutput = await driverRuntime.capture(plan.sessionId, 80);
    } catch {
      // The snapshot only helps history-aware drivers reject stale sentinels.
    }
    const row = plan.input.db.getSession(plan.sessionId)!;
    const submitted = await deliverTurn(plan.input.db, row, plan.fileHandoff.taskInstruction,
      () => driverRuntime.sendKeys(plan.sessionId, plan.fileHandoff.taskInstruction), {
        afterSend: () => plan.driver.afterTaskSubmitted(plan.sessionId, driverRuntime, submissionContext),
      });
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

    if (initialResumeId) {
      plan.input.db.updateResumeId(plan.sessionId, initialResumeId);
    }
    await defaultWakeup.prepare(plan.sessionId);
    wakeupOwned = true;
    if (!plan.input.db.completeLaunch(plan.sessionId, process.pid, baseCommit, submissionUnconfirmed ? SESSION_STATUS.NeedsAttention : undefined, targetFingerprint)) {
      throw new Error(`Launch cancelled: reservation ${plan.sessionId} is no longer owned by this launcher`);
    }

    if (!daemon.isDaemonRunning()) {
      daemon.startDaemon();
    }
  } catch (error) {
    if (tmuxCreated) {
      try { await Tmux.kill(plan.sessionId); } catch {}
    }
    if (wakeupOwned) defaultWakeup.cleanup(plan.sessionId);
    if (dbCreated) {
      try { rollbackReservation(plan.input.db, plan.sessionId); } catch {}
    }
    if (taskFileOwned) {
      try { unlinkSync(plan.fileHandoff.taskFilePath); } catch {}
    }
    if (handoffOwned) {
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
  if (plan.jobId) result.jobId = plan.jobId;
  if (plan.writerConflict.length > 0) result.writerConflict = plan.writerConflict;
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
  const sourceHandoff = planFileHandoff(projectPath, oldSession.id);

  const driver = getDriver(oldSession.agentType);
  const sessionId = generateAvailableSessionId(input.db, driver.sessionPrefix);
  const ownerToken = crypto.randomUUID().replace(/-/g, "");
  const fileHandoff = planFileHandoff(projectPath, sessionId);
  const maxDepth = getMaxNestingDepth();
  // Safe posture is sticky across native resumes. `--safe` may upgrade an
  // older/default session, but omission must never silently remove safety.
  const safe = oldSession.safe || input.safe === true;

  const resumeCmd = driver.buildResumeCommand({
    cwd: projectPath,
    sessionId,
    resumeId: oldSession.agentResumeId,
    safe,
    model: oldSession.model ?? undefined,
    effort: oldSession.effort ?? undefined,
  });
  const launchCmd = `${helperEnvironmentPrefix(sessionId, maxDepth, validateJobId(oldSession.jobId ?? null))} ${resumeCmd}`;

  const callerId = process.env.AHELPA_PARENT_ID && input.db.getSession(process.env.AHELPA_PARENT_ID)
    ? process.env.AHELPA_PARENT_ID : undefined;

  let tmuxCreated = false;
  let dbCreated = false;
  let wakeupOwned = false;
  let handoffOwned = false;
  let hookDirOwned = false;
  const handoff = planFileHandoff(projectPath, sessionId);
  try {
    reserveSession(input.db, {
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
      jobId: validateJobId(oldSession.jobId ?? null),
      targetFingerprint: oldSession.role === "reviewer" ? oldSession.targetFingerprint : null,
      targetResultDirs: oldSession.role === "reviewer" && oldSession.targetFingerprint
        ? [...(oldSession.targetResultDirs ?? [planFileHandoff(projectPath, oldSession.id).sessionDeliveryDir]), planFileHandoff(projectPath, sessionId).sessionDeliveryDir]
        : null,
      unblind: oldSession.unblind,
    }, callerId, maxDepth);
    dbCreated = true;
    if (!existsSync(defaultRuntimeLayout.tmpDir)) mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
    if (driver.turnHooks) {
      assertFileHandoffAvailable(handoff);
      mkdirSync(handoff.projectDeliveryDir, { recursive: true });
      mkdirSync(handoff.sessionDeliveryDir);
      hookDirOwned = true;
      driver.prepareLaunchFiles?.({ cwd: projectPath, sessionId });
    }
    await Tmux.create(sessionId, launchCmd);
    tmuxCreated = true;
    assertLaunchReservation(input.db, sessionId);
    assertFileHandoffAvailable(fileHandoff);
    handoffOwned = true;
    mkdirSync(fileHandoff.artifactsDir, { recursive: true });
    writeFileSync(fileHandoff.askPath, existsSync(sourceHandoff.askPath)
      ? readFileSync(sourceHandoff.askPath)
      : `${ORIGINAL_ASK_UNAVAILABLE}\n`);
    // Do not hand the new tmux session back until the driver's startup/trust
    // flow has had a chance to reach an input prompt. Otherwise an immediate
    // `send` can be typed into a loading or confirmation screen.
    await driver.prepareForResume(sessionId, driverRuntime);
    input.db.updateResumeId(sessionId, oldSession.agentResumeId);
    await defaultWakeup.prepare(sessionId);
    wakeupOwned = true;
    // No new task yet: the host decides when the resumed hand starts a turn.
    if (!input.db.completeLaunch(sessionId, process.pid, undefined, SESSION_STATUS.NeedsAttention)) {
      throw new Error(`Launch cancelled: reservation ${sessionId} is no longer owned by this launcher`);
    }

    if (!daemon.isDaemonRunning()) {
      daemon.startDaemon();
    }
  } catch (error) {
    if (tmuxCreated) {
      try { await Tmux.kill(sessionId); } catch {}
    }
    if (wakeupOwned) defaultWakeup.cleanup(sessionId);
    if (handoffOwned) {
      try { rmSync(fileHandoff.sessionDeliveryDir, { recursive: true, force: true }); } catch {}
    }
    if (hookDirOwned) {
      try { rmSync(handoff.sessionDeliveryDir, { recursive: true, force: true }); } catch {}
    }
    if (dbCreated) {
      try { rollbackReservation(input.db, sessionId); } catch {}
    }
    throw error;
  }

  const result: ResumeResult = { sessionId, ownerToken, tmuxSession: sessionId, resumedFrom: oldSession.id };
  if (oldSession.role != null) result.role = oldSession.role;
  if (oldSession.model != null) result.model = oldSession.model;
  if (oldSession.effort != null) result.effort = oldSession.effort;
  return result;
}
