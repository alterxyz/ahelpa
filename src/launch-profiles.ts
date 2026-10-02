import type { AgentDriver, HelperRole } from "./drivers/types";

export function parseHelperRole(value?: string): HelperRole | undefined {
  if (value === undefined || value === "worker" || value === "advisor") return value;
  throw new Error(`Unknown helper role "${value}". Available roles: worker, advisor`);
}

// Only new launches resolve presets. Native resume commands must reuse the
// recorded choice, including an unspecified choice in older session records.
export function resolveLaunchProfile(
  driver: AgentDriver,
  options: { role?: string; model?: string; effort?: string },
): { role?: HelperRole; model?: string; effort?: string } {
  const requestedRole = parseHelperRole(options.role);
  const launchProfiles = driver.launchProfiles;
  if (!launchProfiles) {
    if (requestedRole !== undefined) {
      throw new Error(`${driver.name} does not support helper roles`);
    }
    return { model: options.model, effort: options.effort };
  }

  const role = requestedRole ?? launchProfiles.defaultRole;
  const profile = launchProfiles.profiles[role];
  if (!profile) {
    throw new Error(
      `${driver.name} does not support role "${role}". Available roles: ${Object.keys(launchProfiles.profiles).join(", ")}`,
    );
  }
  return {
    role,
    model: options.model ?? profile.model,
    effort: options.effort ?? profile.effort,
  };
}
