import { StateDB, type SessionRecord } from "./state";

export type SessionAccessErrorCode = "SESSION_NOT_FOUND" | "INVALID_TOKEN";

export class SessionAccessError extends Error {
  readonly code: SessionAccessErrorCode;

  constructor(code: SessionAccessErrorCode, message: string) {
    super(message);
    this.name = "SessionAccessError";
    this.code = code;
  }
}

export function requireAuthorizedSession(db: StateDB, sessionId: string, token: string): SessionRecord {
  const session = db.getSession(sessionId);
  if (!session) {
    throw new SessionAccessError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
  }
  if (session.ownerToken !== token) {
    throw new SessionAccessError("INVALID_TOKEN", "Invalid token");
  }
  return session;
}
