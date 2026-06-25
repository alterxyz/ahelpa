import { StateDB } from "../state";
import { isDaemonRunning, refreshSessionStatuses } from "../daemon";
import { SESSION_STATUS, WAIT_STATUS, type WaitStatus } from "../session-lifecycle";
import { Wakeup, defaultWakeup } from "../wakeup";
import { Archive } from "../archive";
import { defaultRuntimeLayout } from "../runtime-layout";

interface WaitResult { sessionId: string; status: WaitStatus; reason?: string; hint?: string; }

// Stays under the Bash hard timeout of agent platforms (e.g. 600s): wait
// returns still_running at the deadline instead of being killed mid-call.
export const DEFAULT_WAIT_TIMEOUT_MS = 500000;

// A missing session also stops the wait: callers get still_running back
// immediately instead of blocking on an id that will never complete.
function stopsWaiting(status: WaitStatus): boolean {
  return status !== SESSION_STATUS.Running;
}

// Cap each blocking stretch so a dropped wakeup (notify fired between our DB
// snapshot and the pipe read) costs at most one slice before the DB check
// catches it.
const WAKEUP_SLICE_MS = 5000;

export async function wait(
  db: StateDB,
  sessionIds: string[],
  all: boolean,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  wakeup: Wakeup = defaultWakeup,
): Promise<WaitResult | WaitResult[]> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const daemonRunning = isDaemonRunning();
    if (!daemonRunning) {
      await refreshSessionStatuses(db, sessionIds);
    }

    const archive = new Archive(defaultRuntimeLayout.archiveDir());
    const results = sessionIds.map((id): WaitResult => {
      const session = db.getSession(id);
      if (!session) return { sessionId: id, status: WAIT_STATUS.StillRunning };
      const status = session.status === SESSION_STATUS.Draining ? SESSION_STATUS.Idle : session.status;
      if (status === SESSION_STATUS.NeedsAttention) {
        const archived = archive.get(id);
        return { sessionId: id, status, reason: archived?.reason, hint: archived?.hint };
      }
      return { sessionId: id, status };
    });

    if (all && results.every((result) => stopsWaiting(result.status))) {
      return results;
    }

    const completed = results.find((result) => stopsWaiting(result.status));
    if (!all && completed) {
      return completed;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const timedOut = sessionIds.map((id) => ({ sessionId: id, status: WAIT_STATUS.StillRunning }));
      return all ? timedOut : timedOut[0];
    }

    if (daemonRunning) {
      // True sleep: block on the wakeup pipes until the daemon notifies.
      const slice = Math.min(WAKEUP_SLICE_MS, remaining);
      const pending = results
        .filter((result) => !stopsWaiting(result.status))
        .map((result) => result.sessionId);
      await Promise.race(pending.map((id) => wakeup.awaitWakeup(id, slice)));
    } else {
      await Bun.sleep(Math.min(1000, remaining));
    }
  }
}
