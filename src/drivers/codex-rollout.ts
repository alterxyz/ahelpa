import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Positive identification only: unavailable metadata preserves notify attribution.
export function isKnownCodexSubagent(threadId: string): boolean {
  return codexThreadSource(threadId) === "subagent";
}

// "main" needs a recorded source without a subagent spawn. Unavailable metadata,
// or an older rollout with no source at all, says nothing and gives null.
export function codexThreadSource(threadId: string): "subagent" | "main" | null {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(threadId)) return null;
  // notify has no session source. UUIDv7 gives the creation time: probe
  // exact local-time rollout names; parse only the bounded metadata line.
  // A delayed/relocated rollout or older format keeps the legacy fallback.
  const created = parseInt(threadId.replaceAll("-", "").slice(0, 12), 16);
  for (let second = 0; second <= 4; second++) {
    let metaFd: number | undefined;
    try {
      const date = new Date(created + second * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
      const home = realpathSync(process.env.CODEX_HOME || join(homedir(), ".codex"));
      const path = join(home, "sessions", ...day.split("-"), `rollout-${day}T${time}-${threadId}.jsonl`);
      if (realpathSync(path) !== path) continue;
      metaFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(metaFd);
      const current = lstatSync(path);
      if (!opened.isFile() || opened.nlink !== 1 || !current.isFile()
        || opened.dev !== current.dev || opened.ino !== current.ino) continue;
      const bytes = Buffer.alloc(64 * 1024);
      const size = readSync(metaFd, bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, size).indexOf(10);
      if (end < 0) continue;
      const meta = JSON.parse(bytes.subarray(0, end).toString("utf8"));
      if (meta?.type !== "session_meta" || meta.payload?.id !== threadId) continue;
      const source = meta.payload.source;
      if (source == null) return null;
      return typeof source === "object" && source.subagent != null ? "subagent" : "main";
    } catch {} finally { if (metaFd !== undefined) try { closeSync(metaFd); } catch {} }
  }
  return null;
}
