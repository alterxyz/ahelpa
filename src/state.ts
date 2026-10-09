import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";
import { SESSION_STATUS, type SessionStatus } from "./session-lifecycle";
import type { HelperRole } from "./drivers/types";
import type { TargetFingerprint } from "./evidence";
import { claudePromptInput, inputDigest } from "./turn-hooks";

// Registration includes preparation: Codex allows ~88s of startup polling,
// and the launch lease is 180s. Five minutes leaves margin for local I/O but
// lets a crashed sender stop suppressing hooks. This never excludes a send.
export const TURN_IN_FLIGHT_MAX_AGE_MS = 5 * 60_000;

interface InFlightTurn { generation: number; startedAt: string; }

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
  turnHookOffset?: number | null;
  turnStartedAt?: string | null;
  turnInputDigest?: string | null;
  turnInputAmbiguous?: boolean;
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
  turn_hook_offset: number | null;
  turn_started_at: string | null;
  turn_input_digest: string | null;
  turn_input_history: string | null;
  turn_input_ambiguous: number | null;
  turn_input_sent: number | null;
  turn_in_flight: string | null;
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
    turnHookOffset: row.turn_hook_offset,
    turnStartedAt: row.turn_started_at,
    turnInputDigest: row.turn_input_digest,
    turnInputAmbiguous: row.turn_input_ambiguous === 1 || row.turn_input_digest != null
      && (JSON.parse(row.turn_input_history ?? "[]") as string[]).filter(value => value === row.turn_input_digest).length > 1,
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
        for (const column of ["check_cmd", "base_commit", "after_id", "nudged_at", "job_id", "target_fingerprint", "target_result_dirs", "unblind", "turn_started_at", "turn_input_digest", "turn_input_history", "turn_in_flight"]) {
          if (!columns.some((existing) => existing.name === column)) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
          }
        }
        if (!columns.some((column) => column.name === "turn_input_ambiguous")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN turn_input_ambiguous INTEGER");
        }
        if (!columns.some((column) => column.name === "turn_input_sent")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN turn_input_sent INTEGER");
        }
        if (!columns.some((column) => column.name === "turn_hook_offset")) {
          this.db.exec("ALTER TABLE sessions ADD COLUMN turn_hook_offset INTEGER");
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

  markLaunchRolledBack(id: string): void {
    this.db.prepare("UPDATE sessions SET status = ?, launch_pid = NULL, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(SESSION_STATUS.Dead, new Date().toISOString(), id);
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

  // Claim a log batch under the row-version guard, including the nudge marker
  // when applicable. Concurrent inline monitors cannot consume it twice.
  consumeTurnHook(id: string, version: number, offset: number, nudge = false): boolean {
    return this.db.prepare(`UPDATE sessions SET turn_hook_offset = ?,
      nudged_at = CASE WHEN ? THEN ? ELSE nudged_at END, version = version + 1
      WHERE id = ? AND status = ? AND version = ? AND (? = 0 OR nudged_at IS NULL)`)
      .run(offset, nudge ? 1 : 0, new Date().toISOString(), id, SESSION_STATUS.Running, version, nudge ? 1 : 0).changes > 0;
  }

  beginTurn(id: string, version: number, input: string): SessionRecord | null {
    return this.immediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
      if (!row || row.version !== version) return null;
      const digest = inputDigest(input);
      const candidates = [...new Set([digest, ...(row.agent_type === "claude-code" ? [inputDigest(claudePromptInput(input))] : [])])];
      const history = JSON.parse(row.turn_input_history ?? "[]") as string[];
      // Literal markup cannot be distinguished from the renderer's envelope.
      // Store both aliases in history, but keep the submitted digest unstripped.
      const ambiguous = (row.agent_type === "claude-code" && /<\/?pasted_content\b/u.test(input))
        || candidates.some(candidate => history.includes(candidate));
      const changed = this.db.prepare(`UPDATE sessions SET turn_started_at = ?, turn_input_digest = ?,
        turn_input_history = ?, turn_input_ambiguous = ?, turn_input_sent = 1, version = version + 1
        WHERE id = ? AND version = ? AND status IN (?, ?, ?)`)
        .run(new Date().toISOString(), digest, JSON.stringify([...history, ...candidates]), ambiguous ? 1 : 0,
          id, version, SESSION_STATUS.Running, SESSION_STATUS.NeedsAttention, SESSION_STATUS.Error).changes;
      return changed ? this.getSession(id) : null;
    });
  }

  // turn_input_sent records transport success, never ownership or exclusion.
  // An interrupted sender cannot block later sends or daemon/launch-lease work.
  // Register optimistically before transport. A stale snapshot may still send,
  // but its turn cannot safely use hooks: another registration may be in flight.
  registerTurn(id: string, version: number, input: string, options: { nudge?: boolean; hookOffset?: number } = {}) {
    return this.immediateTransaction(() => {
      const previous = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
      if (!previous || (options.nudge && previous.nudged_at != null)) {
        throw new Error(`Session ${id} changed before sending the new turn`);
      }
      let session = this.beginTurn(id, version, input);
      const stale = !session && previous.version !== version;
      if (stale) session = this.beginTurn(id, previous.version, input);
      if (!session) throw new Error(`Session ${id} changed before sending the new turn`);
      const now = Date.now();
      const inFlight = (JSON.parse(previous.turn_in_flight ?? "[]") as InFlightTurn[])
        .filter(entry => now - Date.parse(entry.startedAt) <= TURN_IN_FLIGHT_MAX_AGE_MS);
      const overlap = stale || inFlight.length > 0;
      inFlight.push({ generation: session.version, startedAt: new Date(now).toISOString() });
      this.db.prepare(`UPDATE sessions SET
        turn_input_sent = 0, turn_in_flight = ?,
        turn_input_ambiguous = CASE WHEN ? THEN 1 ELSE turn_input_ambiguous END,
        nudged_at = CASE WHEN ? THEN ? ELSE nudged_at END,
        turn_hook_offset = COALESCE(?, turn_hook_offset) WHERE id = ?`)
        .run(JSON.stringify(inFlight), overlap ? 1 : 0, options.nudge ? 1 : 0, new Date().toISOString(), options.hookOffset ?? null, id);
      const registered = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
      return { previous, registered, overlap, session: rowToRecord(registered) };
    });
  }

  finishTurn(registration: ReturnType<StateDB["registerTurn"]>, delivered: boolean): SessionRecord | null {
    return this.immediateTransaction(() => {
      const { previous, registered } = registration;
      const current = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(previous.id) as SessionRow | null;
      if (!current) return null;
      // Remove only this generation, even if a newer input replaced it or the
      // sender failed. Rollback must not restore a completed sender's entry.
      const inFlight = (JSON.parse(current.turn_in_flight ?? "[]") as InFlightTurn[])
        .filter(entry => entry.generation !== registered.version);
      this.db.prepare("UPDATE sessions SET turn_in_flight = ? WHERE id = ?")
        .run(JSON.stringify(inFlight), previous.id);
      // History is appended atomically with every registration, even when inputs
      // repeat or the wall clock stands still. Row versions also change for hooks,
      // model updates and kill; those alone do not mean another input was sent.
      if (current.turn_input_history !== registered.turn_input_history) {
        this.db.prepare(`UPDATE sessions SET turn_input_ambiguous = 1, version = version + 1
          WHERE id = ? AND version = ? AND COALESCE(turn_input_ambiguous, 0) != 1`)
          .run(previous.id, current.version);
      } else if (!delivered) {
        // Restore only our own failed registration. Never overwrite a newer
        // delivery or revive a status changed by kill/settle during transport.
        this.db.prepare(`UPDATE sessions SET turn_started_at = ?, turn_input_digest = ?,
          turn_input_history = ?, turn_input_ambiguous = ?, turn_input_sent = ?, nudged_at = ?,
          turn_hook_offset = ?, version = version + 1 WHERE id = ? AND version = ?`)
          .run(previous.turn_started_at, previous.turn_input_digest, previous.turn_input_history,
            registration.overlap || current.turn_input_ambiguous !== registered.turn_input_ambiguous
              ? 1 : previous.turn_input_ambiguous,
            previous.turn_input_sent, previous.nudged_at, previous.turn_hook_offset,
            previous.id, current.version);
      } else {
        this.db.prepare(`UPDATE sessions SET turn_input_sent = 1, version = version + 1 WHERE id = ? AND version = ?`)
          .run(previous.id, current.version);
      }
      return this.getSession(previous.id);
    });
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
