import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { getSelfCommand } from "./self-command";
import { readTurnEvents } from "./turn-hooks";
import { StateDB, type SessionRecord } from "./state";
import { Tmux } from "./tmux";
import { Archive } from "./archive";
import { Wakeup, defaultWakeup } from "./wakeup";
import { settle } from "./settle";
import { getDriver } from "./drivers/registry";
import { SESSION_STATUS, outcomeFromCapture } from "./session-lifecycle";
import { defaultRuntimeLayout } from "./runtime-layout";
import { shellEscape } from "./shell";
import type { AgentDriver, DriverRuntime } from "./drivers/types";
import { planFileHandoff } from "./file-handoff";

const AHELPA_DIR = defaultRuntimeLayout.ahelpaHomeDir();
const PID_FILE = defaultRuntimeLayout.daemonPidPath();
const LOG_FILE = defaultRuntimeLayout.daemonLogPath();
export const DAEMON_SUBCOMMAND = "__daemon";

// Runtime files are disposable; the session record retains the result,
// ownership, and resume token until the caller explicitly runs `clean`.
function cleanupSessionFiles(sessionId: string): void {
  const wakeup = new Wakeup();
  wakeup.cleanup(sessionId);
  try { unlinkSync(defaultRuntimeLayout.taskFilePath(sessionId)); } catch {}
}

// ponytail: 15s is generous for /exit or Escape; bump if a driver needs longer cleanup
const DRAIN_TIMEOUT_MS = 15_000;
// Codex is slowest: 2s grace + 20 input polls + 60 MCP polls + 10 x 0.5s
// submission = 87s. Three minutes leaves room for tmux/file/worktree setup,
// while bounding stale reservations whose numeric PID has been reused.
export const LAUNCH_STARTUP_LEASE_MS = 180_000;
const drainingAt = new Map<string, number>();
// ponytail: debounce — only flag after N consecutive polls with no working signal.
// 4 polls × 3s = ~12s of inactivity before escalating. Startup is handled by
// prepareForTask, so the daemon only polls once the agent should be working.
const idleCount = new Map<string, number>();
const IDLE_DEBOUNCE = 4;
// One completion nudge per session (persisted on the row). Deliberately names
// no sentinel token so the echoed prompt can never be mistaken for the signal.
export const COMPLETION_NUDGE = "If your task is finished, print the done signal from the task file alone on a line; if not, continue working.";

export function shouldNudgeForCompletion(db: StateDB, session: SessionRecord, driver: AgentDriver, output: string, turnEnded = false): boolean {
  const ready = turnEnded && driver.acceptsInputAfterTurn
    ? driver.acceptsInputAfterTurn(output)
    : driver.acceptsInput?.(output);
  if (!ready) return false;
  if (!existsSync(planFileHandoff(session.projectPath, session.id).summaryPath)) return false;
  // Re-read: the host may have sent a new turn since this capture was taken.
  const fresh = db.getSession(session.id);
  return fresh !== null
    && fresh.status === SESSION_STATUS.Running
    && fresh.version === session.version
    && fresh.nudgedAt == null;
}

const driverRuntime: DriverRuntime = {
  sleep: (ms) => Bun.sleep(ms),
  capture: (sid, lines) => Tmux.capture(sid, lines),
  sendKeys: (sid, text) => Tmux.sendKeys(sid, text),
  sendKey: (sid, key) => Tmux.sendKey(sid, key),
};

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(defaultRuntimeLayout.daemonLogPath(), line);
  } catch {
    // ignore log errors
  }
}

async function finishMissingSession(db: StateDB, archive: Archive, session: SessionRecord): Promise<void> {
  if (session.status === SESSION_STATUS.Running || session.status === SESSION_STATUS.NeedsAttention) {
    const settled = await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.Dead, {
      status: SESSION_STATUS.Dead,
      reason: "tmux session gone",
    }, session.status, session.version);
    // A stale liveness result must also leave the new turn's runtime files intact.
    if (!settled) return;
  } else if (session.status === SESSION_STATUS.Draining) {
    // Draining is cleanup after successful settlement, not a new result.
    db.compareAndSetStatus(session.id, SESSION_STATUS.Draining, SESSION_STATUS.Idle);
  }
  drainingAt.delete(session.id);
  idleCount.delete(session.id);
  cleanupSessionFiles(session.id);
}

export async function refreshSessionStatuses(
  db: StateDB,
  sessionIds?: string[],
  nowMs: number = Date.now(),
): Promise<void> {
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const targetIds = sessionIds ? new Set(sessionIds) : null;
  const sessions = db.listSessions()
    .filter((session) => session.status !== SESSION_STATUS.Dead)
    .filter((session) => !targetIds || targetIds.has(session.id));

  for (let session of sessions) {
    try {
      if (session.launchPid) {
        let launcherAlive = true;
        try { process.kill(session.launchPid, 0); } catch (error) {
          launcherAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        const leaseExpired = nowMs - Date.parse(session.createdAt) >= LAUNCH_STARTUP_LEASE_MS;
        if (launcherAlive && !leaseExpired) continue;
        // An exited launcher or expired lease no longer owns startup. Resume
        // has no new task yet; ordinary launches resume normal monitoring.
        if (!db.completeLaunch(session.id, session.launchPid, undefined,
          session.resumedFrom ? SESSION_STATUS.NeedsAttention : undefined)) continue;
        const current = db.getSession(session.id);
        if (!current) continue;
        session = current;
      }
      const alive = await Tmux.hasSession(session.id);
      if (!alive) {
        await finishMissingSession(db, archive, session);
        continue;
      }

      if (session.status === SESSION_STATUS.Draining) {
        // Capture agent resume token while session is still alive
        if (!session.agentResumeId) {
          try {
            const output = await Tmux.capture(session.id, 50);
            const driver = getDriver(session.agentType);
            const resumeId = driver.extractResumeToken(output);
            if (resumeId) {
              db.updateResumeId(session.id, resumeId);
              log(`${session.id}: captured resume token`);
            }
          } catch (error) {
            log(`${session.id}: resume token capture failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Inline refresh and restarted daemons must honor the existing drain
        // window instead of killing immediately because their map is empty.
        const persistedStartedAt = Date.parse(session.updatedAt);
        const startedAt = drainingAt.get(session.id)
          ?? (Number.isFinite(persistedStartedAt) ? persistedStartedAt : nowMs);
        drainingAt.set(session.id, startedAt);
        if (nowMs - startedAt > DRAIN_TIMEOUT_MS) {
          await Tmux.kill(session.id);
          await finishMissingSession(db, archive, session);
          log(`${session.id}: drain complete, runtime cleaned up`);
        }
        continue;
      }

      if (session.status !== SESSION_STATUS.Running) continue;

      const output = await Tmux.capture(session.id, 30);
      const driver = getDriver(session.agentType);
      const outcome = outcomeFromCapture(output, driver);
      const newStatus = outcome.status;
      const turn = driver.turnHooks
        ? readTurnEvents(defaultRuntimeLayout.turnsLogPath(session.projectPath, session.id), session.turnHookOffset ?? 0,
          session.turnStartedAt ?? session.createdAt, session.agentType)
        : { offset: session.turnHookOffset ?? 0, event: null };
      if (newStatus !== SESSION_STATUS.Running) {
        // Snapshot before settle awaits the wakeup, so a later model switch cannot relabel this event.
        const ledgerSession = db.getSession(session.id) ?? session;
        idleCount.delete(session.id);
        const settled = await settle(db, archive, defaultWakeup, session.id, newStatus, {
          status: newStatus,
          lastOutput: output.slice(-500),
        }, SESSION_STATUS.Running, session.version);
        if (!settled) continue;
        if (newStatus === SESSION_STATUS.Error && outcome.needHelpTags !== null) {
          try {
            mkdirSync(defaultRuntimeLayout.ahelpaHomeDir(), { recursive: true });
            // Not crash-atomic with SQLite: a crash or wakeup failure between settle commit and append loses the line.
            appendFileSync(defaultRuntimeLayout.needHelpLedgerPath(), JSON.stringify({
              ts: new Date().toISOString(),
              sessionId: ledgerSession.id,
              parentId: ledgerSession.parentId,
              agentType: ledgerSession.agentType,
              role: ledgerSession.role || null,
              model: ledgerSession.model || null,
              effort: ledgerSession.effort || null,
              safe: ledgerSession.safe,
              projectPath: ledgerSession.projectPath,
              tags: outcome.needHelpTags,
              summaryPath: planFileHandoff(ledgerSession.projectPath, ledgerSession.id).summaryPath,
            }) + "\n");
          } catch (error) {
            log(`${session.id}: need-help ledger append failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (newStatus === SESSION_STATUS.Idle) {
          try { await driver.gracefulExit(session.id, driverRuntime); } catch {}
          // The host may have killed the helper while graceful exit awaited
          // tmux. A conditional SQL update also protects separate processes.
          if (db.compareAndSetStatus(session.id, SESSION_STATUS.Idle, SESSION_STATUS.Draining)) {
            drainingAt.set(session.id, nowMs);
            log(`${session.id}: sent graceful exit, draining`);
          }
        }
      } else if (turn.event) {
        const summary = existsSync(planFileHandoff(session.projectPath, session.id).summaryPath);
        const failure = turn.event.event === "stop_failure";
        // Stop can precede engine shutdown. Keep it pending until the composer
        // is ready, rather than consume it and lose the early-nudge opportunity.
        if (!failure && summary && session.nudgedAt == null) {
          if (shouldNudgeForCompletion(db, session, driver, output, true)) {
            if (!db.consumeTurnHook(session.id, session.version, turn.offset, true)) continue;
            idleCount.delete(session.id);
            await Tmux.sendKeys(session.id, COMPLETION_NUDGE);
            log(`${session.id}: summary present without signal, nudged for completion (turn hook)`);
            continue;
          }
          if (driver.detectActivity(output) !== "idle") {
            idleCount.delete(session.id);
            continue;
          }
          // A permanent menu/approval must still reach the inactivity fallback.
          const count = (idleCount.get(session.id) ?? 0) + 1;
          idleCount.set(session.id, count);
          if (count < IDLE_DEBOUNCE) continue;
        }
        if (!db.consumeTurnHook(session.id, session.version, turn.offset)) continue;
        idleCount.delete(session.id);
        const settled = await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.NeedsAttention, {
          status: SESSION_STATUS.NeedsAttention,
          lastOutput: output.slice(-500),
          reason: failure ? `turn hook stop_failure: ${turn.event.error}` : "turn ended without signal",
        }, SESSION_STATUS.Running, session.version + 1);
        if (settled) log(`${session.id}: needs attention (turn hook ${turn.event.event}${failure ? `: ${turn.event.error}` : ""})`);
      } else if (driver.detectActivity(output) !== "idle") {
        idleCount.delete(session.id);
      } else {
        const count = (idleCount.get(session.id) ?? 0) + 1;
        idleCount.set(session.id, count);
        if (count >= IDLE_DEBOUNCE) {
          idleCount.delete(session.id);
          // Archived Claude sessions: 47 of 63 needs_attention had already written
          // summary.md and simply never printed the signal. Ask once before settling,
          // but only into a composer that is really ready: a menu, approval, or trust
          // dialog also reads as idle, and sendKeys ends with Enter.
          if (shouldNudgeForCompletion(db, session, driver, output)) {
            db.markNudged(session.id);
            await Tmux.sendKeys(session.id, COMPLETION_NUDGE);
            log(`${session.id}: summary present without signal, nudged for completion`);
            continue;
          }
          const settled = await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.NeedsAttention, {
            status: SESSION_STATUS.NeedsAttention,
            lastOutput: output.slice(-500),
          }, SESSION_STATUS.Running, session.version);
          if (settled) log(`${session.id}: needs attention (idle ${count} polls)`);
        }
      }
    } catch (error) {
      log(`${session.id}: refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      // tmux can disappear between has-session and capture/kill. Reconcile
      // that race immediately; other failures stay eligible for the next poll.
      try {
        if (!await Tmux.hasSession(session.id)) {
          const current = db.getSession(session.id);
          if (current) await finishMissingSession(db, archive, current);
        }
      } catch (recoveryError) {
        log(`${session.id}: recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
    }
  }
}

export async function daemonLoop(db: StateDB): Promise<void> {
  while (true) {
    const sessions = db.listActiveSessions();
    if (sessions.length === 0) break; // Auto-exit when no sessions

    await refreshSessionStatuses(db);

    await Bun.sleep(3000); // Poll every 3 seconds
  }
}

export function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getDaemonLaunchCommand(
  execPath: string = process.execPath,
  moduleDir: string = import.meta.dir,
): string[] {
  return [...getSelfCommand(execPath, moduleDir), DAEMON_SUBCOMMAND];
}

export function spawnDetached(command: string[], logPath?: string): number {
  // Route the detached process's own stdout/stderr to a log instead of
  // /dev/null, so a daemon that crashes on startup leaves a trace to debug
  // (previously the crash was silently swallowed and the daemon just appeared
  // "stopped").
  const redirect = logPath
    ? `>>${shellEscape(logPath)} 2>&1`
    : ">/dev/null 2>&1";
  const shellCommand = `nohup ${command.map(shellEscape).join(" ")} ${redirect} & echo $!`;
  const proc = Bun.spawnSync(["/bin/sh", "-c", shellCommand], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const errorText = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
    throw new Error(`Failed to start detached process${errorText ? `: ${errorText}` : ""}`);
  }
  const output = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
  const pid = parseInt(output.trim(), 10);
  if (Number.isNaN(pid) || pid <= 0) {
    throw new Error(`Failed to start detached process: ${output.trim()}`);
  }
  return pid;
}

export function startDaemon(): void {
  if (isDaemonRunning()) return;

  mkdirSync(AHELPA_DIR, { recursive: true });

  try {
    const pid = spawnDetached(getDaemonLaunchCommand(), LOG_FILE);
    writeFileSync(PID_FILE, String(pid));
  } catch {
    // ignore startup errors; caller will observe daemon as stopped
  }
}

export function stopDaemon(): void {
  if (!existsSync(PID_FILE)) return;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process may already be gone
      }
    }
  } finally {
    try {
      unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }
}
