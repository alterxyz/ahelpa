import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { resolveJobId } from "./launch";
import { planFileHandoff } from "../file-handoff";
import { readPositiveInt } from "../nesting";
import { StateDB, type PeerMailRecord, type SessionRecord } from "../state";

function requireHelper(db: StateDB): SessionRecord {
  const id = process.env.AHELPA_PARENT_ID;
  const caller = id ? db.getSession(id) : null;
  if (!caller) throw new Error("Peer mail requires a helper session; mail to the host is out of scope. The host talks to helpers with send/task.");
  if (caller.role === "reviewer") throw new Error("A reviewer cannot send or receive peer mail");
  if (!caller.jobId) throw new Error("Peer mail requires a job; this helper has no job");
  resolveJobId(db, caller.jobId, undefined);
  return caller;
}

function requireRunning(session: SessionRecord): void {
  if (session.status !== "running") throw new Error(`Peer mail requires a running session: ${session.id} is ${session.status}`);
}

function requireAbsoluteProject(session: SessionRecord): void {
  if (!isAbsolute(session.projectPath)) throw new Error(`Peer mail requires an absolute project path for ${session.id}; launch a new session with an absolute --project path`);
}

export function mail(db: StateDB, toId: string | undefined, peers: boolean, content: string): PeerMailRecord[] {
  const createdFiles: string[] = [];
  let ledgerPath: string | undefined;
  let ledgerSize = 0;
  let ledgerExisted = false;
  let ledgerTouched = false;
  return db.immediateTransaction(() => {
    try {
      // Re-read identity, status, roles, job and budget while holding SQLite's
      // write lock: settlement and another sender cannot race the decision.
      const sender = requireHelper(db);
      requireRunning(sender);
      requireAbsoluteProject(sender);
      const recipients = peers
        ? db.listJobSessions(sender.jobId!).filter((s) => s.id !== sender.id && s.status === "running" && s.role !== "reviewer")
        : [db.getSession(toId!)];
      if (!recipients.length) throw new Error("No running peers in this job");
      for (const recipient of recipients) {
        if (!recipient) throw new Error(`Session not found: ${toId}`);
        if (recipient.id === sender.id) throw new Error("Cannot send peer mail to self");
        if (recipient.role === "reviewer") throw new Error("A reviewer cannot send or receive peer mail");
        if (recipient.jobId !== sender.jobId) throw new Error("Peer mail is restricted to the same job");
        requireRunning(recipient);
        requireAbsoluteProject(recipient);
      }
      const budget = readPositiveInt(process.env.AHELPA_MAIL_BUDGET, 8);
      const sent = db.peerMailCounts(sender.id).sent;
      if (sent + recipients.length > budget) throw new Error(`Peer mail budget exceeded (${sent} sent, ${recipients.length} requested, limit ${budget})`);
      ledgerPath = join(planFileHandoff(sender.projectPath, sender.id).projectDeliveryDir, "jobs", sender.jobId!, "mail.jsonl");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      ledgerExisted = existsSync(ledgerPath);
      if (ledgerExisted && !statSync(ledgerPath).isFile()) throw new Error("Peer mail ledger must be a regular file");
      ledgerSize = ledgerExisted ? statSync(ledgerPath).size : 0;
      const messages: PeerMailRecord[] = [];
      for (const recipient of recipients) {
        const to = recipient!;
        const seq = db.nextPeerMailSeq(to.id);
        const inbox = join(planFileHandoff(to.projectPath, to.id).sessionDeliveryDir, "inbox");
        const path = join(inbox, `${seq}-from-${sender.id}.md`);
        mkdirSync(inbox, { recursive: true });
        // Never overwrite an orphan from an interrupted delivery. Keep its
        // bytes available for inspection and report the uncertain delivery.
        if (existsSync(path)) throw new Error(`Peer mail file already exists: ${path}; delivery is uncertain`);
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        createdFiles.push(temporary);
        writeFileSync(temporary, content, { flag: "wx" });
        renameSync(temporary, path);
        createdFiles.push(path);
        const message = { ts: new Date().toISOString(), from: sender.id, to: to.id, seq, bytes: Buffer.byteLength(content), path, readAt: null };
        db.recordPeerMail(message);
        messages.push(message);
      }
      ledgerTouched = true;
      appendFileSync(ledgerPath, messages.map(({ ts, from, to, seq, bytes }) => JSON.stringify({ ts, from, to, seq, bytes }) + "\n").join(""));
      return messages;
    } catch (error) {
      // Cleanup runs before releasing SQLite's write lock, so another process
      // cannot append a new ledger entry before this batch's tail is removed.
      for (const path of createdFiles.reverse()) if (existsSync(path)) unlinkSync(path);
      if (ledgerTouched && ledgerPath) {
        if (ledgerExisted) truncateSync(ledgerPath, ledgerSize);
        else if (existsSync(ledgerPath)) unlinkSync(ledgerPath);
      }
      throw error;
    }
  });
}

export function inbox(db: StateDB, seq?: number): PeerMailRecord[] | string {
  const caller = requireHelper(db);
  const messages = db.listPeerMail(caller.id);
  if (seq === undefined) return messages;
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error("--read must be a positive integer");
  const message = messages.find((m) => m.seq === seq);
  if (!message) throw new Error(`Peer message not found: ${seq}`);
  const content = readFileSync(message.path, "utf8");
  db.markPeerMailRead(caller.id, seq);
  return content;
}
