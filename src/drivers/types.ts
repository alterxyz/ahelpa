export interface LaunchOptions { cwd: string; safe?: boolean; }

export interface DriverRuntime {
  sleep(ms: number): Promise<void>;
  capture(sessionId: string, lines?: number): Promise<string>;
  sendKeys(sessionId: string, text: string): Promise<void>;
}

export type DetectedStatus = "idle" | "error" | "running";

export interface AgentDriver {
  name: string;
  sessionPrefix: string;
  buildLaunchCommand(opts: LaunchOptions): string;
  prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void>;
  afterTaskSubmitted(sessionId: string, runtime: DriverRuntime): Promise<void>;
  detectStatus(captureOutput: string): DetectedStatus;
}
