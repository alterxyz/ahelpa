import { realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { resolveCodexExecutable } from "./codex-capabilities";
import { addReadiness, configObject, executableReadiness, findReadinessExecutable, isVersion, presentString, readLocalConfig, readPackageVersion, readinessRuntime } from "./readiness";
import type { LocalReadiness, ReadinessRuntime } from "./types";

function readCodexVersion(executable: string): string | null {
  const npm = readPackageVersion(executable, "@openai/codex");
  if (npm) return npm;
  try {
    const physical = realpathSync(executable);
    const directory = dirname(dirname(physical));
    const raw = readLocalConfig(join(directory, "codex-package.json"));
    if (!raw) return null;
    const info = configObject(JSON.parse(raw));
    if (info?.layoutVersion === 1 && info.variant === "codex" && isVersion(info.version)
      && typeof info.entrypoint === "string" && realpathSync(resolve(directory, info.entrypoint)) === physical) return info.version;
  } catch {}
  return null;
}

// Read only the selection/auth facts. Profile formats have changed across
// versions; leave their effective provider unknown rather than merging them.
function providerAuth(config: Record<string, unknown>, runtime: ReadinessRuntime): "openai-auth" | "no-openai-auth" | "missing-credentials" | "unknown" {
  if (config.profile !== undefined) return "unknown";
  const name = config.model_provider ?? "openai";
  if (!presentString(name)) return "unknown";
  // Built-ins take precedence over a same-named user definition.
  if (name === "openai") return "openai-auth";
  const provider = configObject(configObject(config.model_providers)?.[name]);
  if (!provider) return "unknown";
  // Extra mechanisms/options need the CLI's own loader. Do not duplicate it.
  if (Object.keys(provider).some((key) => !["name", "base_url", "env_key", "experimental_bearer_token", "wire_api", "requires_openai_auth"].includes(key))) return "unknown";
  if (!optionalString(provider.name) || !optionalString(provider.experimental_bearer_token)) return "unknown";
  if (provider.requires_openai_auth !== undefined && typeof provider.requires_openai_auth !== "boolean") return "unknown";
  if (provider.wire_api !== undefined && provider.wire_api !== "responses") return "unknown";
  if (provider.base_url !== undefined && !presentString(provider.base_url)) return "unknown";
  if (provider.env_key !== undefined) {
    if (!presentString(provider.env_key)) return "unknown";
    if (!presentString(runtime.env[provider.env_key])) return "missing-credentials";
  }
  if (provider.requires_openai_auth === true) return "openai-auth";
  return "no-openai-auth";
}

function hasAdditionalConfig(cwd: string, home: string): boolean {
  // Additional layers depend on Codex's trust/config loader. Their presence means
  // this deliberately small probe cannot establish the effective provider.
  for (const name of ["config.toml", "requirements.toml", "managed_config.toml"]) {
    if (readLocalConfig(join("/etc/codex", name)) !== null) return true;
  }
  if (readLocalConfig(join(cwd, "config.toml")) !== null) return true;
  for (let directory = resolve(cwd);;) {
    const path = join(directory, ".codex", "config.toml");
    if (path !== join(home, "config.toml") && readLocalConfig(path) !== null) return true;
    try {
      const marker = statSync(join(directory, ".git"));
      if (marker.isFile() || marker.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function validRefreshDate(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day && Number.isFinite(Date.parse(value));
}

// Codex deserializes ID-token claims while loading auth.json. This checks only
// its required encoding/claim types, never signature or remote validity.
function validIdToken(value: unknown): boolean {
  if (!presentString(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !part) || !/^[\w-]+$/.test(parts[1])) return false;
  try {
    const bytes = Buffer.from(parts[1], "base64url");
    if (bytes.toString("base64url") !== parts[1]) return false;
    const claims = configObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!claims || !optionalString(claims.email)) return false;
    const profile = claims["https://api.openai.com/profile"];
    if (profile != null && (!configObject(profile) || !optionalString(configObject(profile)?.email))) return false;
    const auth = claims["https://api.openai.com/auth"];
    if (auth != null) {
      const fields = configObject(auth);
      if (!fields || ["chatgpt_plan_type", "chatgpt_user_id", "user_id", "chatgpt_account_id"].some((key) => !optionalString(fields[key]))
        || (fields.chatgpt_account_is_fedramp !== undefined && typeof fields.chatgpt_account_is_fedramp !== "boolean")) return false;
    }
    return true;
  } catch { return false; }
}

function authReadiness(auth: Record<string, unknown>): LocalReadiness {
  if (Object.keys(auth).some((key) => !["OPENAI_API_KEY", "tokens", "auth_mode", "last_refresh"].includes(key))
    || !optionalString(auth.OPENAI_API_KEY) || !validRefreshDate(auth.last_refresh)) return "unknown";
  if (auth.auth_mode != null && !["apikey", "chatgpt", "chatgptAuthTokens"].includes(auth.auth_mode as string)) return "unknown";
  const tokens = auth.tokens == null ? undefined : configObject(auth.tokens);
  if (auth.tokens != null && (!tokens || !presentString(tokens.access_token) || !presentString(tokens.refresh_token)
    || !validIdToken(tokens.id_token) || !optionalString(tokens.account_id)
    || Object.keys(tokens).some((key) => !["access_token", "id_token", "refresh_token", "account_id"].includes(key)))) return "unknown";
  const mode = auth.auth_mode ?? (auth.OPENAI_API_KEY != null ? "apikey" : "chatgpt");
  if (mode === "apikey") return presentString(auth.OPENAI_API_KEY) ? true : auth.OPENAI_API_KEY == null ? "unknown" : false;
  if (tokens) return true;
  return presentString(auth.OPENAI_API_KEY) || auth.auth_mode != null ? "unknown" : false;
}

export function checkCodexReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  // Reuse launch resolution without running its help/capability probe.
  const executable = resolveCodexExecutable(cwd, (directory) => findReadinessExecutable("codex", directory, runtime));
  const result = executableReadiness(executable, executable ? readCodexVersion(executable) : null);
  if (!executable) return result;
  const home = runtime.env.CODEX_HOME ? resolve(cwd, runtime.env.CODEX_HOME) : join(runtime.homeDir, ".codex");
  const rawConfig = readLocalConfig(join(home, "config.toml"));
  let config: Record<string, unknown>;
  let store: unknown;
  try {
    if (rawConfig === undefined) throw new Error();
    config = rawConfig === null ? {} : configObject(Bun.TOML.parse(rawConfig))!;
    if (!config) throw new Error();
    store = config.cli_auth_credentials_store ?? "file";
  } catch {
    addReadiness(result, "unknown", "auth storage config unreadable or unrecognized");
    return result;
  }
  if (typeof store !== "string" || !["file", "auto", "keyring", "ephemeral"].includes(store)) {
    addReadiness(result, "unknown", "auth storage config unreadable or unrecognized");
    return result;
  }
  const required = hasAdditionalConfig(cwd, home) ? "unknown" : providerAuth(config, runtime);
  if (required === "unknown") {
    addReadiness(result, "unknown", "effective provider auth requirements unrecognized");
    return result;
  }
  if (required === "missing-credentials") {
    addReadiness(result, false, "provider environment credentials not found");
    return result;
  }
  if (required === "no-openai-auth") return result;
  if (store !== "file") {
    addReadiness(result, "unknown", "auth storage cannot be checked read-only");
    return result;
  }
  // Never run login/status: credential backends may migrate or refresh state.
  const raw = readLocalConfig(join(home, "auth.json"));
  if (raw === null) {
    addReadiness(result, false, "auth file not found");
    return result;
  }
  try {
    if (raw === undefined) throw new Error();
    const auth = configObject(JSON.parse(raw));
    if (!auth) throw new Error();
    const ready = authReadiness(auth);
    addReadiness(result, ready, ready === true ? undefined : ready === false ? "auth credentials not found" : "auth state unrecognized");
  } catch {
    addReadiness(result, "unknown", "auth file unreadable or unrecognized");
  }
  return result;
}
