import { StateDB } from "./state";
import { Archive, type ArchivedSession } from "./archive";
import { Wakeup } from "./wakeup";
import type { SessionStatus } from "./session-lifecycle";
import { defaultRuntimeLayout, RuntimeLayout } from "./runtime-layout";
import { notifySettledSession } from "./notify";

export interface SettleOptions {
  layout?: RuntimeLayout;
}

export async function settle(
  db: StateDB,
  archive: Archive,
  wakeup: Wakeup,
  sessionId: string,
  status: SessionStatus,
  archived: ArchivedSession,
  options: SettleOptions = {},
): Promise<void> {
  const before = db.getSession(sessionId);
  db.transaction(() => {
    db.updateStatus(sessionId, status);
    archive.save(sessionId, archived);
  });
  await wakeup.notify(sessionId, status);
  const after = db.getSession(sessionId);
  if (after && before?.status !== status) {
    await notifySettledSession(after, status, options.layout ?? defaultRuntimeLayout);
  }
  wakeup.cleanup(sessionId);
}
