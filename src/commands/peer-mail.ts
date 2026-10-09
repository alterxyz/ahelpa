import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, truncateSync, unlinkSync, writeFileSync, type Stats } from "fs";
import { dirname, isAbsolute, join, relative, sep } from "path";
import { resolveJobId } from "./launch";
import { planFileHandoff } from "../file-handoff";
import { scanSentinels } from "../drivers/sentinels";
import { StateDB, type PeerMailRecord, type SessionRecord } from "../state";

export const MAX_MAIL_FILE_BYTES = 1024 * 1024;

export function readMailFile(path: string): string {
  // Validate and read the same descriptor; a swapped path or FIFO cannot
  // bypass validation or block the open. Growth is bounded to MAX+1 bytes.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Peer mail --file must be a regular file");
    if (stat.size > MAX_MAIL_FILE_BYTES) throw new Error("Peer mail --file exceeds the 1 MiB limit");
    const bytes = Buffer.alloc(MAX_MAIL_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_MAIL_FILE_BYTES) throw new Error("Peer mail --file exceeds the 1 MiB limit");
    try {
      // Preserve a UTF-8 BOM and reject malformed bytes instead of replacing them.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
    } catch {
      throw new Error("Peer mail --file must contain valid UTF-8");
    }
  } finally {
    closeSync(fd);
  }
}

function existingStat(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requireDirectoryChain(project: string, path: string, label: string): void {
  const base = join(project, ".ahelpa");
  const suffix = relative(base, path);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new Error(`Peer mail ${label} is outside the project .ahelpa directory`);
  }
  let component = base;
  for (const part of ["", ...suffix.split(sep).filter(Boolean)]) {
    component = join(component, part);
    const stat = existingStat(component);
    if (stat?.isSymbolicLink()) throw new Error(`Peer mail ${label} path must not contain a symlink: ${component}`);
    if (stat && !stat.isDirectory()) throw new Error(`Peer mail ${label} path is not a directory: ${component}`);
  }
}

function lineageRelations(db: StateDB, sender: SessionRecord) {
  const sessions = db.listSessions();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const links = new Map<string, string[]>();
  for (const s of sessions) {
    if (!s.resumedFrom) continue;
    links.set(s.id, [...(links.get(s.id) ?? []), s.resumedFrom]);
    links.set(s.resumedFrom, [...(links.get(s.resumedFrom) ?? []), s.id]);
  }
  function aliases(id: string): Set<string> {
    const seen = new Set([id]);
    const pending = [id];
    // Each stored node is visited at most once, including cycles and branches.
    for (let index = 0; index < pending.length; index++) {
      for (const linked of links.get(pending[index]) ?? []) {
        if (!seen.has(linked)) { seen.add(linked); pending.push(linked); }
      }
    }
    return seen;
  }
  const from = aliases(sender.id);
  return (recipient: SessionRecord): "same" | "child" | "parent" | null => {
    const to = aliases(recipient.id);
    if (to.has(sender.id)) return "same";
    if ([...to].some((id) => from.has(byId.get(id)?.parentId ?? ""))) return "child";
    if ([...from].some((id) => to.has(byId.get(id)?.parentId ?? ""))) return "parent";
    return null;
  };
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
  const lines = content.split(/\r\n|[\n\r\u2028\u2029]/u);
  for (let index = 0; index < lines.length; index++) {
    // Keep the daemon's matcher unchanged, but never let its whitespace
    // matching backtrack across the entire mail body's newline runs.
    if (scanSentinels(lines[index]).length) {
      throw new Error(`Peer mail body must not contain a sentinel line (DONE or NEED_HELP): line ${index + 1}; reword it as an ordinary inline mention`);
    }
  }
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
      const lineage = lineageRelations(db, sender);
      const recipients = peers
        ? db.listJobSessions(sender.jobId!).filter((s) => s.id !== sender.id && s.status === "running" && s.launchPid == null && s.role !== "reviewer" && !lineage(s))
        : [db.getSession(toId!)];
      if (!recipients.length) throw new Error("No eligible running peers in this job; members still launching and direct lineage (including resumes) are excluded. If a member is launching, retry after launch completes");
      for (const recipient of recipients) {
        if (!recipient) throw new Error(`Session not found: ${toId}`);
        if (recipient.id === sender.id) throw new Error("Cannot send peer mail to self");
        if (recipient.role === "reviewer") throw new Error("A reviewer cannot send or receive peer mail");
        if (recipient.jobId !== sender.jobId) throw new Error("Peer mail is restricted to the same job");
        const relation = lineage(recipient);
        if (relation) {
          if (relation === "same") throw new Error("Cannot send peer mail to the same lineage session through a resume link");
          throw new Error(relation === "child"
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
      requireDirectoryChain(sender.projectPath, dirname(ledgerPath), "ledger");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      requireDirectoryChain(sender.projectPath, dirname(ledgerPath), "ledger");
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
        requireDirectoryChain(to.projectPath, inbox, "inbox");
        mkdirSync(inbox, { recursive: true });
        requireDirectoryChain(to.projectPath, inbox, "inbox");
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
  requireDirectoryChain(caller.projectPath, dirname(message.path), "inbox");
  const stat = existingStat(message.path);
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error("Peer mail message must be a regular file, not a symlink");
  const content = readFileSync(message.path, "utf8");
  db.markPeerMailRead(caller.id, seq);
  const lines = content.replaceAll("[" + "AHELPA" + ":", "[AHELPA_:").split(/\r\n|[\n\r\u2028\u2029]/u);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.map((line) => `> ${line}`).join("\n");
}
