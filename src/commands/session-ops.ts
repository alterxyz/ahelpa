// Operations on an existing session: everything a caller can do to a helper
// after launch, except waiting (wait.ts owns the wakeup protocol). The
// token-gated ops all share the same access rule: only the owner may act.

import { StateDB, type SessionRecord } from "../state";
import { Tmux } from "../tmux";
import { Archive } from "../archive";
import { defaultWakeup, Wakeup } from "../wakeup";
import { SESSION_STATUS } from "../session-lifecycle";
import { requireAuthorizedSession } from "../session-access";
import { activeSessionAncestorIds, getSessionNestingInfo } from "../nesting";
import { defaultRuntimeLayout, RuntimeLayout } from "../runtime-layout";
import { planFileHandoff, prepareFileHandoff } from "../file-handoff";
import { getDriver } from "../drivers/registry";
import type { DriverRuntime, ModelSwitchOptions, TaskSubmissionContext } from "../drivers/types";
import * as daemon from "../daemon";
import { ModelSwitchAppliedError } from "../drivers/types";
import { unlinkSync, readdirSync } from "fs";
import { isAbsolute, join } from "path";
import { readTaskFile } from "../task-input";

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
  const driver = getDriver(session.agentType);
  const submitted = await driver.afterTaskSubmitted(session.id, driverRuntime, context);
  if (!submitted) {
    throw new Error(
      `Message was sent, but ${session.agentType} did not expose a new turn; session remains ${session.status}`,
    );
  }
  await defaultWakeup.prepare(session.id);
  // Submission and FIFO creation both await external work. A concurrent kill
  // must win even if the driver confirmed a turn before the terminal closed.
  if (!db.compareAndSetStatus(session.id, session.status, SESSION_STATUS.Running)
    && db.getSession(session.id)?.status !== SESSION_STATUS.Running) {
    defaultWakeup.cleanup(session.id);
    throw new Error(`Session ${session.id} changed while sending the message; monitoring was not resumed`);
  }
  if (!daemon.isDaemonRunning()) daemon.startDaemon();
}

export const send = withAuth(async ({ db, session }, message: string) => {
  const submissionContext = canResumeMonitoring(session)
    ? await captureSubmissionContext(session.id)
    : {};
  await Tmux.sendKeys(session.id, message);
  // Host intervened — resume daemon monitoring
  if (canResumeMonitoring(session)) {
    await resumeMonitoringAfterIntervention(db, session, submissionContext);
  }
});

export const capture = withAuth(async ({ session }, lines: number = 50) => {
  return Tmux.capture(session.id, lines);
});

export const sendTask = withAuth(async ({ db, session }, filePath: string) => {
  if (!isAbsolute(session.projectPath)) {
    throw new Error(
      `Cannot send task: session ${session.id} stores a relative project path and its original working directory is unknown. Launch a new session with an absolute --project path.`,
    );
  }
  const content = readTaskFile(filePath);
  const fileHandoff = planFileHandoff(session.projectPath, session.id);
  prepareFileHandoff(fileHandoff, content, { role: session.role, check: session.checkCmd });
  const submissionContext = canResumeMonitoring(session)
    ? await captureSubmissionContext(session.id)
    : {};
  await Tmux.sendKeys(session.id, fileHandoff.taskInstruction);
  if (canResumeMonitoring(session)) {
    await resumeMonitoringAfterIntervention(db, session, submissionContext);
  }
});

const driverRuntime: DriverRuntime = {
  sleep: (ms) => Bun.sleep(ms),
  capture: (sessionId, lines) => Tmux.capture(sessionId, lines),
  sendKeys: (sessionId, text) => Tmux.sendKeys(sessionId, text),
  sendKey: (sessionId, key) => Tmux.sendKey(sessionId, key),
};

export const switchModel = withAuth(async ({ db, session }, opts: ModelSwitchOptions) => {
  const driver = getDriver(session.agentType);
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

export const kill = withAuth(async ({ db, session }) => {
  try {
    await Tmux.kill(session.id);
  } catch (error) {
    // Successful tasks may already have had their terminal reclaimed.
    if (await Tmux.hasSession(session.id)) throw error;
  }
  defaultWakeup.cleanup(session.id);
  db.updateStatus(session.id, SESSION_STATUS.Dead);
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

export function check(db: StateDB, parentId?: string, jobId?: string) {
  const sessions = jobId !== undefined
    ? db.listJobSessions(jobId).filter((s) => parentId === undefined || s.parentId === parentId)
    : db.listSessions(parentId);
  return sessions.map(s => ({
    ...getSessionNestingInfo(db, s.id),
    id: s.id, agentType: s.agentType, status: s.status,
    role: s.role ?? null, model: s.model ?? null, effort: s.effort ?? null,
    task: s.task.slice(0, 80), label: s.label, updatedAt: s.updatedAt,
    agentResumeId: s.agentResumeId ?? null, resumedFrom: s.resumedFrom ?? null,
    afterId: s.afterId ?? null, jobId: s.jobId ?? null, checkCmd: s.checkCmd ?? null, projectPath: s.projectPath,
  }));
}

export function status(db: StateDB, daemonRunning: boolean): string {
  const sessions = db.listSessions();
  let output = `ahelpa daemon: ${daemonRunning ? "running" : "stopped"}\n`;
  output += `sessions: ${sessions.length}\n\n`;
  if (sessions.length === 0) { output += "(no sessions)\n"; return output; }
  output += "ID                    TYPE          ROLE      STATUS    DEPTH PARENT                 JOB          LABEL         AGE\n";
  output += "─".repeat(127) + "\n";
  for (const s of sessions) {
    const age = timeSince(s.createdAt);
    const nesting = getSessionNestingInfo(db, s.id);
    output += `${s.id.padEnd(22)} ${s.agentType.padEnd(14)} ${(s.role ?? "-").padEnd(10)} ${s.status.padEnd(10)} ${String(nesting.depth).padEnd(5)} ${(nesting.parentSessionId || "-").padEnd(22)} ${(s.jobId || "-").padEnd(12)} ${(s.label || "").padEnd(14)} ${age}\n`;
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
