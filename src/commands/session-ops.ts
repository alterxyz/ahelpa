// Operations on an existing session: everything a caller can do to a helper
// after launch, except waiting (wait.ts owns the wakeup protocol). The
// token-gated ops authorize the exact target. kill --tree alone extends abort
// authority to descendants; it grants no other control over those sessions.

import { StateDB, type SessionRecord } from "../state";
import { Tmux } from "../tmux";
import { Archive } from "../archive";
import { defaultWakeup, Wakeup } from "../wakeup";
import { SESSION_STATUS } from "../session-lifecycle";
import { requireAuthorizedSession } from "../session-access";
import { activeSessionAncestorIds, getSessionNestingInfo, listActiveDescendants } from "../nesting";
import { defaultRuntimeLayout, RuntimeLayout } from "../runtime-layout";
import { planSessionHandoff, prepareFileHandoff } from "../file-handoff";
import { getHarnessDriver } from "../drivers/registry";
import type { DriverRuntime, ModelSwitchOptions, TaskSubmissionContext } from "../drivers/types";
import * as daemon from "../daemon";
import { ModelSwitchAppliedError } from "../drivers/types";
import { unlinkSync, readdirSync } from "fs";
import { isAbsolute, join } from "path";
import { readTaskFile } from "../task-input";
import { normalizeTurnInput } from "../turn-hooks";
import { deliverTurn } from "../turn-delivery";
import { settle } from "../settle";
import { releaseInterventionLease, renewInterventionLease, takeInterventionLease, type InterventionLease } from "../intervention-lease";
import { resolveParentId } from "../caller-identity";

interface AuthContext { db: StateDB; session: SessionRecord; }

function withAuth<TArgs extends any[], TResult>(
  fn: (ctx: AuthContext, ...args: TArgs) => TResult,
) {
  return (db: StateDB, sessionId: string, token: string, ...args: TArgs): TResult => {
    const session = requireAuthorizedSession(db, sessionId, token);
    return fn({ db, session }, ...args);
  };
}

function canResumeMonitoring(session: SessionRecord): boolean {
  return session.status === SESSION_STATUS.NeedsAttention
    || session.status === SESSION_STATUS.Error;
}

async function captureSubmissionContext(sessionId: string): Promise<TaskSubmissionContext> {
  try {
    return { beforeOutput: await driverRuntime.capture(sessionId, 80) };
  } catch {
    return {};
  }
}

async function resumeMonitoringAfterIntervention(
  db: StateDB,
  session: SessionRecord,
  context: TaskSubmissionContext,
): Promise<void> {
  const driver = getHarnessDriver(session.agentType);
  const submitted = await driver.afterTaskSubmitted(session.id, driverRuntime, context);
  if (!submitted) {
    throw new Error(
      `Message was sent, but ${session.agentType} did not expose a new turn; session remains ${session.status}`,
    );
  }
  await defaultWakeup.prepare(session.id);
  // Submission and FIFO creation both await external work. A concurrent kill
  // must win even if the driver confirmed a turn before the terminal closed.
  if (!db.compareAndSetStatus(session.id, session.status, SESSION_STATUS.Running, session.version)) {
    // This delivery has already succeeded and passed its driver check above.
    // An independently rearmed row needs no second state transition; it is
    // never used as evidence that this particular message was submitted.
    if (db.getSession(session.id)?.status !== SESSION_STATUS.Running) {
      defaultWakeup.cleanup(session.id);
      throw new Error(`Session ${session.id} changed while sending the message; monitoring was not resumed`);
    }
  }
  if (!daemon.isDaemonRunning()) daemon.startDaemon();
}

export const send = withAuth(async ({ db, session }, message: string) => {
  if (getHarnessDriver(session.agentType).turnHooks) message = normalizeTurnInput(message);
  let submissionContext: TaskSubmissionContext = {};
  await deliverTurn(db, session, message, () => Tmux.sendKeys(session.id, message), {
    prepare: async () => {
      // Even a running row may settle while transport is pending. Keep the
      // pre-send pane so the driver can confirm this delivery before rearming.
      submissionContext = await captureSubmissionContext(session.id);
    },
    afterSend: async registered => {
      if (canResumeMonitoring(registered) || canResumeMonitoring(session)) {
        await resumeMonitoringAfterIntervention(db, canResumeMonitoring(registered) ? registered : { ...registered, status: session.status }, submissionContext);
      }
    },
  });
});

export const capture = withAuth(async ({ session }, lines: number = 50) => {
  return Tmux.capture(session.id, lines);
});

export const sendTask = withAuth(async ({ db, session }, filePath: string) => {
  // Retired harnesses may still have readable, killable session records.
  // Refuse new work before reading or publishing its task file.
  getHarnessDriver(session.agentType);
  if (!isAbsolute(session.projectPath)) {
    throw new Error(
      `Cannot send task: session ${session.id} stores a relative project path and its original working directory is unknown. Launch a new session with an absolute --project path.`,
    );
  }
  const content = readTaskFile(filePath);
  const fileHandoff = planSessionHandoff(session);
  const instruction = normalizeTurnInput(fileHandoff.taskInstruction);
  let submissionContext: TaskSubmissionContext = {};
  await deliverTurn(db, session, instruction, () => Tmux.sendKeys(session.id, instruction), {
    prepare: async () => {
      prepareFileHandoff(fileHandoff, content, { role: session.role, check: session.checkCmd, scope: session.scope, targetFingerprint: session.targetFingerprint, jobId: session.jobId });
      submissionContext = await captureSubmissionContext(session.id);
    },
    afterSend: async registered => {
      if (canResumeMonitoring(registered) || canResumeMonitoring(session)) {
        await resumeMonitoringAfterIntervention(db, canResumeMonitoring(registered) ? registered : { ...registered, status: session.status }, submissionContext);
      }
    },
  });
});

const driverRuntime: DriverRuntime = {
  sleep: (ms) => Bun.sleep(ms),
  capture: (sessionId, lines) => Tmux.capture(sessionId, lines),
  sendKeys: (sessionId, text) => Tmux.sendKeys(sessionId, text),
  sendKey: (sessionId, key) => Tmux.sendKey(sessionId, key),
};

export const switchModel = withAuth(async ({ db, session }, opts: ModelSwitchOptions) => {
  const driver = getHarnessDriver(session.agentType);
  let result: string;
  try {
    result = await driver.switchModel(session.id, driverRuntime, opts);
  } catch (error) {
    if (error instanceof ModelSwitchAppliedError) {
      db.updateModel(session.id, opts.model, opts.effort ?? null);
    }
    throw error;
  }
  // Resume should reuse the latest successful choice. An omitted effort lets
  // the driver choose its default rather than forcing the old model's effort.
  db.updateModel(session.id, opts.model, opts.effort ?? null);
  return result;
});

const POLL_MS = 500;
// ponytail: fixed bounds; a slower TUI only loses its resume ID, never the kill.
const STOP_POLLS = 8;
const EXIT_POLLS = 12;
// The ready check reads the bottom of the pane; the stop-line count reads more
// of it, so an older stop line scrolling up is still counted.
const READY_LINES = 80;
const COUNT_LINES = 200;
const STOP_TAIL_LINES = 15;

type Driver = ReturnType<typeof getHarnessDriver>;

// Typed text plus Enter may go only into the vendor's empty composer. Where a
// driver has an after-turn check, it is the strict one: it vetoes permission,
// menu and question overlays and allows history rows. Never widen it with `||`.
function composerReady(driver: Driver): ((output: string) => boolean) | undefined {
  return driver.acceptsInputAfterTurn?.bind(driver) ?? driver.acceptsInput?.bind(driver);
}

function stopLines(output: string, stopped: RegExp): number {
  return [...output.matchAll(new RegExp(stopped.source, stopped.flags.replace("g", "") + "g"))].length;
}

const tail = (output: string, lines: number) => output.split("\n").slice(-lines).join("\n");

interface StopProof { stopped: RegExp; before: number }

// A ready composer on two identical captures in a row. After an interrupt key
// that is not enough (a reply can pause between chunks): the TUI must also have
// printed a new stop line of its own, near the bottom, since the key.
async function settledScreen(
  sessionId: string,
  ready: (output: string) => boolean,
  proof: StopProof | undefined,
  lease: InterventionLease,
): Promise<string | null> {
  let previous: string | null = null;
  for (let attempt = 0; attempt < STOP_POLLS; attempt++) {
    await Bun.sleep(POLL_MS);
    if (!renewInterventionLease(lease)) return null;
    const output = await Tmux.capture(sessionId, COUNT_LINES);
    const screen = tail(output, READY_LINES);
    const shown = !proof || (stopLines(output, proof.stopped) > proof.before && proof.stopped.test(tail(output, STOP_TAIL_LINES)));
    if (ready(screen) && shown && screen === previous) return screen;
    previous = screen;
  }
  return null;
}

// Take the lease, and move the row version so that a refresh already past its
// lease check cannot nudge or settle this turn with the version it read.
function beginIntervention(db: StateDB, sessionId: string): InterventionLease | null {
  const lease = takeInterventionLease(sessionId);
  if (lease) db.bumpVersion(sessionId);
  return lease;
}

export const interrupt = withAuth(async ({ db, session }) => {
  const driver = getHarnessDriver(session.agentType);
  const ready = composerReady(driver);
  if (!driver.interrupt || !ready) {
    throw new Error(`${session.agentType} has no verified interrupt key; attach with \`tmux attach -t ${session.id}\` and interrupt it there`);
  }
  if (session.status !== SESSION_STATUS.Running && session.status !== SESSION_STATUS.NeedsAttention) {
    throw new Error(`Session ${session.id} is ${session.status}; only a running or flagged turn can be interrupted`);
  }
  if (!(await Tmux.vendorAlive(session.id))) {
    throw new Error(`Session ${session.id} has no running ${session.agentType} in its pane; nothing to interrupt`);
  }
  const lease = beginIntervention(db, session.id);
  if (!lease) throw new Error(`Session ${session.id} is already being interrupted or killed`);
  try {
    const turn = db.getSession(session.id)!;
    const before = stopLines(await Tmux.capture(session.id, COUNT_LINES), driver.interrupt.stopped);
    await Tmux.sendKey(session.id, driver.interrupt.key);
    const output = await settledScreen(session.id, ready, { stopped: driver.interrupt.stopped, before }, lease);
    if (output === null) {
      throw new Error(`Sent ${driver.interrupt.key} to ${session.id}, but it did not show that its turn stopped; it stays ${session.status}. Inspect it with \`capture\`.`);
    }
    // Metadata writes move the version without a new turn or a settlement; only those are retried.
    const archive = new Archive(defaultRuntimeLayout.archiveDir());
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = db.getSession(session.id);
      if (!current || current.status !== turn.status || current.turnStartedAt !== turn.turnStartedAt) {
        throw new Error(`Session ${session.id} changed to ${current?.status ?? "missing"} while it was interrupted; the interrupt key was sent`);
      }
      if (await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.NeedsAttention, {
        status: SESSION_STATUS.NeedsAttention,
        lastOutput: output.slice(-500),
        reason: "interrupted by host",
      }, current.status, current.version)) {
        return `interrupted ${session.id}; it waits for \`send\` or \`task\``;
      }
    }
    throw new Error(`Session ${session.id} kept changing while it was interrupted; the interrupt key was sent`);
  } finally {
    releaseInterventionLease(lease);
  }
});

// Claude, Codex and the TUI drivers print their native ID only as they exit.
// Before a kill takes the terminal, stop the turn and exit the TUI the way a
// person would, so the session stays resumable. Text plus Enter goes only into
// the vendor's ready composer, never into a dialog or the shell left after the
// CLI exits. A running turn gets the interrupt key and must show a new stop
// line; a settled turn gets no key. Any doubt, or any failure here, falls
// through to the kill.
async function preserveResumeId(db: StateDB, session: SessionRecord, screen?: string): Promise<void> {
  if (session.agentResumeId || session.launchPid) return;
  if (session.status !== SESSION_STATUS.Running && session.status !== SESSION_STATUS.NeedsAttention
    && session.status !== SESSION_STATUS.Error) return;
  let driver: Driver;
  try { driver = getHarnessDriver(session.agentType); } catch { return; }
  const ready = composerReady(driver);
  if (driver.resumeTokenAvailableAfterSubmit || !driver.interrupt || !ready) return;
  let lease: InterventionLease | null = null;
  try {
    const running = session.status === SESSION_STATUS.Running;
    // The kill's own archive capture, when there is one, serves as the screen before the key.
    const output = tail(screen ?? await Tmux.capture(session.id, COUNT_LINES), COUNT_LINES);
    if (!running && !ready(tail(output, READY_LINES))) return;
    if (!(await Tmux.vendorAlive(session.id))) return;
    lease = beginIntervention(db, session.id);
    if (!lease) return;
    let proof: StopProof | undefined;
    if (running) {
      proof = { stopped: driver.interrupt.stopped, before: stopLines(output, driver.interrupt.stopped) };
      await Tmux.sendKey(session.id, driver.interrupt.key);
    }
    if (await settledScreen(session.id, ready, proof, lease) === null) return;
    if (!(await Tmux.vendorAlive(session.id))) return;
    await driver.gracefulExit(session.id, driverRuntime);
    for (let attempt = 0; attempt < EXIT_POLLS; attempt++) {
      await Bun.sleep(POLL_MS);
      if (!renewInterventionLease(lease)) return;
      const resumeId = driver.extractResumeToken(await Tmux.capture(session.id, 50));
      if (resumeId) { db.updateResumeId(session.id, resumeId); return; }
    }
  } catch {
    // Best effort: the kill proceeds without a native ID.
  } finally {
    if (lease) { try { releaseInterventionLease(lease); } catch {} }
  }
}

async function stopSession(db: StateDB, session: SessionRecord, descendant = false): Promise<boolean> {
  let archive: Archive | undefined;
  let archiveRevision: string | null = null;
  let shouldCapture = false;
  // Read the row and archive marker under the same lock so a separate
  // settler cannot publish its archive between these two observations.
  const observed = db.immediateTransaction(() => {
    const current = db.getSession(session.id);
    if (!current) return null;
    try {
      archive = new Archive(defaultRuntimeLayout.archiveDir());
      archiveRevision = archive.revision(session.id);
      // A previous turn's archive on a running session is not its final result.
      shouldCapture = current.status === SESSION_STATUS.Running || !archive.get(session.id);
    } catch {}
    return current;
  });
  if (!observed) return false;
  let lastOutput: string | undefined;
  if (shouldCapture) {
    try { lastOutput = await Tmux.capture(session.id, 500); } catch {}
  }
  const hasNewSettlement = (current: SessionRecord): boolean => {
    if (!archive || current.status === SESSION_STATUS.Running || current.launchPid) return false;
    const revision = archive.revision(session.id);
    return revision !== null && revision !== archiveRevision;
  };
  if (descendant) {
    const current = db.getSession(session.id);
    // Settlement while capture awaited owns both the result and its cleanup.
    if (!current || current.status === SESSION_STATUS.Idle
      || current.status === SESSION_STATUS.Dead || current.status === SESSION_STATUS.Error
      || (current.version !== observed.version && hasNewSettlement(current))) return false;
  }
  // After the archive snapshot, so the archive keeps the work rather than the exit screen.
  await preserveResumeId(db, db.getSession(session.id) ?? observed, lastOutput);
  try {
    await Tmux.kill(session.id);
  } catch (error) {
    // Successful tasks may already have had their terminal reclaimed; a
    // reserved launch may not have created it yet. Dead cancels its launch CAS.
    if (await Tmux.hasSession(session.id)) throw error;
  }
  // Capture precedes termination; only then can we commit dead + archive.
  // A version conflict may be metadata, publication, or a re-armed turn.
  // Re-arbitrate under the write lock, preserving only a newer settlement.
  let expected = observed;
  for (let attempt = 0; attempt < 3; attempt++) {
    let committed = false;
    let finished = false;
    try {
      db.immediateTransaction(() => {
        if (attempt > 0) {
          const current = db.getSession(session.id);
          if (!current || hasNewSettlement(current)) { finished = true; return; }
          expected = current;
        }
        if (!db.compareAndSetStatus(session.id, expected.status, SESSION_STATUS.Dead, expected.version)) return;
        if (lastOutput !== undefined) archive!.save(session.id, {
          status: SESSION_STATUS.Dead,
          lastOutput,
          agentResumeId: expected.agentResumeId ?? undefined,
        });
        committed = true;
      });
    } catch {
      // Archive failure rolls the row back. Cancel the launch and record the
      // termination only if this attempt's row has not changed meanwhile.
      committed = db.compareAndSetStatus(session.id, expected.status, SESSION_STATUS.Dead, expected.version);
    }
    if (committed) defaultWakeup.cleanup(session.id);
    if (committed || finished) return true;
  }
  throw new Error(`Session ${session.id} changed repeatedly after termination; kill status was not committed`);
}

export const MAX_TREE_KILL_PASSES = 4;

export interface TreeKillResult { killed: string[]; missed: string[]; }

export const kill = withAuth(async ({ db, session }, opts: { tree?: boolean } = {}): Promise<TreeKillResult | void> => {
  if (!opts.tree) {
    await stopSession(db, session);
    return;
  }

  const killed: string[] = [];
  const seen = new Set<string>();
  for (let pass = 0; pass < MAX_TREE_KILL_PASSES; pass++) {
    const descendants = listActiveDescendants(db, session.id).filter((child) => !seen.has(child.id));
    if (pass > 0 && descendants.length === 0) break;
    for (const child of descendants) {
      seen.add(child.id);
      const current = db.getSession(child.id);
      // A daemon may have settled this child while another kill was awaiting tmux.
      if (!current || current.status === SESSION_STATUS.Idle
        || current.status === SESSION_STATUS.Dead || current.status === SESSION_STATUS.Error) continue;
      try {
        if (await stopSession(db, current, true)) killed.push(child.id);
      } catch {
        // A failed descendant must not prevent stopping its siblings or root.
        // The final scan reports it if it is still active; each ID is tried once.
      }
    }
    if (pass === 0 && db.getSession(session.id)?.status !== SESSION_STATUS.Dead) {
      // Keep root failures authoritative as in plain kill. A dead root still
      // authorizes sweeping its descendants, without another terminal kill.
      await stopSession(db, session);
      killed.push(session.id);
    }
  }
  // Also includes children first registered during the last allowed pass.
  return { killed, missed: listActiveDescendants(db, session.id)
    .filter((child) => !killed.includes(child.id)).map((child) => child.id) };
});

export const logs = withAuth(async ({ session }) => {
  const alive = await Tmux.hasSession(session.id);
  if (alive) return Tmux.capture(session.id, 500);
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const archived = archive.get(session.id);
  if (archived?.lastOutput) return archived.lastOutput;
  if (archived?.reason) return `(no output archived: ${archived.reason})`;
  return "(no logs available)";
});

export function sessionRelationship(session: SessionRecord, callerId: string, caller: SessionRecord | null): "child" | "job peer" | "other" {
  if (session.parentId === callerId) return "child";
  if (session.id !== callerId && caller?.jobId && session.jobId === caller.jobId) return "job peer";
  return "other";
}

export function check(db: StateDB, parentId?: string, jobId?: string, callerId = resolveParentId()) {
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const caller = process.env.AHELPA_PARENT_ID === callerId ? db.getSession(callerId) : null;
  const sessions = jobId !== undefined
    ? db.listJobSessions(jobId).filter((s) => parentId === undefined || s.parentId === parentId)
    : db.listSessions(parentId);
  return sessions.map(s => ({
    ...getSessionNestingInfo(db, s.id),
    id: s.id, agentType: s.agentType, status: s.status,
    ...archive.reasonFor(s),
    relationship: sessionRelationship(s, callerId, caller),
    role: s.role ?? null, model: s.model ?? null, effort: s.effort ?? null,
    task: s.task.slice(0, 80), label: s.label, updatedAt: s.updatedAt,
    agentResumeId: s.agentResumeId ?? null, resumedFrom: s.resumedFrom ?? null,
    afterId: s.afterId ?? null, jobId: s.jobId ?? null, checkCmd: s.checkCmd ?? null, scope: s.scope ?? null, projectPath: s.projectPath,
  }));
}

export function status(db: StateDB, daemonRunning: boolean, callerId = resolveParentId()): string {
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const caller = process.env.AHELPA_PARENT_ID === callerId ? db.getSession(callerId) : null;
  const sessions = db.listSessions();
  let output = `ahelpa daemon: ${daemonRunning ? "running" : "stopped"}\n`;
  output += `sessions: ${sessions.length}\n\n`;
  if (sessions.length === 0) { output += "(no sessions)\n"; return output; }
  output += "ID                    TYPE          ROLE      STATUS    DEPTH PARENT                 JOB          LABEL         RELATIONSHIP AGE\n";
  output += "─".repeat(140) + "\n";
  for (const s of sessions) {
    const age = timeSince(s.createdAt);
    const nesting = getSessionNestingInfo(db, s.id);
    output += `${s.id.padEnd(22)} ${s.agentType.padEnd(14)} ${(s.role ?? "-").padEnd(10)} ${s.status.padEnd(10)} ${String(nesting.depth).padEnd(5)} ${(nesting.parentSessionId || "-").padEnd(22)} ${(s.jobId || "-").padEnd(12)} ${(s.label || "").padEnd(14)} ${sessionRelationship(s, callerId, caller).padEnd(12)} ${age}\n`;
    const { reason } = archive.reasonFor(s);
    if (reason) output += `  reason: ${reason}\n`;
  }
  return output;
}

export interface CleanResult { removed: number; orphanFiles: number; }

// Settled sessions keep their archive copy. Only remove records whose tmux
// session is gone; draining and attention states still need monitoring.
export async function clean(db: StateDB, layout: RuntimeLayout = defaultRuntimeLayout): Promise<CleanResult> {
  const wakeup = new Wakeup(layout);
  const cleanable = db.listSessions().filter((session) =>
    session.status === SESSION_STATUS.Dead
      || session.status === SESSION_STATUS.Idle
      || session.status === SESSION_STATUS.Error,
  );
  // Decide terminal liveness before deleting any ancestor: settled children
  // may still own a terminal, including the idle -> draining settle window.
  const absent = new Set<string>();
  for (const session of cleanable) {
    if (!await Tmux.hasSession(session.id)) absent.add(session.id);
  }
  let removed = 0;
  db.immediateTransaction(() => {
    // Launch/settle may have changed records while liveness checks awaited.
    const current = db.listSessions();
    const deletable = new Set(current.filter((session) => absent.has(session.id)
      && (session.status === SESSION_STATUS.Dead
        || session.status === SESSION_STATUS.Idle || session.status === SESSION_STATUS.Error))
      .map((session) => session.id));
    const retained = activeSessionAncestorIds(db,
      current.filter((session) => !deletable.has(session.id)).map((session) => session.id));
    for (const id of deletable) {
      if (retained.has(id)) continue;
      wakeup.cleanup(id);
      try { unlinkSync(layout.taskFilePath(id)); } catch {}
      db.deleteSession(id);
      removed++;
    }
  });
  return { removed, orphanFiles: await sweepOrphanFiles(db, layout) };
}

// Pipes and task files whose session record no longer exists have no other
// reclamation path — session ids are random, so they pile up forever.
async function sweepOrphanFiles(db: StateDB, layout: RuntimeLayout): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(layout.tmpDir);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const entry of entries) {
    const sessionId = entry.endsWith(".pipe")
      ? entry.slice(0, -".pipe".length)
      : entry.startsWith("ahelpa-task-") && entry.endsWith(".md")
        ? entry.slice("ahelpa-task-".length, -".md".length)
        : null;
    if (!sessionId || db.getSession(sessionId)) continue;
    // A live terminal still owns its files even if a legacy launch or an
    // interrupted operation left them without a registered database row.
    if (await Tmux.hasSession(sessionId)) continue;
    if (db.getSession(sessionId)) continue;
    try {
      unlinkSync(join(layout.tmpDir, entry));
      swept++;
    } catch {}
  }
  return swept;
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
