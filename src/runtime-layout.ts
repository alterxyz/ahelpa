import { homedir } from "os";
import { join } from "path";

export interface RuntimeLayoutOptions {
  homeDir?: string;
  ahelpaDir?: string;
  tmpDir?: string;
}

export class RuntimeLayout {
  readonly homeDir: string;
  readonly ahelpaDir: string;
  readonly tmpDir: string;

  constructor(options: RuntimeLayoutOptions = {}) {
    const envAhelpaHome = process.env.AHELPA_HOME?.trim() || undefined;
    const envTmpDir = process.env.AHELPA_TMP_DIR?.trim() || undefined;
    this.homeDir = options.homeDir ?? homedir();
    this.ahelpaDir = options.ahelpaDir
      ?? (options.homeDir ? join(options.homeDir, ".ahelpa") : envAhelpaHome)
      ?? join(this.homeDir, ".ahelpa");
    this.tmpDir = options.tmpDir ?? envTmpDir ?? "/tmp/ahelpa";
  }

  ahelpaHomeDir(): string {
    return this.ahelpaDir;
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
