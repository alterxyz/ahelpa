import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { DriverReadiness, LocalReadiness, ReadinessRuntime } from "./types";

export function readinessRuntime(): ReadinessRuntime {
  return { homeDir: homedir(), env: process.env };
}

export function findReadinessExecutable(binary: string, cwd: string, runtime: ReadinessRuntime): string | null {
  try {
    const found = Bun.which(binary, { cwd, PATH: runtime.env.PATH ?? "" });
    return found ? resolve(cwd, found) : null;
  } catch {
    return null;
  }
}

// These files can contain secrets. Only callers inspect shape; never return
// parser errors, file contents or auth values in a readiness reason.
export function readLocalConfig(path: string): string | null | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    return readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

export function configObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function presentString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Never execute agent binaries, including PATH wrappers, to learn a version.
// Only accept package metadata that identifies this exact executable.
export function readPackageVersion(executable: string, packageName: string): string | null {
  try {
    const physical = realpathSync(executable);
    for (const directory of [dirname(physical), dirname(dirname(physical))]) {
      const raw = readLocalConfig(join(directory, "package.json"));
      if (!raw) continue;
      const info = configObject(JSON.parse(raw));
      if (info?.name !== packageName || !isVersion(info.version)) continue;
      const bins = typeof info.bin === "string" ? [info.bin] : Object.values(configObject(info.bin) ?? {});
      if (bins.some((bin) => typeof bin === "string" && realpathSync(resolve(directory, bin)) === physical)) return info.version;
    }
  } catch {}
  return null;
}

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);
}

// Native distributions can embed build metadata. Scan read-only in bounded
// chunks; unrecognized formats remain unknown rather than running --version.
export function readEmbeddedVersion(executable: string, pattern: RegExp): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(executable).size;
    if (size > 256 * 1024 * 1024) return null;
    fd = openSync(executable, "r");
    const chunk = Buffer.alloc(1024 * 1024);
    let tail = "";
    for (let offset = 0; offset < size;) {
      const length = readSync(fd, chunk, 0, chunk.length, offset);
      if (!length) break;
      const text = tail + chunk.subarray(0, length).toString("latin1");
      const version = text.match(pattern)?.[1];
      if (isVersion(version)) return version;
      tail = text.slice(-4096);
      offset += length;
    }
  } catch {} finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

export function executableReadiness(executable: string | null, version: string | null): DriverReadiness {
  return {
    executable, version,
    locally_ready: executable === null ? false : version === null ? "unknown" : true,
    reasons: executable === null ? ["binary not found"] : version === null ? ["version unavailable"] : [],
  };
}

// A definite blocker wins over an unknown probe.
export function addReadiness(result: DriverReadiness, ready: LocalReadiness, reason?: string): void {
  if (ready === false || result.locally_ready === false) result.locally_ready = false;
  else if (ready === "unknown") result.locally_ready = "unknown";
  if (reason) result.reasons.push(reason);
}
