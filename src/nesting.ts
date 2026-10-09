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

// A native resume belongs to the original tree even when it resumes a root.
// clean retains both parent and resume ancestry while active descendants exist.
export function getSessionTreeId(db: StateDB, sessionId: string): string {
  const seen = new Set<string>();
  let currentId = sessionId;
  while (true) {
    if (seen.has(currentId)) throw new Error(`Cyclic session lineage detected at ${currentId}`);
    seen.add(currentId);
    const session = db.getSession(currentId);
    if (!session) return currentId;
    const ancestor = session.resumedFrom && db.getSession(session.resumedFrom)
      ? session.resumedFrom : session.parentId;
    if (!db.getSession(ancestor)) return currentId;
    currentId = ancestor;
  }
}

// Retain the whole parent chain for future tree traversal, plus native resume
// ancestry so a resumed root continues to share its original tree's quota.
export function activeSessionAncestorIds(db: StateDB, retainedSessionIds: Iterable<string> = []): Set<string> {
  const records = new Map(db.listSessions().map((session) => [session.id, session]));
  const retained = new Set<string>();
  const pending = [...db.listActiveSessions().map((session) => session.id), ...retainedSessionIds];
  while (pending.length) {
    const id = pending.pop()!;
    if (retained.has(id)) continue;
    retained.add(id);
    const session = records.get(id);
    if (!session) continue;
    for (const ancestor of [session.parentId, session.resumedFrom]) {
      if (ancestor && records.has(ancestor)) pending.push(ancestor);
    }
  }
  return retained;
}

export function getSessionNestingInfo(db: StateDB, sessionId: string): NestingInfo {
  const session = db.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const lineage = buildSessionLineage(db, sessionId);
  return {
    depth: Math.max(session.depth, lineage.length),
    parentSessionId: lineage.length > 1 ? lineage[lineage.length - 2] : null,
    rootSessionId: getSessionTreeId(db, sessionId),
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
    rootSessionId: getSessionTreeId(db, parentId),
    lineage,
  };
}

// Count the root and all active descendants, including resumed hands. Each
// direct host launch starts its own tree rather than sharing a host-wide quota.
export function listActiveSessionsInTree(db: StateDB, rootId: string): SessionRecord[] {
  const treeId = getSessionTreeId(db, rootId);
  return db.listActiveSessions().filter((session) => {
    try { return getSessionTreeId(db, session.id) === treeId; } catch { return false; }
  });
}

// The target may itself be nested. Walk through settled ancestors too: killing
// a parent leaves its lineage record available for the next late-spawn sweep.
export function listActiveDescendants(db: StateDB, sessionId: string): SessionRecord[] {
  return db.listActiveSessions().flatMap((session) => {
    if (session.id === sessionId) return [];
    try {
      const lineage = buildSessionLineage(db, session.id);
      return lineage.includes(sessionId) ? [{ session, depth: lineage.length }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.depth - a.depth || a.session.id.localeCompare(b.session.id))
    .map(({ session }) => session);
}

export function getMaxActivePerTree(): number {
  return readPositiveInt(process.env.AHELPA_MAX_ACTIVE_PER_TREE, DEFAULT_MAX_ACTIVE_PER_TREE);
}

export function getMaxNestingDepth(): number {
  return readPositiveInt(process.env.AHELPA_MAX_NESTING_DEPTH, DEFAULT_MAX_NESTING_DEPTH);
}

export function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}
