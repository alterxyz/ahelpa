export interface LaunchOptions { cwd: string; safe?: boolean; }
export interface ResumeOptions { cwd: string; resumeId: string; safe?: boolean; }
export interface ModelSwitchOptions { model: string; effort?: string; persist?: boolean; }

export interface DriverRuntime {
  sleep(ms: number): Promise<void>;
  capture(sessionId: string, lines?: number): Promise<string>;
  sendKeys(sessionId: string, text: string): Promise<void>;
  sendKey(sessionId: string, key: string): Promise<void>;
}

export type DetectedStatus = "idle" | "error" | "running";

export interface AgentDriver {
  name: string;
  sessionPrefix: string;
  buildLaunchCommand(opts: LaunchOptions): string;
  buildResumeCommand(opts: ResumeOptions): string;
  extractResumeToken(captureOutput: string): string | null;
  prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void>;
  afterTaskSubmitted(sessionId: string, runtime: DriverRuntime): Promise<void>;
  switchModel(sessionId: string, runtime: DriverRuntime, opts: ModelSwitchOptions): Promise<string>;
  detectStatus(captureOutput: string): DetectedStatus;
  gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void>;
}
