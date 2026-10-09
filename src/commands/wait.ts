import { StateDB } from "../state";
import { isDaemonRunning, refreshSessionStatuses } from "../daemon";
import { SESSION_STATUS, WAIT_STATUS, type WaitStatus } from "../session-lifecycle";
import { Wakeup, defaultWakeup } from "../wakeup";
import { copyFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { collectEvidence, runCheck, type CheckResult, type CheckRunner, type Evidence } from "../evidence";

interface WaitResult { sessionId: string; status: WaitStatus; evidence?: Evidence; }

// Evidence shares wait's deadline: checks run in parallel and each gets only
// the time left, so wait stays under the platform's hard timeout. A check that
// finds no budget is reported as skipped; a re-wait starts a fresh budget.
async function withEvidence(db: StateDB, results: WaitResult[], deadline: number): Promise<WaitResult[]> {
  const checkTimeoutMs = deadline - Date.now();
  const runCheck = sharedCheckRunner();
  await Promise.all(results.map(async (result) => {
    if (result.status === WAIT_STATUS.StillRunning || !stopsWaiting(result.status)) return;
    const session = db.getSession(result.sessionId);
    if (session) result.evidence = await collectEvidence(session, { checkTimeoutMs, runCheck, deadline });
  }));
  return results;
}

// Two helpers in one project with the same --check would otherwise run the
// same suite on the same tree at once and fail each other. Run it once per
// (project, command); every session still gets its own check.log copy.
function sharedCheckRunner(): CheckRunner {
  const runs = new Map<string, Promise<CheckResult>>();
  return async (cwd, command, logPath, timeoutMs) => {
    const key = `${cwd}\0${command}`;
    let run = runs.get(key);
    if (!run) {
      run = runCheck(cwd, command, logPath, timeoutMs);
      runs.set(key, run);
    }
    const result = await run;
    if (result.logPath === logPath) return result;
    try { mkdirSync(dirname(logPath), { recursive: true }); copyFileSync(result.logPath, logPath); } catch {}
    return { ...result, logPath };
  };
}

// Stays under the Bash hard timeout of agent platforms (e.g. 600s): wait
// returns still_running at the deadline instead of being killed mid-call.
export const DEFAULT_WAIT_TIMEOUT_MS = 500000;

// A missing session also stops the wait: callers get dead back
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

    const results = sessionIds.map((id): WaitResult => {
      const session = db.getSession(id);
      // ponytail: reaped sessions have no DB row — treat as done, not stuck
      if (!session) return { sessionId: id, status: SESSION_STATUS.Dead };
      const status = session.status === SESSION_STATUS.Draining ? SESSION_STATUS.Idle : session.status;
      return { sessionId: id, status };
    });

    if (all && results.every((result) => stopsWaiting(result.status))) {
      return withEvidence(db, results, deadline);
    }

    const completed = results.find((result) => stopsWaiting(result.status));
    if (!all && completed) {
      return (await withEvidence(db, [completed], deadline))[0];
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const timedOut = await withEvidence(db, results.map((result): WaitResult => stopsWaiting(result.status)
        ? result
        : { sessionId: result.sessionId, status: WAIT_STATUS.StillRunning }), deadline);
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
