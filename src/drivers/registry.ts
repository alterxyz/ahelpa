import type { AgentDriver } from "./types";
import { claudeCodeDriver } from "./claude-code";
import { codexDriver } from "./codex";

const registry = new Map<string, AgentDriver>([
  ["claude-code", claudeCodeDriver],
  ["codex", codexDriver],
]);

export function getDriver(name: string): AgentDriver {
  const driver = registry.get(name);
  if (!driver) {
    throw new Error(`Unknown driver: "${name}". Available drivers: ${listDrivers().join(", ")}`);
  }
  return driver;
}

export function listDrivers(): string[] {
  return Array.from(registry.keys());
}
