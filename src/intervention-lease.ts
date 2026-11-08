// A host intervention (interrupt, or a kill that keeps the native ID) presses
// keys and waits for the TUI to show that its turn stopped. While the lease
// holds, the daemon leaves the session alone: no nudge, no settlement from a
// turn hook, no idle fallback. The session status is not touched, so `wait`
// never sees a provisional result and a failed intervention has nothing to undo.
// One holder at a time; only the holder releases it. The lease lives as long as
// its holder process, however slow one tmux call is, and ends when that process
// dies; a cap bounds a hung holder or a reused PID.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "fs";
import { randomUUID } from "crypto";
import { dirname } from "path";
import { defaultRuntimeLayout } from "./runtime-layout";

// ponytail: far above an intervention's ~10 s of polls; a hung holder pauses monitoring at most this long.
const LEASE_CAP_MS = 120_000;

export interface InterventionLease { sessionId: string; token: string }

interface LeaseRecord { takenAt: number; token: string; pid: number }

function read(sessionId: string): LeaseRecord | null {
  try {
    const [takenAt, token, pid] = readFileSync(defaultRuntimeLayout.interventionLeasePath(sessionId), "utf8").split(" ");
    return { takenAt: Number(takenAt), token: token ?? "", pid: Number(pid) };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Null when another live intervention holds the session.
export function takeInterventionLease(sessionId: string): InterventionLease | null {
  const path = defaultRuntimeLayout.interventionLeasePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try { writeSync(fd, `${Date.now()} ${token} ${process.pid}`); } finally { closeSync(fd); }
      return { sessionId, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (interventionLeaseActive(sessionId)) return null;
      rmSync(path, { force: true }); // its holder died or overran the cap
    }
  }
  return null;
}

// False once the lease was replaced: another intervention now owns the session.
export function ownsInterventionLease(lease: InterventionLease): boolean {
  const record = read(lease.sessionId);
  return record?.token === lease.token && interventionLeaseActive(lease.sessionId);
}

export function releaseInterventionLease(lease: InterventionLease): void {
  if (read(lease.sessionId)?.token === lease.token) rmSync(defaultRuntimeLayout.interventionLeasePath(lease.sessionId), { force: true });
}

export function interventionLeaseActive(sessionId: string, nowMs = Date.now()): boolean {
  const record = read(sessionId);
  return record !== null && nowMs - record.takenAt < LEASE_CAP_MS && processAlive(record.pid);
}
