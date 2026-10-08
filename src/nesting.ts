import { SessionRecord, StateDB } from "./state";

export interface NestingInfo {
  depth: number;
  parentSessionId: string | null;
  rootSessionId: string | null;
  lineage: string[];
}

const DEFAULT_MAX_NESTING_DEPTH = 4;
// Depth bounds how far a chain can go; this bounds how wide a tree can get.
// Without it a single helper can fan out without limit at a legal depth.
const DEFAULT_MAX_ACTIVE_PER_TREE = 8;

function buildSessionLineage(db: StateDB, sessionId: string): string[] {
  const lineage: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = sessionId;

  while (currentId) {
    if (seen.has(currentId)) {
      throw new Error(`Cyclic session lineage detected at ${currentId}`);
    }
    seen.add(currentId);

    const session = db.getSession(currentId);
    if (!session) break;

    lineage.push(session.id);
    currentId = session.parentId;
  }

  return lineage.reverse();
}

export function getSessionNestingInfo(db: StateDB, sessionId: string): NestingInfo {
  const session = db.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const lineage = buildSessionLineage(db, sessionId);
  return {
    depth: lineage.length,
    parentSessionId: lineage.length > 1 ? lineage[lineage.length - 2] : null,
    rootSessionId: lineage[0] || null,
    lineage,
  };
}

export function getPendingLaunchNestingInfo(db: StateDB, parentId: string): NestingInfo {
  const parentSession = db.getSession(parentId);
  if (!parentSession) {
    return {
      depth: 1,
      parentSessionId: null,
      rootSessionId: null,
      lineage: [],
    };
  }

  const lineage = buildSessionLineage(db, parentId);
  return {
    depth: parentSession.depth + 1,
    parentSessionId: parentId,
    rootSessionId: lineage[0] || parentId,
    lineage,
  };
}

// Every active session whose lineage starts at rootId, the root included.
// Launches from the host itself have no root session and are not counted:
// the host answers to a human, a helper's tree answers to this limit.
export function listActiveSessionsInTree(db: StateDB, rootId: string): SessionRecord[] {
  return db.listActiveSessions().filter((session) => {
    try { return buildSessionLineage(db, session.id)[0] === rootId; } catch { return false; }
  });
}

export function getMaxActivePerTree(): number {
  return readPositiveInt(process.env.AHELPA_MAX_ACTIVE_PER_TREE, DEFAULT_MAX_ACTIVE_PER_TREE);
}

export function getMaxNestingDepth(): number {
  return readPositiveInt(process.env.AHELPA_MAX_NESTING_DEPTH, DEFAULT_MAX_NESTING_DEPTH);
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}
