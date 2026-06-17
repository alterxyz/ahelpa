import type { AgentDriver } from "./drivers/types";

export const SESSION_STATUS = {
  Running: "running",
  Idle: "idle",
  Error: "error",
  Dead: "dead",
} as const;

export type SessionStatus = typeof SESSION_STATUS[keyof typeof SESSION_STATUS];

export const WAIT_STATUS = {
  StillRunning: "still_running",
} as const;

export type WaitStatus = SessionStatus | typeof WAIT_STATUS.StillRunning;

export function statusFromCapture(captureOutput: string, driver: AgentDriver): SessionStatus {
  return driver.detectStatus(captureOutput) as SessionStatus;
}
