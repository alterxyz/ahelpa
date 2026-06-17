import { existsSync } from "fs";
import { FIFO } from "./fifo";
import { defaultRuntimeLayout, RuntimeLayout } from "./runtime-layout";
import type { SessionStatus } from "./session-lifecycle";

export interface WakeupEvent {
  sessionId: string;
  status: SessionStatus;
}

// The wakeup protocol behind `ahelpa wait`: launch prepares a pipe per
// session, the daemon notifies on completion, and wait blocks on the pipe
// instead of polling SQLite. Pipe paths, payload encoding, and the
// no-listener-drops-the-event semantics all live here and nowhere else.
// The DB row stays the source of truth; the pipe only cuts wakeup latency.
export class Wakeup {
  constructor(private layout: RuntimeLayout = defaultRuntimeLayout) {}

  async prepare(sessionId: string): Promise<void> {
    await FIFO.create(this.layout.fifoPath(sessionId));
  }

  async notify(sessionId: string, status: SessionStatus): Promise<void> {
    const path = this.layout.fifoPath(sessionId);
    if (!existsSync(path)) return;
    await FIFO.tryWrite(path, JSON.stringify({ sessionId, status } satisfies WakeupEvent));
  }

  async awaitWakeup(sessionId: string, timeoutMs: number): Promise<WakeupEvent | null> {
    const path = this.layout.fifoPath(sessionId);
    if (!existsSync(path)) {
      // No pipe to block on; hold the caller's pacing instead of spinning.
      await Bun.sleep(Math.max(0, timeoutMs));
      return null;
    }
    const raw = await FIFO.read(path, timeoutMs);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as WakeupEvent;
    } catch {
      return null;
    }
  }

  cleanup(sessionId: string): void {
    FIFO.remove(this.layout.fifoPath(sessionId));
  }
}

export const defaultWakeup = new Wakeup();
