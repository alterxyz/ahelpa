import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, renameSync } from "fs";
import { getSelfCommand } from "./self-command";
import { readTurnEvents } from "./turn-hooks";
import { interventionLeaseActive } from "./intervention-lease";
import { StateDB, type SessionRecord } from "./state";
import { Tmux } from "./tmux";
import { Archive } from "./archive";
import { Wakeup, defaultWakeup } from "./wakeup";
import { settle } from "./settle";
import { getHarnessDriver, REMOVED_DSH_MESSAGE } from "./drivers/registry";
import { SESSION_STATUS, outcomeFromCapture } from "./session-lifecycle";
import { defaultRuntimeLayout } from "./runtime-layout";
import { shellEscape } from "./shell";
import type { AgentDriver, DriverRuntime } from "./drivers/types";
import { deliverTurn } from "./turn-delivery";
import { planSessionHandoff } from "./file-handoff";
import { FIFO } from "./fifo";

const AHELPA_DIR = defaultRuntimeLayout.ahelpaHomeDir();
const PID_FILE = defaultRuntimeLayout.daemonPidPath();
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
const LOG_MAX_BYTES = 10_000_000;
const LOG_BACKUP_COUNT = 3;
const LOG_REPEAT_INTERVAL_MS = 60_000;
// ponytail: per-process dedupe keeps only the oldest-first 1000 message keys;
// pending counts are discarded on eviction, settlement, or process exit.
const LOG_MAX_KEYS = 1000;
const repeatedLogs = new Map<string, { firstMs: number; lastMs: number; count: number }>();
// ponytail: 99 skipped calls caps retry intervals at 300s with 3s polling.
// Inline refresh counts calls too; short-lived CLI processes start fresh.
const REFRESH_MAX_SKIP = 99;
const refreshFailures = new Map<string, { version: number; skip: number; nextSkip: number }>();
// A failing snapshot silently degrades every refresh to per-session probes, so
// the transition is logged once. The reconciliation in refreshSessionStatuses
// drops every non-session key from repeatedLogs, so dedupe cannot live there.
let livenessSnapshotFailed = false;

export function resetLivenessSnapshotState(): void {
  livenessSnapshotFailed = false;
}

function clearSessionFailures(sessionId: string): void {
  refreshFailures.delete(sessionId);
  for (const message of repeatedLogs.keys()) {
    if (message.startsWith(`${sessionId}:`)) repeatedLogs.delete(message);
  }
}
// A draft/new user row can briefly look like the old error's idle composer.
// Require the driver attention outcome on two polls of the same row version.
const pendingAttention = new Map<string, { version: number; reason?: string }>();
// One completion nudge per session (persisted on the row). Deliberately names
// no sentinel token so the echoed prompt can never be mistaken for the signal.
export const COMPLETION_NUDGE = "If your task is finished, print the done signal from the task file alone on a line; if not, continue working.";

export function shouldNudgeForCompletion(db: StateDB, session: SessionRecord, driver: AgentDriver, output: string, turnEnded = false): boolean {
  const ready = turnEnded && driver.acceptsInputAfterTurn
    ? driver.acceptsInputAfterTurn(output)
    : driver.acceptsInput?.(output);
  if (!ready) return false;
  if (!existsSync(planSessionHandoff(session).summaryPath)) return false;
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
  try {
    const now = Date.now();
    const previous = repeatedLogs.get(message);
    let text = message;
    if (previous) {
      previous.count++;
      if (now - previous.lastMs < LOG_REPEAT_INTERVAL_MS) return;
      text += ` (repeated ${previous.count} times since ${new Date(previous.firstMs).toISOString()})`;
    }
    const path = defaultRuntimeLayout.daemonLogPath();
    // ponytail: best-effort rotation, no cross-process lock; the last append
    // can exceed 10 MB by one line. Raw subprocess stderr is not managed here.
    try {
      if (statSync(path).size >= LOG_MAX_BYTES) {
        for (let suffix = LOG_BACKUP_COUNT; suffix >= 1; suffix--) {
          try { renameSync(suffix === 1 ? path : `${path}.${suffix - 1}`, `${path}.${suffix}`); } catch {}
        }
      }
    } catch {}
    appendFileSync(path, `[${new Date(now).toISOString()}] ${text}\n`);
    // Failed appends must remain eligible on the next call, retaining any
    // pending repeats instead of claiming a line was successfully written.
    if (previous) {
      previous.count = 0;
      previous.firstMs = now;
      previous.lastMs = now;
    } else {
      if (repeatedLogs.size >= LOG_MAX_KEYS) repeatedLogs.delete(repeatedLogs.keys().next().value!);
      repeatedLogs.set(message, { firstMs: now, lastMs: now, count: 0 });
    }
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
  pendingAttention.delete(session.id);
  clearSessionFailures(session.id);
  cleanupSessionFiles(session.id);
}

// signalsOnly: a refresh between polls, after a turn-end hook woke the daemon.
// It settles only on a sentinel; idle counts, nudges, hook settlements and
// retry backoff keep the poll's pace, so a wake never spends another helper's
// patience.
export async function refreshSessionStatuses(
  db: StateDB,
  sessionIds?: string[],
  nowMs: number = Date.now(),
  signalsOnly = false,
): Promise<void> {
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const targetIds = sessionIds ? new Set(sessionIds) : null;
  const nonDeadSessions = db.listSessions().filter((session) => session.status !== SESSION_STATUS.Dead);
  // A row launched after this snapshot is not compared against it: reserveSession
  // always writes launchPid, and the launcher short-circuit below skips the row
  // while its launcher is alive inside the startup lease.
  // A failed snapshot says nothing about liveness: retain the per-session
  // probes for this refresh so a tmux connection error cannot settle all rows.
  let liveSessions: Set<string> | undefined;
  try {
    liveSessions = await Tmux.liveSessionNames();
    if (livenessSnapshotFailed) {
      livenessSnapshotFailed = false;
      log("liveness snapshot recovered");
    }
  } catch (error) {
    if (!livenessSnapshotFailed) {
      livenessSnapshotFailed = true;
      log(`liveness snapshot failed, probing sessions individually: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const isAlive = (id: string): Promise<boolean> | boolean =>
    liveSessions ? liveSessions.has(id) : Tmux.hasSession(id);
  const nonDeadIds = new Set(nonDeadSessions.map(session => session.id));
  // Host-side kill/clean can settle or remove rows without this monitor's
  // cleanup paths. Reconcile against the full list, even for targeted refresh.
  for (const id of refreshFailures.keys()) {
    if (!nonDeadIds.has(id)) refreshFailures.delete(id);
  }
  for (const message of repeatedLogs.keys()) {
    if (!nonDeadIds.has(message.slice(0, message.indexOf(":")))) repeatedLogs.delete(message);
  }
  const sessions = nonDeadSessions.filter((session) => !targetIds || targetIds.has(session.id));
  const runningIds = new Set(sessions.filter(session => session.status === SESSION_STATUS.Running).map(session => session.id));
  for (const id of pendingAttention.keys()) {
    if ((!targetIds || targetIds.has(id)) && !runningIds.has(id)) pendingAttention.delete(id);
  }

  for (let session of sessions) {
    let retry = refreshFailures.get(session.id);
    if (retry && retry.version !== session.version) {
      clearSessionFailures(session.id);
      retry = undefined;
    }
    if (signalsOnly && retry) continue;
    if (retry && retry.skip > 0) {
      retry.skip--;
      // Back off capture/diagnostics, never recognition of a vanished tmux.
      // A failing liveness probe stays silent until the next scheduled retry.
      let alive: boolean;
      try {
        alive = await isAlive(session.id);
      } catch { continue; }
      if (!alive) {
        try {
          await finishMissingSession(db, archive, session);
        } catch (recoveryError) {
          log(`${session.id}: recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
        }
      }
      continue;
    }
    let failed = false;
    try {
      if (session.status !== SESSION_STATUS.Running || session.launchPid) pendingAttention.delete(session.id);
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
      const alive = await isAlive(session.id);
      if (!alive) {
        await finishMissingSession(db, archive, session);
        continue;
      }

      if (session.status === SESSION_STATUS.Draining) {
        // Capture agent resume token while session is still alive
        if (!session.agentResumeId && session.agentType !== "dsh") {
          try {
            const output = await Tmux.capture(session.id, 50);
            const driver = getHarnessDriver(session.agentType);
            const resumeId = driver.extractResumeToken?.(output);
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
          clearSessionFailures(session.id);
        }
        continue;
      }

      // Removed harnesses retain their rows and terminals for inspection/kill.
      // Flag unfinished work once without attempting the deleted driver, and
      // keep the generic missing-session and draining cleanup above available.
      if (session.agentType === "dsh") {
        if (session.status === SESSION_STATUS.Running) {
          let lastOutput: string | undefined;
          try { lastOutput = await Tmux.capture(session.id, 500); } catch {}
          const settled = await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.NeedsAttention, {
            status: SESSION_STATUS.NeedsAttention,
            lastOutput,
            reason: REMOVED_DSH_MESSAGE,
          }, session.status, session.version);
          if (settled) {
            idleCount.delete(session.id);
            pendingAttention.delete(session.id);
            clearSessionFailures(session.id);
          }
        }
        continue;
      }

      // A host interrupt is pressing keys; leave the turn to it.
      if (interventionLeaseActive(session.id)) continue;

      // A flag raised after the current turn was delivered can be a misread
      // screen; an archived Claude helper printed DONE three minutes later. Keep watching
      // for a signal only: activity counts history rows as work and would rearm
      // a turn that really ended. Resume and unconfirmed follow-ups flag before
      // the turn, so an older DONE on screen cannot end them.
      // ponytail: captures every poll like running rows; slow it down if flagged rows pile up.
      const flagged = session.status === SESSION_STATUS.NeedsAttention && session.turnStartedAt != null
        && Date.parse(session.turnStartedAt) <= Date.parse(session.updatedAt);
      if (session.status !== SESSION_STATUS.Running && !flagged) continue;

      const output = await Tmux.capture(session.id, 30);
      const driver = getHarnessDriver(session.agentType);
      const outcome = outcomeFromCapture(output, driver);
      const newStatus = outcome.status;
      if ((flagged || signalsOnly) && newStatus !== SESSION_STATUS.Idle && newStatus !== SESSION_STATUS.Error) continue;
      if (newStatus === SESSION_STATUS.NeedsAttention) {
        const previous = pendingAttention.get(session.id);
        pendingAttention.set(session.id, { version: session.version, reason: outcome.reason });
        idleCount.delete(session.id);
        if (previous?.version !== session.version || previous.reason !== outcome.reason) continue;
      }
      pendingAttention.delete(session.id);
      // Hook consumption is a running-row CAS; a flagged row settles on the signal alone.
      const turn = driver.turnHooks && !flagged
        ? readTurnEvents(defaultRuntimeLayout.turnsLogPath(session.projectPath, session.id, session.deliveryRoot ?? undefined), session.turnHookOffset ?? 0,
          session.turnStartedAt ?? session.createdAt, session.agentType, session.turnInputAmbiguous ? null : session.turnInputDigest ?? null)
        : { offset: session.turnHookOffset ?? 0, event: null };
      for (const ignored of turn.ignored ?? []) {
        log(`${session.id}: ignored turn hook ${ignored.event} (not attributable to current input)`);
      }
      if (!turn.event && turn.offset > (session.turnHookOffset ?? 0)) {
        if (!db.consumeTurnHook(session.id, session.version, turn.offset)) continue;
        // Keep the version current for the inactivity fallback's CAS.
        session.version++;
      }
      if (newStatus !== SESSION_STATUS.Running) {
        // Snapshot before settle awaits the wakeup, so a later model switch cannot relabel this event.
        const ledgerSession = db.getSession(session.id) ?? session;
        idleCount.delete(session.id);
        const settled = await settle(db, archive, defaultWakeup, session.id, newStatus, {
          status: newStatus,
          lastOutput: output.slice(-500),
          reason: outcome.reason,
        }, session.status, session.version);
        if (!settled) continue;
        clearSessionFailures(session.id);
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
              summaryPath: planSessionHandoff(ledgerSession).summaryPath,
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
        const summary = existsSync(planSessionHandoff(session).summaryPath);
        const failure = turn.event.event === "stop_failure";
        // Stop can precede engine shutdown. Keep it pending until the composer
        // is ready, rather than consume it and lose the early-nudge opportunity.
        if (!failure && summary && session.nudgedAt == null) {
          // The after-turn checks ignore history rows, so they need an event from
          // a verified thread: a fail-open one may be a sub-agent's while the main
          // thread streams on with its spinner hidden. Claude events have no thread.
          const ended = turn.event.threadId === undefined || turn.event.threadVerified === true;
          if (shouldNudgeForCompletion(db, session, driver, output, ended)) {
            idleCount.delete(session.id);
            await deliverTurn(db, session, COMPLETION_NUDGE, () => Tmux.sendKeys(session.id, COMPLETION_NUDGE),
              { nudge: true, hookOffset: turn.offset });
            log(`${session.id}: summary present without signal, nudged for completion (turn hook)`);
            continue;
          }
          const working = ended && driver.workingAfterTurn
            ? driver.workingAfterTurn(output)
            : driver.detectActivity(output) !== "idle";
          if (working) {
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
        if (settled) {
          clearSessionFailures(session.id);
          log(`${session.id}: needs attention (turn hook ${turn.event.event}${failure ? `: ${turn.event.error}` : ""})`);
        }
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
            await deliverTurn(db, session, COMPLETION_NUDGE, () => Tmux.sendKeys(session.id, COMPLETION_NUDGE), { nudge: true });
            log(`${session.id}: summary present without signal, nudged for completion`);
            continue;
          }
          const settled = await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.NeedsAttention, {
            status: SESSION_STATUS.NeedsAttention,
            lastOutput: output.slice(-500),
          }, SESSION_STATUS.Running, session.version);
          if (settled) {
            clearSessionFailures(session.id);
            log(`${session.id}: needs attention (idle ${count} polls)`);
          }
        }
      }
    } catch (error) {
      failed = true;
      const skip = retry?.nextSkip ?? 0;
      refreshFailures.set(session.id, { version: session.version, skip, nextSkip: Math.min(2 * skip + 1, REFRESH_MAX_SKIP) });
      pendingAttention.delete(session.id);
      log(`${session.id}: refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      // This row just failed, and the usual cause is the terminal vanishing
      // after the snapshot was taken, so the snapshot would still call it live
      // and defer recovery by a whole backoff. Probe this one row directly;
      // only failing rows pay the extra probe.
      try {
        if (!await Tmux.hasSession(session.id)) {
          const current = db.getSession(session.id);
          if (current) await finishMissingSession(db, archive, current);
        }
      } catch (recoveryError) {
        log(`${session.id}: recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
    } finally {
      if (!failed) refreshFailures.delete(session.id);
    }
  }
}

const POLL_MS = 3000;
// The hook can fire a moment before the TUI draws the frame that ends the turn.
const WAKE_GRACE_MS = 250;

// Wait up to `ms`, returning early when a turn-end hook writes to the wake
// pipe. Without the pipe it simply sleeps.
export async function waitForWake(wakePath: string | undefined, ms: number): Promise<boolean> {
  const started = Date.now();
  let woke = false;
  if (wakePath) try { woke = (await FIFO.read(wakePath, ms)) !== null; } catch {}
  if (!woke) await Bun.sleep(Math.max(0, ms - (Date.now() - started)));
  return woke;
}

export async function daemonLoop(db: StateDB): Promise<void> {
  let wakePath: string | undefined = defaultRuntimeLayout.daemonWakePath();
  try { await FIFO.create(wakePath); } catch { wakePath = undefined; }
  let nextPoll = 0;
  while (true) {
    const sessions = db.listActiveSessions();
    if (sessions.length === 0) break; // Auto-exit when no sessions

    if (Date.now() >= nextPoll) {
      await refreshSessionStatuses(db);
      nextPoll = Date.now() + POLL_MS;
    }
    // A finished turn is read at once instead of up to 3 s later; the full
    // poll keeps its pace however many hooks fire.
    if (await waitForWake(wakePath, nextPoll - Date.now())) {
      await Bun.sleep(WAKE_GRACE_MS);
      await refreshSessionStatuses(db, undefined, Date.now(), true);
    }
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

export interface DetachedSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

// A daemon watches the roots of the process that started it, not whatever Bun
// snapshotted at startup: Bun.spawn without `env` ignores later process.env
// changes, so a test's isolated AHELPA_HOME used to be dropped and its daemon
// ran against the real ~/.ahelpa. Its cwd is its home, so deleting the
// directory it was started from cannot break every spawn it makes.
export function daemonSpawnOptions(layout = defaultRuntimeLayout): DetachedSpawnOptions {
  return {
    cwd: layout.ahelpaHomeDir(),
    env: { ...process.env, AHELPA_HOME: layout.ahelpaHomeDir(), AHELPA_TMP_DIR: layout.tmpDir },
  };
}

export function spawnDetached(command: string[], logPath?: string, options: DetachedSpawnOptions = {}): number {
  // Route the detached process's own stdout/stderr to a log instead of
  // /dev/null, so a daemon that crashes on startup leaves a trace to debug
  // (previously the crash was silently swallowed and the daemon just appeared
  // "stopped").
  const redirect = logPath
    ? `>>${shellEscape(logPath)} 2>&1`
    : ">/dev/null 2>&1";
  const shellCommand = `nohup ${command.map(shellEscape).join(" ")} ${redirect} & echo $!`;
  const proc = Bun.spawnSync(["/bin/sh", "-c", shellCommand], {
    cwd: options.cwd,
    env: options.env ?? process.env,
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
    // ponytail: daemon.stderr.log is unbounded, but only receives crash output;
    // keeping its descriptor separate preserves traces across log() rotation.
    const pid = spawnDetached(getDaemonLaunchCommand(), defaultRuntimeLayout.daemonStderrLogPath(), daemonSpawnOptions());
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
