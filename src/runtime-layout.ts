import { homedir } from "os";
import { join } from "path";

export interface RuntimeLayoutOptions {
  homeDir?: string;
  tmpDir?: string;
}

export class RuntimeLayout {
  readonly homeDir: string;
  readonly tmpDir: string;

  constructor(options: RuntimeLayoutOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.tmpDir = options.tmpDir ?? "/tmp/ahelpa";
  }

  ahelpaHomeDir(): string {
    return join(this.homeDir, ".ahelpa");
  }

  stateDbPath(): string {
    return join(this.ahelpaHomeDir(), "state.db");
  }

  daemonPidPath(): string {
    return join(this.ahelpaHomeDir(), "daemon.pid");
  }

  daemonLogPath(): string {
    return join(this.ahelpaHomeDir(), "daemon.log");
  }

  archiveDir(): string {
    return join(this.ahelpaHomeDir(), "archive");
  }

  projectDeliveryDir(projectPath: string): string {
    return join(projectPath, ".ahelpa");
  }

  taskFilePath(sessionId: string): string {
    return join(this.tmpDir, `ahelpa-task-${sessionId}.md`);
  }

  fifoPath(sessionId: string): string {
    return join(this.tmpDir, `${sessionId}.pipe`);
  }
}

export const defaultRuntimeLayout = new RuntimeLayout();
