import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";
import { SESSION_STATUS, type SessionStatus } from "./session-lifecycle";
import type { HelperRole } from "./drivers/types";
import type { TargetFingerprint } from "./evidence";

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
  version: number;
  label?: string | null;
  depth: number;
  agentResumeId?: string | null;
  resumedFrom?: string | null;
  model?: string | null;
  effort?: string | null;
  role?: HelperRole | null;
  safe: boolean;
  checkCmd?: string | null;
  baseCommit?: string | null;
  afterId?: string | null;
  nudgedAt?: string | null;
  jobId?: string | null;
  launchPid?: number | null;
  targetFingerprint?: TargetFingerprint | null;
  // Resume keeps the original baseline and excludes every delivery directory
  // in that native conversation, even if old session rows are later reaped.
  targetResultDirs?: string[] | null;
  unblind?: boolean;
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
  role?: HelperRole | null;
  safe?: boolean;
  checkCmd?: string | null;
  baseCommit?: string | null;
  afterId?: string | null;
  jobId?: string | null;
  launchPid?: number | null;
  targetFingerprint?: TargetFingerprint | null;
  targetResultDirs?: string[] | null;
  unblind?: boolean;
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
  version: number;
  label: string | null;
  depth: number;
  agent_resume_id: string | null;
  resumed_from: string | null;
  model: string | null;
  effort: string | null;
  role: HelperRole | null;
  safe: number;
  check_cmd: string | null;
  base_commit: string | null;
  after_id: string | null;
  nudged_at: string | null;
  job_id: string | null;
  launch_pid: number | null;
  target_fingerprint: string | null;
  target_result_dirs: string | null;
  unblind: string | null;
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
    version: row.version,
    label: row.label,
    depth: row.depth,
    agentResumeId: row.agent_resume_id,
    resumedFrom: row.resumed_from,
    model: row.model,
    effort: row.effort,
    role: row.role,
    safe: row.safe === 1,
    checkCmd: row.check_cmd,
    baseCommit: row.base_commit,
    afterId: row.after_id,
    nudgedAt: row.nudged_at,
    jobId: row.job_id,
    launchPid: row.launch_pid,
    targetFingerprint: row.target_fingerprint ? JSON.parse(row.target_fingerprint) : null,
    targetResultDirs: row.target_result_dirs ? JSON.parse(row.target_result_dirs) : null,
    unblind: row.unblind === "true",
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
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      try {
        this.db.exec("PRAGMA journal_mode=WAL;");
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_BUSY_RECOVERY") {
          throw error;
        }
      }
      // Multiple CLI processes may open an old database together. Acquire the
      // write lock before inspecting its schema so migrations cannot race on
      // the same missing column or observe a partially migrated table.
      this.db.transaction(() => {
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
            effort TEXT,
            role TEXT,
            safe INTEGER NOT NULL DEFAULT 0
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
        // Migration: preserve the launch permission posture across native resume.
        if (!columns.some((column) => column.name === "safe")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN safe INTEGER NOT NULL DEFAULT 0");
        }
        // Existing sessions retain an unknown role; new launch defaults must
        // not reinterpret their original model or intended use.
        if (!columns.some((column) => column.name === "role")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN role TEXT");
        }
        // Keep the CAS version separate from timestamps used for drain timing.
        if (!columns.some((column) => column.name === "version")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
        }
        // Migration: acceptance command, launch baseline, and hand lineage for evidence.
        // job_id groups the hands of one change so they can be checked and awaited together.
        for (const column of ["check_cmd", "base_commit", "after_id", "nudged_at", "job_id", "target_fingerprint", "target_result_dirs", "unblind"]) {
          if (!columns.some((existing) => existing.name === column)) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
          }
        }
        if (!columns.some((column) => column.name === "launch_pid")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN launch_pid INTEGER");
        }
      }).immediate();
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const depth = input.depth ?? 1;
    this.db.prepare(`
      INSERT INTO sessions (id, parent_id, agent_type, task, status, owner_token, project_path, created_at, updated_at, label, depth, resumed_from, model, effort, safe, role, check_cmd, base_commit, after_id, job_id, launch_pid, target_fingerprint, target_result_dirs, unblind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.safe ? 1 : 0,
      input.role ?? null,
      input.checkCmd ?? null,
      input.baseCommit ?? null,
      input.afterId ?? null,
      input.jobId ?? null,
      input.launchPid ?? null,
      input.targetFingerprint ? JSON.stringify(input.targetFingerprint) : null,
      input.targetResultDirs ? JSON.stringify(input.targetResultDirs) : null,
      input.unblind === undefined ? null : String(input.unblind),
    );
    return this.getSession(input.id) as SessionRecord;
  }

  // Publish only while the running reservation still belongs to this launcher.
  completeLaunch(id: string, launchPid: number, baseCommit?: string | null, status?: SessionStatus, targetFingerprint?: TargetFingerprint | null): boolean {
    return this.db.prepare(`UPDATE sessions SET launch_pid = NULL, status = COALESCE(?, status),
      base_commit = CASE WHEN ? THEN ? ELSE base_commit END,
      target_fingerprint = CASE WHEN ? THEN ? ELSE target_fingerprint END,
      updated_at = ?, version = version + 1 WHERE id = ? AND status = ? AND launch_pid = ?`)
      .run(status ?? null, baseCommit !== undefined ? 1 : 0, baseCommit ?? null, targetFingerprint !== undefined ? 1 : 0, targetFingerprint ? JSON.stringify(targetFingerprint) : null, new Date().toISOString(), id, SESSION_STATUS.Running, launchPid).changes > 0;
  }

  immediateTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    return row ? rowToRecord(row) : null;
  }

  updateStatus(id: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(status, now, id);
  }

  compareAndSetStatus(id: string, expected: SessionStatus, status: SessionStatus, expectedVersion?: number): boolean {
    // Increment under SQLite's write lock: processes must not read/increment/write in JS.
    return this.db.prepare(`UPDATE sessions SET status = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = ? AND (? IS NULL OR version = ?)`)
      .run(status, new Date().toISOString(), id, expected, expectedVersion ?? null, expectedVersion ?? null).changes > 0;
  }

  updateResumeId(id: string, agentResumeId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET agent_resume_id = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(agentResumeId, now, id);
  }

  // Persisted, not in-process: a restarted daemon or an inline refresh from
  // another process must not nudge the same helper twice.
  markNudged(id: string): void {
    this.db.prepare("UPDATE sessions SET nudged_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), id);
  }

  updateModel(id: string, model: string, effort: string | null): void {
    this.db.prepare("UPDATE sessions SET model = ?, effort = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(model, effort, new Date().toISOString(), id);
  }

  listJobSessions(jobId: string): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE job_id = ? ORDER BY created_at ASC").all(jobId) as SessionRow[];
    return rows.map(rowToRecord);
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
