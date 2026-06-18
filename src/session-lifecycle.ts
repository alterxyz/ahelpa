import type { AgentDriver } from "./drivers/types";

export const SESSION_STATUS = {
  Running: "running",
  Idle: "idle",
  Error: "error",
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
  const detected = driver.detectStatus(captureOutput);
  switch (detected) {
    case "idle": return SESSION_STATUS.Idle;
    case "error": return SESSION_STATUS.Error;
    case "running": return SESSION_STATUS.Running;
  }
}
