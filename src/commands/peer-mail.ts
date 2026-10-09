import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, type Stats } from "fs";
import { dirname, isAbsolute, join } from "path";
import { resolveJobId } from "./launch";
import { planFileHandoff } from "../file-handoff";
import { scanSentinels } from "../drivers/sentinels";
import { StateDB, type PeerMailRecord, type SessionRecord } from "../state";

export const MAX_MAIL_FILE_BYTES = 1024 * 1024;

export function readMailFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Peer mail --file must be a regular file");
  if (stat.size > MAX_MAIL_FILE_BYTES) throw new Error("Peer mail --file exceeds the 1 MiB limit");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_MAIL_FILE_BYTES) throw new Error("Peer mail --file exceeds the 1 MiB limit");
  try {
    // Preserve a UTF-8 BOM and reject malformed bytes instead of replacing them.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Peer mail --file must contain valid UTF-8");
  }
}

function existingStat(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requireInboxDirectory(path: string): void {
  const stat = existingStat(path);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error("Peer mail inbox must be a directory, not a symlink");
  }
}

function isDirectLineage(sender: SessionRecord, recipient: SessionRecord): boolean {
  return recipient.id === sender.parentId || recipient.parentId === sender.id;
}

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
  if (session.launchPid != null) throw new Error(`Session ${session.id} is still launching; retry after launch completes`);
  if (session.status !== "running") throw new Error(`Peer mail requires a running session: ${session.id} is ${session.status}`);
}

function requireAbsoluteProject(session: SessionRecord): void {
  if (!isAbsolute(session.projectPath)) throw new Error(`Peer mail requires an absolute project path for ${session.id}; launch a new session with an absolute --project path`);
}

export function mail(db: StateDB, toId: string | undefined, peers: boolean, content: string): PeerMailRecord[] {
  if (scanSentinels(content).length) throw new Error("Peer mail body must not contain a sentinel line (DONE or NEED_HELP)");
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
        ? db.listJobSessions(sender.jobId!).filter((s) => s.id !== sender.id && s.status === "running" && s.launchPid == null && s.role !== "reviewer" && !isDirectLineage(sender, s))
        : [db.getSession(toId!)];
      if (!recipients.length) throw new Error("No running peers in this job");
      for (const recipient of recipients) {
        if (!recipient) throw new Error(`Session not found: ${toId}`);
        if (recipient.id === sender.id) throw new Error("Cannot send peer mail to self");
        if (recipient.role === "reviewer") throw new Error("A reviewer cannot send or receive peer mail");
        if (recipient.jobId !== sender.jobId) throw new Error("Peer mail is restricted to the same job");
        if (isDirectLineage(sender, recipient)) {
          throw new Error(recipient.parentId === sender.id
            ? "Direct child is not a peer; use send/task for host-to-child communication"
            : "Direct parent is not a peer; use the sentinel/summary protocol for child-to-host communication");
        }
        requireRunning(recipient);
        requireAbsoluteProject(recipient);
      }
      const budget = sender.mailBudget ?? 8;
      const sent = db.peerMailCounts(sender.id).sent;
      if (sent + recipients.length > budget) throw new Error(`Peer mail budget exceeded (${sent} sent, ${recipients.length} requested, limit ${budget})`);
      ledgerPath = join(planFileHandoff(sender.projectPath, sender.id).projectDeliveryDir, "jobs", sender.jobId!, "mail.jsonl");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const ledgerStat = existingStat(ledgerPath);
      ledgerExisted = ledgerStat !== null;
      if (ledgerStat && (ledgerStat.isSymbolicLink() || !ledgerStat.isFile())) throw new Error("Peer mail ledger must be a regular file, not a symlink");
      ledgerSize = ledgerStat?.size ?? 0;
      const messages: PeerMailRecord[] = [];
      const skippedSequences = new Map<string, number[]>();
      for (const recipient of recipients) {
        const to = recipient!;
        let seq = db.nextPeerMailSeq(to.id);
        const inbox = join(planFileHandoff(to.projectPath, to.id).sessionDeliveryDir, "inbox");
        requireInboxDirectory(inbox);
        mkdirSync(inbox, { recursive: true });
        // An interrupted delivery may have left a file without SQLite metadata.
        // Preserve it and reserve a free sequence across all senders' files.
        const occupied = new Set(readdirSync(inbox).flatMap((name) => {
          const match = /^(\d+)-from-.+\.md$/.exec(name);
          return match ? [Number(match[1])] : [];
        }));
        const skipped: number[] = [];
        while (occupied.has(seq)) skipped.push(seq++);
        if (skipped.length) skippedSequences.set(to.id, skipped);
        const path = join(inbox, `${seq}-from-${sender.id}.md`);
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
      appendFileSync(ledgerPath, messages.map(({ ts, from, to, seq, bytes }) => JSON.stringify({
        ts, from, to, seq, bytes,
        ...(skippedSequences.has(to) ? { skippedSeqs: skippedSequences.get(to), note: "Skipped orphaned inbox sequences; existing files preserved" } : {}),
      }) + "\n").join(""));
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
  requireInboxDirectory(dirname(message.path));
  const content = readFileSync(message.path, "utf8");
  db.markPeerMailRead(caller.id, seq);
  return content.split(/\r\n|[\n\r\u2028\u2029]/u).map((line) => `> ${line}`).join("\n");
}
