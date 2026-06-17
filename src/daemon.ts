import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { StateDB } from "./state";
import { Tmux } from "./tmux";
import { Archive } from "./archive";
import { defaultWakeup } from "./wakeup";
import { settle } from "./settle";
import { getDriver } from "./drivers/registry";
import { SESSION_STATUS, statusFromCapture } from "./session-lifecycle";
import { defaultRuntimeLayout } from "./runtime-layout";
import { shellEscape } from "./shell";

const AHELPA_DIR = defaultRuntimeLayout.ahelpaHomeDir();
const PID_FILE = defaultRuntimeLayout.daemonPidPath();
const LOG_FILE = defaultRuntimeLayout.daemonLogPath();
export const DAEMON_SUBCOMMAND = "__daemon";

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
      } else {
        db.updateStatus(session.id, SESSION_STATUS.Dead);
      }
      continue;
    }

    if (session.status !== SESSION_STATUS.Running) continue;

    const output = await Tmux.capture(session.id, 30);
    const newStatus = statusFromCapture(output, getDriver(session.agentType));
    if (newStatus !== SESSION_STATUS.Running) {
      await settle(db, archive, defaultWakeup, session.id, newStatus, {
        status: newStatus,
        lastOutput: output.slice(-500),
      });
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
  argv: string[] = process.argv,
  execPath: string = process.execPath,
  moduleDir: string = import.meta.dir,
): string[] {
  const cliPath = join(moduleDir, "cli.ts");
  if (existsSync(cliPath)) {
    return [execPath, cliPath, DAEMON_SUBCOMMAND];
  }

  const maybeScriptPath = argv[1];
  if (maybeScriptPath && existsSync(maybeScriptPath)) {
    return [execPath, maybeScriptPath, DAEMON_SUBCOMMAND];
  }

  return [execPath, DAEMON_SUBCOMMAND];
}

export function spawnDetached(command: string[]): number {
  const shellCommand = `nohup ${command.map(shellEscape).join(" ")} >/dev/null 2>&1 & echo $!`;
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
    const pid = spawnDetached(getDaemonLaunchCommand());
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
