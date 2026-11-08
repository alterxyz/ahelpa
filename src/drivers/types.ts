// deliveryDir: the session's result directory when the caller has planned it
// (a linked worktree's results live in the main checkout, not under cwd).
export interface LaunchOptions { cwd: string; sessionId?: string; deliveryDir?: string; safe?: boolean; model?: string; effort?: string; }
export interface ResumeOptions { cwd: string; sessionId?: string; deliveryDir?: string; resumeId: string; safe?: boolean; model?: string; effort?: string; }
export interface ModelSwitchOptions { model: string; effort?: string; persist?: boolean; }
export type HelperRole = "worker" | "advisor" | "reviewer";

export type LocalReadiness = boolean | "unknown";

export interface ReadinessRuntime {
  homeDir: string;
  env: Record<string, string | undefined>;
}

export interface DriverReadiness {
  executable: string | null;
  version: string | null;
  locally_ready: LocalReadiness;
  reasons: string[];
}

// The helper accepted the new model, but restoring the CLI defaults failed.
// Callers must retain the applied choice while still reporting the failure.
export class ModelSwitchAppliedError extends Error {
  override name = "ModelSwitchAppliedError";
}

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

export type DetectedStatus = "idle" | "error" | "running" | "needs_attention";

export interface DetectedOutcome {
  status: DetectedStatus;
  needHelpTags: string[] | null;
  reason?: string;
}

// ponytail: normal is finite, abnormal is infinite — detect the known-good, flag the rest
export type ActivitySignal = "working" | "booting" | "idle";

// What a driver did on its own while starting the helper, so the caller can say so.
export interface StartupNotes {
  // The repository root whose Codex "Folder access" prompt the driver accepted.
  codexTrust?: string;
  // Codex asked to trust new or changed project hooks and the driver declined for now: the helper runs without them.
  codexHooksSkipped?: boolean;
}

// Codex saves the trust when Enter is pressed, whatever fails next: every error after the answer carries this.
export const codexTrustNote = (root: string): string => `Folder access was accepted for ${root}, which Codex keeps trusted`;

export interface AgentDriver {
  name: string;
  sessionPrefix: string;
  turnHooks?: boolean;
  prepareLaunchFiles?(opts: LaunchOptions): void;
  launchProfiles?: {
    defaultRole: HelperRole;
    profiles: Partial<Record<HelperRole, { model?: string; effort?: string }>>;
  };
  modelCatalog: AgentModelCatalog;
  checkReadiness?(cwd: string, runtime?: ReadinessRuntime): DriverReadiness;
  buildLaunchCommand(opts: LaunchOptions): string;
  prepareForTask(sessionId: string, runtime: DriverRuntime): Promise<void | StartupNotes>;
  // Native resume is optional. A helper is its ahelpa ID, the tmux session
  // name ahelpa gives it at launch; the CLI's own conversation ID only lets
  // `resume` reopen a finished or killed helper, which is rare. Record it where
  // the CLI shows it anyway (after the first submit, or as it exits on DONE),
  // and never press keys or delay a kill to get it. Implement all four or none
  // (a protocol test checks the registered drivers); `resume` refuses a driver
  // without them.
  resumeTokenAvailableAfterSubmit?: boolean;
  buildResumeCommand?(opts: ResumeOptions): string;
  extractResumeToken?(captureOutput: string): string | null;
  prepareForResume?(sessionId: string, runtime: DriverRuntime): Promise<void | StartupNotes>;
  afterTaskSubmitted(
    sessionId: string,
    runtime: DriverRuntime,
    context?: TaskSubmissionContext,
  ): Promise<boolean>;
  switchModel(sessionId: string, runtime: DriverRuntime, opts: ModelSwitchOptions): Promise<string>;
  detectStatus(captureOutput: string): DetectedStatus;
  detectOutcome(captureOutput: string): DetectedOutcome;
  detectActivity(captureOutput: string): ActivitySignal;
  // True only when the chat composer is the thing that would receive typed
  // text: no menu, approval, or trust dialog. Idle alone is not enough.
  acceptsInput?(captureOutput: string): boolean;
  // Only the monitor may use this with a validated current-turn end event.
  acceptsInputAfterTurn?(captureOutput: string): boolean;
  // Same condition: is the turn still visibly running? Defaults to detectActivity,
  // which may count history rows as work and then hold the event forever.
  workingAfterTurn?(captureOutput: string): boolean;
  gracefulExit(sessionId: string, runtime: DriverRuntime): Promise<void>;
  // How a person stops one turn and keeps the session: the tmux key, and the
  // line the TUI prints once the turn really stopped (a key press alone proves
  // nothing). Omitted where neither was verified on the real TUI; `interrupt`
  // then refuses.
  interrupt?: { key: string; stopped: RegExp };
}
