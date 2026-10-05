import type { AgentDriver, DetectedOutcome } from "./drivers/types";

export const SESSION_STATUS = {
  Running: "running",
  Idle: "idle",
  Error: "error",
  NeedsAttention: "needs_attention",
  Draining: "draining",
  Dead: "dead",
} as const;

export type SessionStatus = typeof SESSION_STATUS[keyof typeof SESSION_STATUS];

export const WAIT_STATUS = {
  StillRunning: "still_running",
} as const;

export type WaitStatus = SessionStatus | typeof WAIT_STATUS.StillRunning;

// ponytail: direct map today; add driver-agnostic capture signals (OOM, segfault) when a real case appears
export function statusFromCapture(captureOutput: string, driver: AgentDriver): SessionStatus {
  return outcomeFromCapture(captureOutput, driver).status;
}

export function outcomeFromCapture(captureOutput: string, driver: AgentDriver): DetectedOutcome {
  return driver.detectOutcome(captureOutput);
}
