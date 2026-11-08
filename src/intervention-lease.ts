// A host intervention (interrupt, or a kill that keeps the native ID) presses
// keys and waits for the TUI to show that its turn stopped. While the lease
// is live the daemon leaves the session alone: no nudge, no settlement from a
// turn hook, no idle fallback. The session status is not touched, so `wait`
// never sees a provisional result and a failed intervention has nothing to undo.
// One holder at a time; only the holder renews or releases it.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "fs";
import { randomUUID } from "crypto";
import { dirname } from "path";
import { defaultRuntimeLayout } from "./runtime-layout";

// ponytail: renewed on every poll; a crashed holder pauses monitoring at most this long.
const LEASE_MS = 20_000;

export interface InterventionLease { sessionId: string; token: string }

function read(sessionId: string): { expiresAt: number; token: string } | null {
  try {
    const [expiresAt, token] = readFileSync(defaultRuntimeLayout.interventionLeasePath(sessionId), "utf8").split(" ");
    return { expiresAt: Number(expiresAt), token: token ?? "" };
  } catch {
    return null;
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
      try { writeSync(fd, `${Date.now() + LEASE_MS} ${token}`); } finally { closeSync(fd); }
      return { sessionId, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (interventionLeaseActive(sessionId)) return null;
      rmSync(path, { force: true }); // expired: its holder crashed or overran
    }
  }
  return null;
}

export function renewInterventionLease(lease: InterventionLease): boolean {
  if (read(lease.sessionId)?.token !== lease.token) return false;
  writeFileSync(defaultRuntimeLayout.interventionLeasePath(lease.sessionId), `${Date.now() + LEASE_MS} ${lease.token}`);
  return true;
}

export function releaseInterventionLease(lease: InterventionLease): void {
  if (read(lease.sessionId)?.token === lease.token) rmSync(defaultRuntimeLayout.interventionLeasePath(lease.sessionId), { force: true });
}

export function interventionLeaseActive(sessionId: string, nowMs = Date.now()): boolean {
  const lease = read(sessionId);
  return lease !== null && lease.expiresAt > nowMs;
}
