import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

// The main checkout of the repository that holds `path`, read from .git files
// without running git. `linked` is true when `path` is inside a linked worktree.
// ponytail: answers null (results stay in the project, as before) for submodules,
// any repository whose common git dir is not named `.git` (bare repositories and
// their worktrees, --separate-git-dir), and a vanished or moved main checkout.
export function mainCheckoutOf(path: string): { main: string; linked: boolean } | null {
  try {
    for (let dir = resolve(path); ; dir = dirname(dir)) {
      const dotGit = join(dir, ".git");
      const stat = statSync(dotGit, { throwIfNoEntry: false });
      if (stat?.isDirectory()) return { main: realpathSync(dir), linked: false };
      if (stat?.isFile()) {
        const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!gitdir) return null;
        const gitdirPath = resolve(dir, gitdir);
        const commondirFile = join(gitdirPath, "commondir");
        if (!existsSync(commondirFile)) return null; // a submodule's own git dir
        const common = resolve(gitdirPath, readFileSync(commondirFile, "utf8").trim());
        if (basename(common) !== ".git" || !existsSync(common)) return null;
        return { main: realpathSync(dirname(common)), linked: true };
      }
      if (dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

// Where a session in `path` keeps its results: the main checkout when `path` is
// in a linked worktree, otherwise undefined (the project itself). Read once at
// launch or resume and stored on the session row, because `git worktree remove`
// takes the evidence that finds the main checkout with it.
export function deliveryRootFor(path: string): string | undefined {
  const checkout = mainCheckoutOf(path);
  return checkout?.linked ? checkout.main : undefined;
}

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
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.ahelpaDir = resolve(options.ahelpaDir
      ?? (options.homeDir ? join(options.homeDir, ".ahelpa") : envAhelpaHome)
      ?? join(this.homeDir, ".ahelpa"));
    this.tmpDir = resolve(options.tmpDir ?? envTmpDir ?? "/tmp/ahelpa");
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

  // ponytail: unbounded crash output only; keep the daemon's open stderr fd
  // separate from daemon.log so rotation cannot unlink later crash traces.
  daemonStderrLogPath(): string {
    return join(this.ahelpaHomeDir(), "daemon.stderr.log");
  }

  needHelpLedgerPath(): string {
    return join(this.ahelpaHomeDir(), "need-help.jsonl");
  }

  archiveDir(): string {
    return join(this.ahelpaHomeDir(), "archive");
  }

  launchFailurePath(sessionId: string): string {
    return join(this.ahelpaHomeDir(), "launch-failures", `${sessionId}.txt`);
  }

  // `git worktree remove` deletes a linked worktree's ignored .ahelpa/ with it,
  // so a session there keeps its results under `deliveryRoot`, the main checkout
  // stored on its row. Without one (every earlier session) they are in the project.
  projectDeliveryDir(projectPath: string, deliveryRoot?: string): string {
    return join(deliveryRoot ?? projectPath, ".ahelpa");
  }

  sessionDeliveryDir(projectPath: string, sessionId: string, deliveryRoot?: string): string {
    return join(this.projectDeliveryDir(projectPath, deliveryRoot), sessionId);
  }

  turnsLogPath(projectPath: string, sessionId: string, deliveryRoot?: string): string {
    return join(this.sessionDeliveryDir(projectPath, sessionId, deliveryRoot), "turns.log");
  }

  claudeSettingsPath(projectPath: string, sessionId: string): string {
    return join(this.sessionDeliveryDir(projectPath, sessionId), "claude-settings.json");
  }

  taskFilePath(sessionId: string): string {
    return join(this.tmpDir, `ahelpa-task-${sessionId}.md`);
  }

  // One helper's working copies, caches and test temp, outside every project
  // tree. Inside a project they are committed and backed up as if they were
  // evidence: one managed project's .ahelpa/ reached 660k entries that way.
  scratchDir(sessionId: string): string {
    return join(this.tmpDir, "scratch", sessionId);
  }

  fifoPath(sessionId: string): string {
    return join(this.tmpDir, `${sessionId}.pipe`);
  }
}

export const defaultRuntimeLayout = new RuntimeLayout();
