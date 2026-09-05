// The sentinel protocol: helpers signal completion by printing an agreed
// sentinel. This module owns the sentinel strings and matching rules; the
// File handoff module owns the task/result instruction wording.

export const SENTINEL = {
  Done: "[AHELPA:DONE]",
  NeedHelp: "[AHELPA:NEED_HELP]",
} as const;

function matchesStandaloneSentinel(captureOutput: string, sentinel: string): boolean {
  const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)\\s*(?:[-•●⏺]\\s*)?${escaped}\\s*(?=$|\\n)`, "m");
  return pattern.test(captureOutput);
}

export function hasDoneSentinel(captureOutput: string): boolean {
  return matchesStandaloneSentinel(captureOutput, SENTINEL.Done);
}

export function hasNeedHelpSentinel(captureOutput: string): boolean {
  return matchesStandaloneSentinel(captureOutput, SENTINEL.NeedHelp);
}

// Loose containment check (not standalone-line): used right after task
// submission, where any sentinel appearing means the helper already reacted.
export function hasInlineSentinel(captureOutput: string): boolean {
  return captureOutput.includes(SENTINEL.Done) || captureOutput.includes(SENTINEL.NeedHelp);
}

// Shared sentinel-based status detection. Both drivers delegate here;
// driver-specific detection can wrap or override this.
export function detectSentinelStatus(captureOutput: string): "idle" | "error" | "running" {
  if (hasNeedHelpSentinel(captureOutput)) return "error";
  if (hasDoneSentinel(captureOutput)) return "idle";
  return "running";
}
