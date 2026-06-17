import { StateDB } from "./state";

export interface NestingInfo {
  depth: number;
  parentSessionId: string | null;
  rootSessionId: string | null;
  lineage: string[];
}

const DEFAULT_MAX_NESTING_DEPTH = 4;

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

  return {
    depth: parentSession.depth + 1,
    parentSessionId: parentId,
    rootSessionId: null,
    lineage: [],
  };
}

export function getMaxNestingDepth(): number {
  const raw = process.env.AHELPA_MAX_NESTING_DEPTH;
  if (!raw) return DEFAULT_MAX_NESTING_DEPTH;

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_NESTING_DEPTH;
  return parsed;
}
