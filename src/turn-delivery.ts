import { StateDB, type SessionRecord } from "./state";

// All task/nudge deliveries reserve before any await and retain the lock through
// confirmation. Only a failed transport/prepare rolls back the prior turn.
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
  const reservation = db.reserveTurnDelivery(session.id, session.version, input, options);
  let delivered = false;
  try {
    await options.prepare?.();
    await send();
    delivered = true;
    return await options.afterSend?.(reservation.session);
  } finally {
    db.finishTurnDelivery(reservation, delivered);
  }
}
