import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { StateDB } from "./state";
import { Tmux } from "./tmux";
import { Archive } from "./archive";
import { Wakeup, defaultWakeup } from "./wakeup";
import { settle } from "./settle";
import { getDriver } from "./drivers/registry";
import { SESSION_STATUS, statusFromCapture } from "./session-lifecycle";
import { defaultRuntimeLayout } from "./runtime-layout";
import { shellEscape } from "./shell";
import type { DriverRuntime } from "./drivers/types";

const AHELPA_DIR = defaultRuntimeLayout.ahelpaHomeDir();
const PID_FILE = defaultRuntimeLayout.daemonPidPath();
const LOG_FILE = defaultRuntimeLayout.daemonLogPath();
export const DAEMON_SUBCOMMAND = "__daemon";

// ponytail: auto-reap dead sessions so `clean` isn't needed manually.
// summary.md in the project dir is the receipt; DB row is disposable.
function reapSession(db: StateDB, sessionId: string): void {
  const wakeup = new Wakeup();
  wakeup.cleanup(sessionId);
  try { unlinkSync(defaultRuntimeLayout.taskFilePath(sessionId)); } catch {}
  db.deleteSession(sessionId);
}

// ponytail: 15s is generous for /exit or Escape; bump if a driver needs longer cleanup
const DRAIN_TIMEOUT_MS = 15_000;
const drainingAt = new Map<string, number>();
// ponytail: debounce — only flag after N consecutive polls with no working signal.
// 4 polls × 3s = ~12s of inactivity before escalating. Startup is handled by
// prepareForTask, so the daemon only polls once the agent should be working.
const idleCount = new Map<string, number>();
const IDLE_DEBOUNCE = 4;

const driverRuntime: DriverRuntime = {
  sleep: (ms) => Bun.sleep(ms),
  capture: (sid, lines) => Tmux.capture(sid, lines),
  sendKeys: (sid, text) => Tmux.sendKeys(sid, text),
  sendKey: (sid, key) => Tmux.sendKey(sid, key),
};

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore log errors
  }
}

export async function refreshSessionStatuses(db: StateDB, sessionIds?: string[]): Promise<void> {
  const archive = new Archive(defaultRuntimeLayout.archiveDir());
  const targetIds = sessionIds ? new Set(sessionIds) : null;
  const sessions = db.listSessions()
    .filter((session) => session.status !== SESSION_STATUS.Dead)
    .filter((session) => !targetIds || targetIds.has(session.id));

  for (const session of sessions) {
    const alive = await Tmux.hasSession(session.id);
    if (!alive) {
      if (session.status === SESSION_STATUS.Running) {
        await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.Dead, {
          status: SESSION_STATUS.Dead,
          reason: "tmux session gone",
        });
      } else if (session.status === SESSION_STATUS.Draining) {
        // Draining sessions that exit on their own (e.g. AHELPA:DONE) never
        // pass back through the Running branch above, so without this they'd
        // reap silently and the settle notification would never fire.
        await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.Dead, {
          status: SESSION_STATUS.Dead,
          reason: "drained cleanly (completed)",
        });
      }
      drainingAt.delete(session.id);
      reapSession(db, session.id);
      log(`${session.id}: reaped`);
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
        } catch {}
      }

      const startedAt = drainingAt.get(session.id) ?? 0;
      if (!startedAt || Date.now() - startedAt > DRAIN_TIMEOUT_MS) {
        await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.Dead, {
          status: SESSION_STATUS.Dead,
          reason: "drain timeout, killed",
        });
        await Tmux.kill(session.id);
        drainingAt.delete(session.id);
        reapSession(db, session.id);
        log(`${session.id}: drain timeout, killed & reaped`);
      }
      continue;
    }

    if (session.status !== SESSION_STATUS.Running) continue;

    const output = await Tmux.capture(session.id, 30);
    const driver = getDriver(session.agentType);
    const newStatus = statusFromCapture(output, driver);
    if (newStatus !== SESSION_STATUS.Running) {
      idleCount.delete(session.id);
      await settle(db, archive, defaultWakeup, session.id, newStatus, {
        status: newStatus,
        lastOutput: output.slice(-500),
      });
      if (newStatus === SESSION_STATUS.Idle) {
        try { await driver.gracefulExit(session.id, driverRuntime); } catch {}
        db.updateStatus(session.id, SESSION_STATUS.Draining);
        drainingAt.set(session.id, Date.now());
        log(`${session.id}: sent graceful exit, draining`);
      }
    } else if (driver.detectActivity(output) !== "idle") {
      idleCount.delete(session.id);
    } else {
      const count = (idleCount.get(session.id) ?? 0) + 1;
      idleCount.set(session.id, count);
      if (count >= IDLE_DEBOUNCE) {
        idleCount.delete(session.id);
        await settle(db, archive, defaultWakeup, session.id, SESSION_STATUS.NeedsAttention, {
          status: SESSION_STATUS.NeedsAttention,
          lastOutput: output.slice(-500),
        });
        log(`${session.id}: needs attention (idle ${count} polls)`);
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
  // Dev mode: running from the source tree (`bun run src/cli.ts`). execPath is
  // the bun runtime, so re-invoke it against cli.ts.
  const cliPath = join(moduleDir, "cli.ts");
  if (existsSync(cliPath)) {
    return [execPath, cliPath, DAEMON_SUBCOMMAND];
  }

  // Compiled single-file binary (`bun build --compile`) — macOS or Linux alike:
  // process.execPath IS the ahelpa binary, so re-invoke it directly. Do NOT
  // append argv[1]: for a compiled binary argv[1] is the binary path itself,
  // which duplicates execPath and shifts the daemon's args. The daemon then
  // received `ahelpa <binpath> __daemon`, exited as "Unknown command", never
  // ran, and wait/settle silently broke.
  return [execPath, DAEMON_SUBCOMMAND];
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
