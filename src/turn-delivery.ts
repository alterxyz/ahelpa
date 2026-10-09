import { StateDB, type SessionRecord } from "./state";

// Register before transport; overlapping deliveries remain allowed. Completion
// checks the registration again so delayed transport cannot leave a stale input
// attributable to hooks. Only a failed prepare/transport rolls back its own turn.
export async function deliverTurn<T>(
  db: StateDB,
  session: SessionRecord,
  input: string,
  send: () => Promise<void>,
  options: {
    nudge?: boolean;
    hookOffset?: number;
    prepare?: () => Promise<void>;
    afterSend?: (registered: SessionRecord) => Promise<T>;
  } = {},
): Promise<T | undefined> {
  const registration = db.registerTurn(session.id, session.version, input, options);
  let delivered = false;
  try {
    await options.prepare?.();
    await send();
    delivered = true;
    const confirmed = db.finishTurn(registration, true);
    return await options.afterSend?.(confirmed ?? registration.session);
  } finally {
    if (!delivered) db.finishTurn(registration, false);
  }
}
