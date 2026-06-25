// Operations on an existing session: everything a caller can do to a helper
// after launch, except waiting (wait.ts owns the wakeup protocol). The
// token-gated ops all share the same access rule: only the owner may act.

import { StateDB, type SessionRecord } from "../state";
import { Tmux } from "../tmux";
import { Archive } from "../archive";
import { defaultWakeup, Wakeup } from "../wakeup";
import { SESSION_STATUS } from "../session-lifecycle";
import { requireAuthorizedSession } from "../session-access";
import { getSessionNestingInfo } from "../nesting";
import { defaultRuntimeLayout, RuntimeLayout } from "../runtime-layout";
import { planFileHandoff, prepareFileHandoff } from "../file-handoff";
import { getDriver } from "../drivers/registry";
import type { DriverRuntime, ModelSwitchOptions } from "../drivers/types";
import { readFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";

interface AuthContext { db: StateDB; session: SessionRecord; }

function withAuth<TArgs extends any[], TResult>(
  fn: (ctx: AuthContext, ...args: TArgs) => TResult,
) {
  return (db: StateDB, sessionId: string, token: string, ...args: TArgs): TResult => {
    const session = requireAuthorizedSession(db, sessionId, token);
    return fn({ db, session }, ...args);
  };
}

export const send = withAuth(async ({ db, session }, message: string) => {
  await Tmux.sendKeys(session.id, message);
  // Host intervened — resume daemon monitoring
  if (session.status === SESSION_STATUS.NeedsAttention) {
    db.updateStatus(session.id, SESSION_STATUS.Running);
  }
});

export const capture = withAuth(async ({ session }, lines: number = 50) => {
  return Tmux.capture(session.id, lines);
});

export const sendTask = withAuth(async ({ session }, filePath: string) => {
  const content = readFileSync(filePath, "utf-8");
  const fileHandoff = planFileHandoff(session.projectPath, session.id);
  prepareFileHandoff(fileHandoff, content);
  await Tmux.sendKeys(session.id, fileHandoff.taskInstruction);
});

const driverRuntime: DriverRuntime = {
  sleep: (ms) => Bun.sleep(ms),
  capture: (sessionId, lines) => Tmux.capture(sessionId, lines),
  sendKeys: (sessionId, text) => Tmux.sendKeys(sessionId, text),
  sendKey: (sessionId, key) => Tmux.sendKey(sessionId, key),
};

export const switchModel = withAuth(async ({ session }, opts: ModelSwitchOptions) => {
  const driver = getDriver(session.agentType);
  return driver.switchModel(session.id, driverRuntime, opts);
});

export const kill = withAuth(async ({ db, session }) => {
  await Tmux.kill(session.id);
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

export function check(db: StateDB, parentId?: string) {
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const sessions = db.listSessions(parentId);
  return sessions.map(s => {
    const base = {
      ...getSessionNestingInfo(db, s.id),
      id: s.id, agentType: s.agentType, status: s.status,
      task: s.task.slice(0, 80), label: s.label, updatedAt: s.updatedAt,
      agentResumeId: s.agentResumeId ?? null, resumedFrom: s.resumedFrom ?? null,
    };
    if (s.status === SESSION_STATUS.NeedsAttention) {
      const archived = archive.get(s.id);
      return { ...base, lastOutput: archived?.lastOutput };
    }
    return base;
  });
}

export function status(db: StateDB, daemonRunning: boolean): string {
  const sessions = db.listSessions();
  let output = `ahelpa daemon: ${daemonRunning ? "running" : "stopped"}\n`;
  output += `sessions: ${sessions.length}\n\n`;
  if (sessions.length === 0) { output += "(no sessions)\n"; return output; }
  output += "ID                    TYPE          STATUS    DEPTH PARENT                 LABEL         AGE\n";
  output += "─".repeat(104) + "\n";
  for (const s of sessions) {
    const age = timeSince(s.createdAt);
    const nesting = getSessionNestingInfo(db, s.id);
    output += `${s.id.padEnd(22)} ${s.agentType.padEnd(14)} ${s.status.padEnd(10)} ${String(nesting.depth).padEnd(5)} ${(nesting.parentSessionId || "-").padEnd(22)} ${(s.label || "").padEnd(14)} ${age}\n`;
  }
  return output;
}

export interface CleanResult { removed: number; orphanFiles: number; }

// Dead sessions keep their archive copy; clean only drops the DB record and
// any leftover pipe or task file. Live sessions go through kill instead.
export function clean(db: StateDB, layout: RuntimeLayout = defaultRuntimeLayout): CleanResult {
  const wakeup = new Wakeup(layout);
  const cleanable = db.listSessions().filter((session) =>
    session.status === SESSION_STATUS.Dead || session.status === SESSION_STATUS.Draining,
  );
  for (const session of cleanable) {
    wakeup.cleanup(session.id);
    try { unlinkSync(layout.taskFilePath(session.id)); } catch {}
  }
  const removed = db.deleteSessionsByStatus(SESSION_STATUS.Dead)
    + db.deleteSessionsByStatus(SESSION_STATUS.Draining);
  return { removed, orphanFiles: sweepOrphanFiles(db, layout) };
}

// Pipes and task files whose session record no longer exists have no other
// reclamation path — session ids are random, so they pile up forever.
function sweepOrphanFiles(db: StateDB, layout: RuntimeLayout): number {
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
