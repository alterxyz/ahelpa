export interface LaunchOptions { cwd: string; safe?: boolean; model?: string; effort?: string; }
export interface ResumeOptions { cwd: string; resumeId: string; safe?: boolean; model?: string; effort?: string; }
export interface ModelSwitchOptions { model: string; effort?: string; persist?: boolean; }

export interface ModelCatalogEntry {
  name: string;
  efforts?: readonly string[];
  defaultEffort?: string;
}

export interface AgentModelCatalog {
  models: readonly ModelCatalogEntry[];
  effortNote?: string;
}

export interface DriverRuntime {
  sleep(ms: number): Promise<void>;
  capture(sessionId: string, lines?: number): Promise<string>;
  sendKeys(sessionId: string, text: string): Promise<void>;
  sendKey(sessionId: string, key: string): Promise<void>;
}

export interface TaskSubmissionContext {
  // Best-effort pane snapshot taken immediately before the host submits the
  // task. Drivers with persistent history can use it to distinguish the new
  // turn from an earlier settled turn.
  beforeOutput?: string;
}

export type DetectedStatus = "idle" | "error" | "running";

// ponytail: normal is finite, abnormal is infinite — detect the known-good, flag the rest
export type ActivitySignal = "working" | "booting" | "idle";

export interface AgentDriver {
  name: string;
  sessionPrefix: string;
  modelCatalog: AgentModelCatalog;
  resumeTokenAvailableAfterSubmit: boolean;
  buildLaunchCommand(opts: LaunchOptions): string;
  buildResumeCommand(opts: ResumeOptions): string;
  extractResumeToken(captureOutput: string): string | null;
  prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void>;
  prepareForResume(sessionId: string, runtime: DriverRuntime): Promise<void>;
  afterTaskSubmitted(
    sessionId: string,
    runtime: DriverRuntime,
    context?: TaskSubmissionContext,
  ): Promise<boolean>;
  switchModel(sessionId: string, runtime: DriverRuntime, opts: ModelSwitchOptions): Promise<string>;
  detectStatus(captureOutput: string): DetectedStatus;
  detectActivity(captureOutput: string): ActivitySignal;
  gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void>;
}
