// Shared by CLI parent resolution and relationship rendering. Mail uses the
// stricter AHELPA_PARENT_ID -> existing session rule directly.
export function resolveParentId(
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): string {
  return env.AHELPA_PARENT_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CODEX_THREAD_ID
    || env.CODEX_COMPANION_SESSION_ID
    || `cli-${now()}`;
}
