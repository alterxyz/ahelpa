import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";
import { SESSION_STATUS, type SessionStatus } from "./session-lifecycle";

export interface SessionRecord {
  id: string;
  parentId: string;
  agentType: string;
  task: string;
  status: SessionStatus;
  ownerToken: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  label?: string | null;
  depth: number;
  agentResumeId?: string | null;
  resumedFrom?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface CreateSessionInput {
  id: string;
  parentId: string;
  agentType: string;
  task: string;
  ownerToken: string;
  projectPath: string;
  label?: string | null;
  depth?: number;
  resumedFrom?: string;
  model?: string | null;
  effort?: string | null;
}

interface SessionRow {
  id: string;
  parent_id: string;
  agent_type: string;
  task: string;
  status: SessionStatus;
  owner_token: string;
  project_path: string;
  created_at: string;
  updated_at: string;
  label: string | null;
  depth: number;
  agent_resume_id: string | null;
  resumed_from: string | null;
  model: string | null;
  effort: string | null;
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    agentType: row.agent_type,
    task: row.task,
    status: row.status,
    ownerToken: row.owner_token,
    projectPath: row.project_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    label: row.label,
    depth: row.depth,
    agentResumeId: row.agent_resume_id,
    resumedFrom: row.resumed_from,
    model: row.model,
    effort: row.effort,
  };
}

export class StateDB {
  private db: Database;

  constructor(dbPath: string) {
    // Clean up orphaned WAL/SHM files left behind when only the main DB file
    // was deleted (e.g. in test teardown), to avoid disk I/O errors on reopen.
    if (!existsSync(dbPath)) {
      for (const suffix of ["-wal", "-shm"]) {
        const f = dbPath + suffix;
        if (existsSync(f)) try { unlinkSync(f); } catch {}
      }
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    try {
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "SQLITE_BUSY" && code !== "SQLITE_BUSY_RECOVERY") {
        throw error;
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '${SESSION_STATUS.Running}',
        owner_token TEXT NOT NULL,
        project_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        label TEXT,
        model TEXT,
        effort TEXT
      )
    `);
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    // Migration: drop legacy tmux_session column.
    if (columns.some((column) => column.name === "tmux_session")) {
      this.db.exec("ALTER TABLE sessions DROP COLUMN tmux_session");
    }
    // Migration: add depth column for O(1) nesting validation.
    if (!columns.some((column) => column.name === "depth")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN depth INTEGER NOT NULL DEFAULT 1");
    }
    // Migration: add agent resume and session lineage columns.
    if (!columns.some((column) => column.name === "agent_resume_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent_resume_id TEXT");
    }
    if (!columns.some((column) => column.name === "resumed_from")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN resumed_from TEXT");
    }
    // Migration: add launch-time model/effort columns so resume can reuse them.
    if (!columns.some((column) => column.name === "model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    }
    if (!columns.some((column) => column.name === "effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN effort TEXT");
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const depth = input.depth ?? 1;
    this.db.prepare(`
      INSERT INTO sessions (id, parent_id, agent_type, task, status, owner_token, project_path, created_at, updated_at, label, depth, resumed_from, model, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.parentId,
      input.agentType,
      input.task,
      SESSION_STATUS.Running,
      input.ownerToken,
      input.projectPath,
      now,
      now,
      input.label ?? null,
      depth,
      input.resumedFrom ?? null,
      input.model ?? null,
      input.effort ?? null,
    );
    return this.getSession(input.id) as SessionRecord;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    return row ? rowToRecord(row) : null;
  }

  updateStatus(id: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  }

  updateResumeId(id: string, agentResumeId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET agent_resume_id = ?, updated_at = ? WHERE id = ?").run(agentResumeId, now, id);
  }

  listSessions(parentId?: string): SessionRecord[] {
    if (parentId !== undefined) {
      const rows = this.db.prepare("SELECT * FROM sessions WHERE parent_id = ? ORDER BY updated_at DESC").all(parentId) as SessionRow[];
      return rows.map(rowToRecord);
    }
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[];
    return rows.map(rowToRecord);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteSessionsByStatus(status: SessionStatus): number {
    return this.db.prepare("DELETE FROM sessions WHERE status = ?").run(status).changes;
  }

  listActiveSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE status IN (?, ?, ?)").all(SESSION_STATUS.Running, SESSION_STATUS.Draining, SESSION_STATUS.NeedsAttention) as SessionRow[];
    return rows.map(rowToRecord);
  }

  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
