import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
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

// Version-only invocations exit before interactive startup for Claude/Codex.
// Kimi must not use this: its bootstrap runs before --version (see its probe).
export function readLocalVersion(executable: string, cwd: string, runtime: ReadinessRuntime): string | null {
  let pid: number | undefined;
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      cwd, env: runtime.env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore",
      timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 4096,
    });
    pid = result.pid;
    if (!result.success || result.exitedDueToTimeout || result.exitedDueToMaxBuffer) return null;
    // Emit only a version, not arbitrary executable output (possibly secrets).
    return result.stdout.toString().trim().match(/^(?:[\w .-]+\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s+\([\w .-]+\))?$/)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  }
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
