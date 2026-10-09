import { statSync } from "fs";
import { resolve } from "path";
import { getDriver, listDrivers } from "../drivers/registry";
import { addReadiness, findReadinessExecutable, readinessRuntime } from "../drivers/readiness";
import type { DriverReadiness, ReadinessRuntime } from "../drivers/types";

export function doctor(agent?: string, project = process.cwd(), runtime: ReadinessRuntime = readinessRuntime()) {
  const agents = agent === undefined ? listDrivers() : [agent];
  // Validate selection and cwd before any executable probe.
  const drivers = agents.map((name) => [name, getDriver(name)] as const);
  const cwd = resolve(project);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new Error("Project path must be an existing directory");
  }
  const tmux = findReadinessExecutable("tmux", cwd, runtime);
  const results: Record<string, DriverReadiness> = {};
  for (const [name, driver] of drivers) {
    const result = driver.checkReadiness?.(cwd, runtime) ?? {
      executable: null, version: null, locally_ready: "unknown", reasons: ["local readiness probe unavailable"],
    };
    if (tmux === null) addReadiness(result, false, "tmux not found");
    results[name] = result;
  }
  return { project: cwd, tmux: { present: tmux !== null, executable: tmux }, agents: results };
}
