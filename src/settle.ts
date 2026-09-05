import { StateDB } from "./state";
import { Archive, type ArchivedSession } from "./archive";
import { Wakeup } from "./wakeup";
import type { SessionStatus } from "./session-lifecycle";

export async function settle(
  db: StateDB,
  archive: Archive,
  wakeup: Wakeup,
  sessionId: string,
  status: SessionStatus,
  archived: ArchivedSession,
  expectedStatus?: SessionStatus,
): Promise<boolean> {
  let settled = false;
  db.transaction(() => {
    if (expectedStatus !== undefined) {
      if (!db.compareAndSetStatus(sessionId, expectedStatus, status)) return;
    } else {
      db.updateStatus(sessionId, status);
    }
    archive.save(sessionId, archived);
    settled = true;
  });
  if (!settled) return false;
  await wakeup.notify(sessionId, status);
  wakeup.cleanup(sessionId);
  return true;
}
