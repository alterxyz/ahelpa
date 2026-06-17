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
): Promise<void> {
  db.transaction(() => {
    db.updateStatus(sessionId, status);
    archive.save(sessionId, archived);
  });
  await wakeup.notify(sessionId, status);
  wakeup.cleanup(sessionId);
}
