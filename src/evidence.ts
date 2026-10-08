import { $ } from "bun";
import { mkdirSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { planFileHandoff } from "./file-handoff";

// Objective facts a host can hold against summary.md. Archived sessions
// showed self-reported "all green" refuted by review often enough that the
// claim should never be the only thing wait hands back.
export interface Evidence {
  summaryBytes: number;
  baseCommit?: string;
  // The launch baseline no longer resolves (rebased or gc'd), so committed
  // helper work could not be listed. An empty changedFiles is not "nothing".
  baseCommitMissing?: boolean;
  changedFiles?: string[];
  testFilesChanged?: string[];
  check?: CheckResult;
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  logPath: string;
  // The wait budget was exhausted before the check could run; re-wait runs it.
  skipped?: string;
}

export interface EvidenceSubject {
  id: string;
  projectPath: string;
  baseCommit?: string | null;
  checkCmd?: string | null;
}

export type CheckRunner = (cwd: string, command: string, logPath: string, timeoutMs: number) => Promise<CheckResult>;

export interface EvidenceOptions {
  // Upper bound for the acceptance command. Shared with the caller's own
  // deadline so wait stays bounded; 0 or less skips the check.
  checkTimeoutMs?: number;
  // Lets a caller waiting on several sessions run one check per
  // (project, command) instead of racing identical commands on one tree.
  runCheck?: CheckRunner;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._](test|spec)\.[a-z]+$|_test\.go$/;
export const CHECK_TIMEOUT_MS = 600_000;
const CHECK_OUTPUT_TAIL = 4000;
// After the process group is dead, how long to keep reading pipes that an
// escaped grandchild may still hold open.
const READ_GRACE_MS = 2000;

export async function collectEvidence(subject: EvidenceSubject, options: EvidenceOptions = {}): Promise<Evidence> {
  const { summaryPath, sessionDeliveryDir } = planFileHandoff(subject.projectPath, subject.id);
  let summaryBytes = 0;
  try { summaryBytes = statSync(summaryPath).size; } catch {}
  const evidence: Evidence = { summaryBytes };

  const status = await $`git -C ${subject.projectPath} status --porcelain -z --untracked-files=all`.quiet().nothrow();
  if (status.exitCode === 0) {
    const files = new Set(parsePorcelainZ(status.text()));
    // Helpers rarely commit, but when one does, the launch baseline keeps the
    // committed part of its work visible instead of vanishing from status.
    if (subject.baseCommit) {
      evidence.baseCommit = subject.baseCommit;
      const committed = await $`git -C ${subject.projectPath} diff --name-only -z ${subject.baseCommit}`.quiet().nothrow();
      if (committed.exitCode === 0) {
        for (const file of committed.text().split("\0")) if (file) files.add(file);
      } else {
        evidence.baseCommitMissing = true;
      }
    }
    evidence.changedFiles = [...files];
    evidence.testFilesChanged = evidence.changedFiles.filter((file) => TEST_FILE.test(file));
  }

  if (subject.checkCmd) {
    const logPath = `${sessionDeliveryDir}/check.log`;
    const timeoutMs = Math.min(CHECK_TIMEOUT_MS, options.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
    evidence.check = timeoutMs > 0
      ? await (options.runCheck ?? runCheck)(subject.projectPath, subject.checkCmd, logPath, timeoutMs)
      : { command: subject.checkCmd, exitCode: null, timedOut: false, output: "", logPath, skipped: "wait budget exhausted before the check could run; re-wait to run it" };
  }
  return evidence;
}

// -z gives NUL-separated, unquoted paths; a rename/copy entry is followed by
// its source path as an extra NUL-terminated field, which we drop.
export function parsePorcelainZ(output: string): string[] {
  const fields = output.split("\0");
  const files: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

function drain(stream: ReadableStream<Uint8Array>, sink: string[]): { done: Promise<void>; cancel: () => Promise<void> } {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sink.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // A cancelled reader ends the loop; partial output is still returned.
    }
  })();
  // The stream is locked to this reader, so only the reader can cancel it.
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

// The acceptance command is the host's, not the helper's: it runs on whatever
// state the helper left, with the helper's own report nowhere in the loop.
// The command runs in its own process group so a timeout kills the whole tree,
// and pipe reads are bounded so an escaped grandchild cannot hold wait hostage.
export async function runCheck(cwd: string, command: string, logPath: string, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  let exitCode: number | null = null;
  let timedOut = false;
  const chunks: string[] = [];
  try {
    const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
    const killTree = () => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const readers = [drain(proc.stdout, chunks), drain(proc.stderr, chunks)];
    exitCode = await proc.exited;
    clearTimeout(timer);
    await Promise.race([Promise.all(readers.map((r) => r.done)), Bun.sleep(READ_GRACE_MS)]);
    await Promise.all(readers.map((r) => r.cancel()));
    // ponytail: stragglers die with their check; nothing a --check starts outlives wait, nohup included
    if (!timedOut) killTree();
  } catch (error) {
    chunks.push(error instanceof Error ? error.message : String(error));
  }
  const output = chunks.join("");
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `$ ${command}\n${output}\n[exit ${exitCode ?? "killed"}${timedOut ? ", timed out" : ""}]\n`);
  } catch {}
  return { command, exitCode, timedOut, output: output.slice(-CHECK_OUTPUT_TAIL), logPath };
}
