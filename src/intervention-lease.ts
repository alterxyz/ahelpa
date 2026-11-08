// A host intervention (interrupt, or a kill that keeps the native ID) presses
// keys and waits for the TUI to show that its turn stopped. While the lease
// is live the daemon leaves the session alone: no nudge, no settlement from a
// turn hook, no idle fallback. The session status is not touched, so `wait`
// never sees a provisional result and a failed intervention has nothing to undo.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { defaultRuntimeLayout } from "./runtime-layout";

// ponytail: longer than any intervention's polls; a crashed holder pauses monitoring at most this long.
const LEASE_MS = 20_000;

export function takeInterventionLease(sessionId: string): void {
  const path = defaultRuntimeLayout.interventionLeasePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(Date.now() + LEASE_MS));
}

export function releaseInterventionLease(sessionId: string): void {
  rmSync(defaultRuntimeLayout.interventionLeasePath(sessionId), { force: true });
}

export function interventionLeaseActive(sessionId: string, nowMs = Date.now()): boolean {
  try {
    return Number(readFileSync(defaultRuntimeLayout.interventionLeasePath(sessionId), "utf8")) > nowMs;
  } catch {
    return false;
  }
}
