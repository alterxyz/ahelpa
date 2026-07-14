// Archive-then-close for sessions that already finished. `clean` drops dead
// rows but throws away what the helper actually did, and `kill` only stops a
// live helper — neither gives a finished helper a receipt, so hosts grow a pile
// of settled sessions they never dare close. harvest captures the pane (or the
// archived tail, once the pane is gone), copies the summary the helper wrote,
// and only then walks the same reap path the daemon uses.
//
// Like `clean`, this is local housekeeping over terminal state, so it takes no
// owner token. Anything still alive is refused and pointed at `kill`.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB, type SessionRecord } from "../state";
import { Tmux } from "../tmux";
import { Archive } from "../archive";
import { SESSION_STATUS, type SessionStatus } from "../session-lifecycle";
import { defaultRuntimeLayout, RuntimeLayout } from "../runtime-layout";
import { planFileHandoff } from "../file-handoff";
import { requireSession } from "../session-access";
import { reapSession } from "../reap";

// Deeper than the daemon's 30-line status peek: the transcript is the last
// readable trace of the run, so take the whole scrollback we can still reach.
const CAPTURE_LINES = 300;

const HARVESTABLE: SessionStatus[] = [
  SESSION_STATUS.NeedsAttention,
  SESSION_STATUS.Dead,
  SESSION_STATUS.Error,
];

export function isHarvestable(status: SessionStatus): boolean {
  return HARVESTABLE.includes(status);
}

export interface HarvestedSession {
  id: string;
  status: SessionStatus;
  label?: string | null;
  transcriptPath: string;
  summaryPath?: string;
  source: "pane" | "archive" | "none";
}

export interface HarvestResult {
  dir: string;
  harvested: HarvestedSession[];
}

export interface HarvestOptions {
  sessionId?: string;
  idle?: boolean;
  dir?: string;
  layout?: RuntimeLayout;
  archive?: Archive;
  at?: Date;
}

function fileStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Labels are free text from the host; keep them readable but path-safe.
function slugLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

async function readTranscript(
  session: SessionRecord,
  archive: Archive,
): Promise<{ body: string; source: HarvestedSession["source"] }> {
  if (await Tmux.hasSession(session.id)) {
    try {
      return { body: await Tmux.capture(session.id, CAPTURE_LINES), source: "pane" };
    } catch {
      // Pane went away between the check and the capture — fall through.
    }
  }
  const archived = archive.get(session.id);
  if (archived?.lastOutput) return { body: archived.lastOutput, source: "archive" };
  if (archived?.reason) return { body: `(no output archived: ${archived.reason})`, source: "archive" };
  return { body: "(no output available: pane gone, nothing archived)", source: "none" };
}

function renderTranscript(session: SessionRecord, body: string, at: Date): string {
  return [
    `# ahelpa harvest`,
    `session: ${session.id}`,
    `agent: ${session.agentType}`,
    `status: ${session.status}`,
    `label: ${session.label ?? "-"}`,
    `project: ${session.projectPath}`,
    `created: ${session.createdAt}`,
    `settled: ${session.updatedAt}`,
    `harvested: ${at.toISOString()}`,
    ``,
    `## task`,
    session.task,
    ``,
    `## transcript`,
    body,
    ``,
  ].join("\n");
}

async function harvestOne(
  db: StateDB,
  session: SessionRecord,
  dir: string,
  layout: RuntimeLayout,
  archive: Archive,
  at: Date,
): Promise<HarvestedSession> {
  const { body, source } = await readTranscript(session, archive);

  const stamp = fileStamp(at);
  const label = session.label ? slugLabel(session.label) : "";
  const base = label ? `${stamp}-${session.id}-${label}` : `${stamp}-${session.id}`;
  const transcriptPath = join(dir, `${base}.txt`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(transcriptPath, renderTranscript(session, body, at));

  let summaryPath: string | undefined;
  const written = planFileHandoff(session.projectPath, session.id, layout).summaryPath;
  if (existsSync(written)) {
    summaryPath = join(dir, `${base}-summary.md`);
    copyFileSync(written, summaryPath);
  }

  // Archive first, close second: a failed capture must not cost the row.
  try { await Tmux.kill(session.id); } catch {}
  reapSession(db, session.id, layout);

  return { id: session.id, status: session.status, label: session.label, transcriptPath, summaryPath, source };
}

export async function harvest(db: StateDB, options: HarvestOptions = {}): Promise<HarvestResult> {
  const layout = options.layout ?? defaultRuntimeLayout;
  const archive = options.archive ?? new Archive(layout.archiveDir());
  const at = options.at ?? new Date();
  const dir = options.dir ?? layout.harvestDir(at);

  let targets: SessionRecord[];
  if (options.sessionId) {
    const session = requireSession(db, options.sessionId);
    if (!isHarvestable(session.status)) {
      throw new Error(
        `Session ${session.id} is ${session.status}; harvest only closes finished sessions `
        + `(${HARVESTABLE.join(", ")}). Stop it first: ahelpa kill ${session.id} --token <token>`,
      );
    }
    targets = [session];
  } else {
    targets = db.listSessions().filter((session) => isHarvestable(session.status));
  }

  const harvested: HarvestedSession[] = [];
  for (const session of targets) {
    harvested.push(await harvestOne(db, session, dir, layout, archive, at));
  }
  return { dir, harvested };
}

export function renderHarvestResult(result: HarvestResult, idle: boolean): string {
  const lines = result.harvested.map((session) => {
    const parts = [`${session.id} ${session.status} archived → ${session.transcriptPath}`];
    if (session.summaryPath) parts.push(`summary → ${session.summaryPath}`);
    if (session.source !== "pane") parts.push(`(transcript from ${session.source === "archive" ? "archive" : "nothing"})`);
    parts.push("closed");
    return parts.join(" | ");
  });

  if (idle) {
    lines.push(
      result.harvested.length === 0
        ? "no finished sessions to harvest"
        : `harvested ${result.harvested.length} session(s) into ${result.dir}`,
    );
  }
  return lines.join("\n");
}
