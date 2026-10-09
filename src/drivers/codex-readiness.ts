import { join, resolve } from "path";
import { resolveCodexExecutable } from "./codex-capabilities";
import { addReadiness, configObject, executableReadiness, findReadinessExecutable, presentString, readLocalConfig, readLocalVersion, readinessRuntime } from "./readiness";
import type { ReadinessRuntime } from "./types";

export function checkCodexReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  // Reuse launch resolution without running its help/capability probe.
  const executable = resolveCodexExecutable(cwd, (directory) => findReadinessExecutable("codex", directory, runtime));
  const result = executableReadiness(executable, executable ? readLocalVersion(executable, cwd, runtime) : null);
  if (!executable) return result;
  const home = runtime.env.CODEX_HOME ? resolve(cwd, runtime.env.CODEX_HOME) : join(runtime.homeDir, ".codex");
  const config = readLocalConfig(join(home, "config.toml"));
  let store: unknown = "file";
  try {
    if (config === undefined) throw new Error();
    if (config !== null) store = configObject(Bun.TOML.parse(config))?.cli_auth_credentials_store ?? "file";
  } catch {
    addReadiness(result, "unknown", "auth storage config unreadable or unrecognized");
    return result;
  }
  if (store !== "file" && store !== "auto") {
    addReadiness(result, "unknown", "auth storage cannot be checked read-only");
    return result;
  }
  // Inspect shape only. Never run login/status: config loading or credential
  // backends may log, migrate, or refresh state in future CLI versions.
  const raw = readLocalConfig(join(home, "auth.json"));
  if (raw === null) {
    addReadiness(result, store === "auto" ? "unknown" : false,
      store === "auto" ? "auth may be stored in keyring" : "auth file not found");
    return result;
  }
  try {
    if (raw === undefined) throw new Error();
    const auth = configObject(JSON.parse(raw));
    if (!auth) throw new Error();
    const tokens = configObject(auth.tokens);
    if (presentString(auth.OPENAI_API_KEY) || presentString(tokens?.access_token)) return result;
    const knownKeys = new Set(["OPENAI_API_KEY", "tokens", "auth_mode", "last_refresh"]);
    const unknown = Object.keys(auth).some((key) => !knownKeys.has(key)) || store === "auto"
      || (auth.OPENAI_API_KEY != null && typeof auth.OPENAI_API_KEY !== "string")
      || (auth.tokens != null && (!tokens || Object.keys(tokens).some((key) =>
        !["access_token", "id_token", "refresh_token", "account_id"].includes(key))
        || (tokens.access_token != null && typeof tokens.access_token !== "string")));
    addReadiness(result, unknown ? "unknown" : false, unknown ? "auth state unrecognized or may be stored in keyring" : "auth credentials not found");
  } catch {
    addReadiness(result, "unknown", "auth file unreadable or unrecognized");
  }
  return result;
}
