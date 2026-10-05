// The sentinel protocol: helpers signal completion by printing an agreed
// sentinel. This module owns the sentinel strings and matching rules; the
// File handoff module owns the task/result instruction wording.

import type { DetectedOutcome } from "./types";

export const SENTINEL = {
  Done: "[AHELPA:DONE]",
  NeedHelp: "[AHELPA:NEED_HELP]",
} as const;

export interface PositionedSentinel extends DetectedOutcome {
  index: number;
  status: "idle" | "error";
}

function sentinelMatches(captureOutput: string) {
  return captureOutput.matchAll(
    /^\s*(?:[-•●⏺]\s*)?\[AHELPA:(DONE|NEED_HELP(?::([^\]\r\n]*))?)\]\s*$/gmu,
  );
}

export function scanSentinels(captureOutput: string): PositionedSentinel[] {
  return [...sentinelMatches(captureOutput)].map((match) => ({
    index: match.index,
    status: match[1] === "DONE" ? "idle" : "error",
    needHelpTags: match[1] === "DONE" ? null : [...new Set(
      (match[2] ?? "").split(",").map((tag) => tag.trim().toLowerCase())
        .filter((tag) => /^[a-z0-9_-]+$/.test(tag)),
    )],
  }));
}

export function maskSentinels(captureOutput: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of sentinelMatches(captureOutput)) {
    parts.push(captureOutput.slice(cursor, match.index), match[0].replace(/[^\r\n]/g, " "));
    cursor = match.index + match[0].length;
  }
  parts.push(captureOutput.slice(cursor));
  return parts.join("");
}

export function hasDoneSentinel(captureOutput: string): boolean {
  return scanSentinels(captureOutput).some((sentinel) => sentinel.status === "idle");
}

export function hasNeedHelpSentinel(captureOutput: string): boolean {
  return scanSentinels(captureOutput).some((sentinel) => sentinel.status === "error");
}

export function detectSentinelOutcome(captureOutput: string): DetectedOutcome {
  const sentinels = scanSentinels(captureOutput);
  const winner = sentinels.filter((sentinel) => sentinel.status === "error").at(-1)
    ?? sentinels.at(-1);
  return winner
    ? { status: winner.status, needHelpTags: winner.needHelpTags }
    : { status: "running", needHelpTags: null };
}

// Shared sentinel-based status detection. Both drivers delegate here;
// driver-specific detection can wrap or override this.
export function detectSentinelStatus(captureOutput: string): "idle" | "error" | "running" {
  return detectSentinelOutcome(captureOutput).status;
}
