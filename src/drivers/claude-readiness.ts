import { lstatSync, realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { addReadiness, configObject, executableReadiness, findReadinessExecutable, readEmbeddedVersion, readLocalConfig, readPackageVersion, readinessRuntime } from "./readiness";
import type { ReadinessRuntime } from "./types";

export function checkClaudeReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("claude", cwd, runtime);
  const version = executable ? readPackageVersion(executable, "@anthropic-ai/claude-code")
    ?? readEmbeddedVersion(executable, /PACKAGE_URL:"@anthropic-ai\/claude-code",README_URL:"[^"\r\n]{1,256}",VERSION:"([\d.]+(?:[-+][\w.-]+)?)"/) : null;
  const result = executableReadiness(executable, version);
  if (!executable) return result;
  const configDir = runtime.env.CLAUDE_CONFIG_DIR || join(runtime.homeDir, ".claude");
  const legacy = readLocalConfig(join(configDir, ".config.json"));
  const filename = runtime.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? ".claude-custom-oauth.json" : ".claude.json";
  const raw = legacy === null
    ? readLocalConfig(join(runtime.env.CLAUDE_CONFIG_DIR || runtime.homeDir, filename)) : legacy;
  if (raw === null) {
    addReadiness(result, false, "workspace not trusted");
    return result;
  }
  let projects: Record<string, unknown> | undefined;
  try {
    if (raw === undefined) throw new Error();
    const config = configObject(JSON.parse(raw));
    if (!config) throw new Error();
    projects = config.projects === undefined ? {} : configObject(config.projects);
    if (!projects) throw new Error();
  } catch {
    addReadiness(result, "unknown", "workspace trust config unreadable or unrecognized");
    return result;
  }
  const entries = Object.values(projects).map(configObject);
  if (entries.some((entry) => !entry || (entry.hasTrustDialogAccepted !== undefined
    && typeof entry.hasTrustDialogAccepted !== "boolean"))) {
    addReadiness(result, "unknown", "workspace trust config unreadable or unrecognized");
    return result;
  }
  if (!entries.some((entry) => entry?.hasTrustDialogAccepted === true)) {
    addReadiness(result, false, "workspace not trusted");
    return result;
  }
  // Claude 2.1.295 checks its canonical common repository root, then walks
  // parents up to the Git boundary. Lookup keys use NFC; filesystem paths do not.
  let directory: string;
  try { directory = realpathSync(cwd); } catch {
    addReadiness(result, "unknown", "workspace trust path could not be resolved");
    return result;
  }
  while (true) {
    if (configObject(projects[directory.normalize("NFC")])?.hasTrustDialogAccepted === true) return result;
    try {
      const marker = lstatSync(join(directory, ".git"));
      if (!marker.isDirectory()) {
        const common = commonRepositoryRoot(directory, runtime);
        if (common === undefined) {
          addReadiness(result, "unknown", "workspace ancestor trust requires Git worktree resolution");
          return result;
        }
        if (configObject(projects[common.normalize("NFC")])?.hasTrustDialogAccepted === true) return result;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        addReadiness(result, "unknown", "workspace Git trust boundary unreadable");
        return result;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  addReadiness(result, false, "workspace not trusted");
  return result;
}

function commonRepositoryRoot(directory: string, runtime: ReadinessRuntime): string | undefined {
  const git = findReadinessExecutable("git", directory, runtime);
  if (!git) return undefined;
  // A caller's Git overrides must not redirect the physical-path query.
  const env = Object.fromEntries(Object.entries(runtime.env).filter(([key]) => !key.startsWith("GIT_")));
  let pid: number | undefined;
  try {
    const result = Bun.spawnSync([git, "rev-parse", "--git-common-dir"], {
      cwd: directory, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, detached: true,
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 2_000,
      killSignal: "SIGKILL", maxBuffer: 4096,
    });
    pid = result.pid;
    if (!result.success || result.exitedDueToTimeout || result.exitedDueToMaxBuffer) return undefined;
    const path = result.stdout.toString().trim();
    if (!path || path.includes("\n")) return undefined;
    const common = realpathSync(resolve(directory, path));
    // Submodules and separate Git directories need additional canonicalization.
    return basename(common) === ".git" ? realpathSync(dirname(common)) : undefined;
  } catch { return undefined; }
  finally { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} } }
}
