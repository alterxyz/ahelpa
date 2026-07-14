import { unlinkSync } from "fs";
import { StateDB } from "./state";
import { Wakeup } from "./wakeup";
import { defaultRuntimeLayout, RuntimeLayout } from "./runtime-layout";

// The single reclamation path for a session that is done: drop its wakeup pipe,
// drop its task file, drop its DB row. summary.md in the project dir is the
// receipt; the row is disposable. The daemon reaps automatically, `harvest`
// reaps on demand — both go through here so they leave the same state behind.
export function reapSession(
  db: StateDB,
  sessionId: string,
  layout: RuntimeLayout = defaultRuntimeLayout,
): void {
  new Wakeup(layout).cleanup(sessionId);
  try { unlinkSync(layout.taskFilePath(sessionId)); } catch {}
  db.deleteSession(sessionId);
}
