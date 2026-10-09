import { lstatSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { addReadiness, configObject, executableReadiness, findReadinessExecutable, readLocalConfig, readLocalVersion, readinessRuntime } from "./readiness";
import type { ReadinessRuntime } from "./types";

export function checkClaudeReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("claude", cwd, runtime);
  const result = executableReadiness(executable, executable ? readLocalVersion(executable, cwd, runtime) : null);
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
  // Claude 2.1.295's Mw walks parents, bounded by xw/ykr's Git root.
  // Worktree/submodule markers have additional canonicalization rules; do
  // not infer ancestor trust when that boundary cannot be established.
  let directory: string;
  try { directory = realpathSync(cwd); } catch {
    addReadiness(result, "unknown", "workspace trust path could not be resolved");
    return result;
  }
  while (true) {
    if (configObject(projects[directory])?.hasTrustDialogAccepted === true) return result;
    try {
      const marker = lstatSync(join(directory, ".git"));
      if (!marker.isDirectory()) {
        addReadiness(result, "unknown", "workspace ancestor trust requires Git worktree resolution");
        return result;
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
