import { resolve } from "path";

export interface CodexCapabilities {
  executable: string | null;
  noDaemon: boolean;
}

const HELP_TIMEOUT_MS = 1_000;
const HELP_MAX_BYTES = 128 * 1024;

// --help exits before Codex starts a session. Capture only its option surface;
// never print probe errors or inspect the user's configuration/authentication.
export function readCodexHelp(executable: string, cwd: string, timeoutMs = HELP_TIMEOUT_MS): string | undefined {
  let pid: number | undefined;
  try {
    const result = Bun.spawnSync([executable, "--help"], {
      cwd,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: HELP_MAX_BYTES,
    });
    pid = result.pid;
    if (!result.success || result.exitedDueToTimeout || result.exitedDueToMaxBuffer) return undefined;
    return result.stdout.toString();
  } catch {
    return undefined;
  } finally {
    // A shim can leave children alive after its help process exits or times
    // out. detached gives this probe its own group, so only its children die.
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  }
}

export function createCodexCapabilityProbe(
  readHelp: (executable: string, cwd: string) => string | undefined = readCodexHelp,
  findExecutable: (cwd: string) => string | null = (cwd) => Bun.which("codex", { cwd }),
): (cwd: string) => CodexCapabilities {
  const cache = new Map<string, CodexCapabilities>();
  return (cwd) => {
    const directory = resolve(cwd);
    let executable: string | null = null;
    try {
      const found = findExecutable(directory);
      if (found) executable = resolve(directory, found);
    } catch {}
    const key = JSON.stringify([executable, directory]);
    const cached = cache.get(key);
    if (cached) return cached;
    let help: string | undefined;
    if (executable) {
      try { help = readHelp(executable, directory); } catch {}
    }
    // Only a declared option counts, not an error or a mention in prose.
    const capabilities = { executable, noDaemon: help !== undefined && /^\s*--no-daemon(?:\s|$)/m.test(help) };
    cache.set(key, capabilities);
    return capabilities;
  };
}

// A version-manager shim can select different CLIs by project directory. Cache
// the executable and cwd together, and run exactly the binary that was probed.
export const getCodexCapabilities = createCodexCapabilityProbe();
