import { closeSync, openSync, readSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { addReadiness, configObject, executableReadiness, findReadinessExecutable, presentString, readLocalConfig, readinessRuntime } from "./readiness";
import type { ReadinessRuntime } from "./types";

// Kimi's native fork 0.1.34 bootstraps workers / staged updates BEFORE parsing
// --version. Read its embedded build-info instead of executing it. Other
// formats stay unknown. Bounded chunks avoid loading a native binary at once.
export function readKimiVersion(executable: string): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(executable).size;
    if (size > 256 * 1024 * 1024) return null;
    fd = openSync(executable, "r");
    const chunk = Buffer.alloc(1024 * 1024);
    let tail = "";
    let offset = 0;
    while (offset < size) {
      const length = readSync(fd, chunk, 0, chunk.length, offset);
      if (length === 0) break;
      const text = tail + chunk.subarray(0, length).toString("latin1");
      const info = text.match(/KIMI_BUILD_INFO\s*=\s*\{([^}]{1,2048})\}/);
      if (info) {
        const fork = info[1].match(/forkVersion:\s*optionalBuildString\("(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)"\)/)?.[1];
        const version = info[1].match(/\bversion:\s*optionalBuildString\("(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)"\)/)?.[1];
        return fork ?? version ?? null;
      }
      tail = text.slice(-4096);
      offset += length;
    }
  } catch {} finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

export function checkKimiReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("kimi", cwd, runtime);
  const result = executableReadiness(executable, executable ? readKimiVersion(executable) : null);
  if (!executable) return result;
  if (runtime.env.KIMI_MODEL_NAME) {
    if (!presentString(runtime.env.KIMI_MODEL_API_KEY)) addReadiness(result, false, "model override auth not found");
    return result;
  }
  const home = runtime.env.KIMI_CODE_HOME ? resolve(cwd, runtime.env.KIMI_CODE_HOME) : join(runtime.homeDir, ".kimi-code");
  const raw = readLocalConfig(join(home, "config.toml"));
  if (raw === null) {
    addReadiness(result, false, "config not found");
    return result;
  }
  try {
    if (raw === undefined) throw new Error();
    const config = configObject(Bun.TOML.parse(raw));
    if (!config) throw new Error();
    const alias = config.default_model;
    if (!presentString(alias)) {
      addReadiness(result, false, "default model not configured");
      return result;
    }
    const model = configObject(configObject(config.models)?.[alias]);
    const providerName = model?.provider ?? config.default_provider;
    const provider = presentString(providerName) ? configObject(configObject(config.providers)?.[providerName]) : undefined;
    if (!model || !provider) {
      addReadiness(result, false, "default model or provider not found");
      return result;
    }
    if (!presentString(model.model) || typeof model.max_context_size !== "number"
      || !Number.isInteger(model.max_context_size) || model.max_context_size <= 0) {
      addReadiness(result, "unknown", "model config missing or invalid required fields");
      return result;
    }
    const env = configObject(provider.env);
    const keyNames: Record<string, string[]> = {
      kimi: ["KIMI_API_KEY"], anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"], openai_responses: ["OPENAI_API_KEY"],
      "google-genai": ["GOOGLE_API_KEY"], vertexai: ["VERTEXAI_API_KEY", "GOOGLE_API_KEY"],
    };
    const keys = presentString(provider.type) && Object.hasOwn(keyNames, provider.type) ? keyNames[provider.type] : undefined;
    if (!keys) {
      addReadiness(result, "unknown", "provider type unrecognized");
      return result;
    }
    const hasKey = presentString(provider.api_key) || keys.some((key) => presentString(env?.[key]));
    if (hasKey && provider.oauth !== undefined) {
      addReadiness(result, "unknown", "provider API key and OAuth are mutually exclusive");
      return result;
    }
    if (hasKey) return result;
    const oauth = configObject(provider.oauth);
    if (!oauth) {
      addReadiness(result, provider.type === "vertexai" ? "unknown" : false,
        provider.type === "vertexai" ? "service identity auth cannot be checked read-only" : "auth credentials not found");
      return result;
    }
    if (oauth.storage !== "file" || !presentString(oauth.key)) {
      addReadiness(result, "unknown", "auth storage cannot be checked read-only");
      return result;
    }
    const auth = readLocalConfig(join(home, "credentials", `${basename(oauth.key)}.json`));
    if (auth === null) addReadiness(result, false, "auth file not found");
    else if (auth === undefined) addReadiness(result, "unknown", "auth file unreadable");
    else {
      const credentials = configObject(JSON.parse(auth));
      if (!credentials) throw new Error();
      if (!presentString(credentials.access_token)) addReadiness(result, false, "auth credentials not found");
    }
  } catch {
    addReadiness(result, "unknown", "config or auth file unreadable or unrecognized");
  }
  return result;
}
