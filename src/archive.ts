import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import type { SessionStatus } from "./session-lifecycle";

// What the daemon keeps per settled session, and what `logs` reads back
// after the tmux session is gone.
export interface ArchivedSession {
  status: SessionStatus;
  lastOutput?: string;
  reason?: string;
  hint?: string;
  agentResumeId?: string;
}

export class Archive {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    mkdirSync(basePath, { recursive: true });
  }

  save(sessionId: string, data: ArchivedSession): void {
    const dir = `${this.basePath}/${sessionId}`;
    mkdirSync(dir, { recursive: true });
    const payload = { ...data, archivedAt: new Date().toISOString() };
    writeFileSync(`${dir}/message.json`, JSON.stringify(payload, null, 2));
  }

  get(sessionId: string): (ArchivedSession & { archivedAt?: string }) | null {
    const path = `${this.basePath}/${sessionId}/message.json`;
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }
}
