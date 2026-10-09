import { $ } from "bun";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { createHash } from "crypto";
import { planFileHandoff } from "./file-handoff";
import type { HelperRole } from "./drivers/types";

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
  targetChanged?: boolean;
  targetFingerprint?: TargetFingerprint;
  currentFingerprint?: TargetFingerprint;
  targetFingerprintIncomplete?: string;
}

export type TargetFingerprint =
  | { head: string; treeHash: string; incomplete?: undefined }
  | { head?: undefined; treeHash?: undefined; incomplete: string };

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
  role?: HelperRole | null;
  targetFingerprint?: TargetFingerprint | null;
  targetResultDirs?: string[] | null;
}

export type CheckRunner = (cwd: string, command: string, logPath: string, timeoutMs: number) => Promise<CheckResult>;

export interface EvidenceOptions {
  // Upper bound for the acceptance command. Shared with the caller's own
  // deadline so wait stays bounded; 0 or less skips the check.
  checkTimeoutMs?: number;
  // Absolute caller deadline, shared by checks and the final fingerprint.
  deadline?: number;
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

export const LAUNCH_FINGERPRINT_TIMEOUT_MS = 10_000;
const FINGERPRINT_NODE_CAP = 128;

interface FingerprintOptions {
  deadline?: number;
  maxRepositories?: number;
}

// Git shims/hooks can hang or leave descendants holding pipes. Kill the process
// group and cancel readers at the absolute deadline, including output reads.
async function fingerprintGit(cwd: string, args: string[], deadline: number): Promise<{ stdout: Buffer; exitCode: number; timedOut: boolean }> {
  if (Date.now() >= deadline) return { stdout: Buffer.alloc(0), exitCode: -1, timedOut: true };
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { env: process.env, stdout: "pipe", stderr: "ignore", stdin: "ignore", detached: true });
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let timedOut = false;
  const killTree = () => {
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
    void reader.cancel().catch(() => {});
  }, Math.max(0, deadline - Date.now()));
  try {
    const read = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();
    const [exitCode] = await Promise.all([proc.exited, read]);
    return { stdout: Buffer.concat(chunks), exitCode, timedOut: timedOut || Date.now() >= deadline };
  } finally {
    clearTimeout(timer);
    killTree();
    await reader.cancel().catch(() => {});
  }
}

// Hash raw NUL-separated status and tracked patches, including staged content.
// Only this review's delivery directories are excluded: ignoring all .ahelpa
// would hide another hand's edits. All submodules share one deadline and cap.
export async function computeTargetFingerprint(projectPath: string, resultDirs: string[] = [], options: FingerprintOptions = {}): Promise<TargetFingerprint | null> {
  const deadline = options.deadline ?? Date.now() + LAUNCH_FINGERPRINT_TIMEOUT_MS;
  const visited = new Set<string>();
  const maxRepositories = options.maxRepositories ?? FINGERPRINT_NODE_CAP;
  const incomplete = (reason: string): TargetFingerprint => ({ incomplete: reason });
  const snapshot = async (project: string, dirs: string[], top: boolean): Promise<TargetFingerprint | null> => {
    if (Date.now() >= deadline) return incomplete("fingerprint deadline exhausted");
    if (visited.size >= maxRepositories) return incomplete("fingerprint repository node cap reached");
    try {
      const root = await fingerprintGit(project, ["rev-parse", "--show-toplevel"], deadline);
      if (root.timedOut) return incomplete("fingerprint deadline exhausted");
      if (root.exitCode !== 0) return top ? null : incomplete("submodule repository lookup failed");
      // Remove exactly Git's record terminator, preserving real path characters.
      const repoPath = realpathSync(root.stdout.toString().replace(/\n$/, ""));
      const physicalProject = realpathSync(project);
      const projectRelative = relative(repoPath, physicalProject);
      if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`) || resolve(repoPath, projectRelative) !== physicalProject) {
        return null;
      }
      if (visited.has(repoPath)) return incomplete("fingerprint repository already visited");
      visited.add(repoPath);
      // Delivery directories may not exist yet; resolve them from the physical
      // project rather than realpath'ing the future directories themselves.
      const physicalResultDirs: string[] = [];
      const paths = ["."];
      for (const dir of dirs) {
        const physicalDir = resolve(physicalProject, relative(resolve(project), resolve(dir)));
        physicalResultDirs.push(physicalDir);
        const path = relative(repoPath, physicalDir);
        if (path && path !== ".." && !path.startsWith(`..${sep}`)) paths.push(`:(top,exclude,literal)${path}`);
      }
      const results = await Promise.all([
        ["rev-parse", "HEAD"],
        ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...paths],
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--", ...paths],
        ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--", ...paths],
        ["ls-files", "--stage", "-z", "--", ...paths],
      ].map((args) => fingerprintGit(repoPath, args, deadline)));
      if (results.some((result) => result.timedOut)) return incomplete("fingerprint deadline exhausted");
      if (results.some((result) => result.exitCode !== 0)) return incomplete("fingerprint git command failed");
      const [head, status, unstaged, staged, index] = results;
      const hash = createHash("sha256").update(status.stdout).update(unstaged.stdout).update(staged.stdout);
      // A dirty gitlink's patch only says "-dirty"; hash the module itself so a
      // second tracked edit is visible. Untracked content remains names-only.
      const submodules = new Set(index.stdout.toString().split("\0")
        .filter((entry) => entry.startsWith("160000 "))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)));
      for (const path of submodules) {
        const submodule = join(repoPath, path);
        if (!existsSync(join(submodule, ".git"))) continue;
        const fingerprint = await snapshot(submodule, physicalResultDirs, false);
        if (!fingerprint || fingerprint.incomplete) return fingerprint ?? incomplete("submodule fingerprint unavailable");
        hash.update(JSON.stringify({ submodule: path, ...fingerprint }));
      }
      if (Date.now() >= deadline) return incomplete("fingerprint deadline exhausted");
      return { head: head.stdout.toString().trim(), treeHash: hash.digest("hex") };
    } catch {
      return incomplete("fingerprint repository or git command unavailable");
    }
  };
  return snapshot(projectPath, resultDirs, true);
}

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
    const timeoutMs = Math.min(CHECK_TIMEOUT_MS, options.checkTimeoutMs ?? CHECK_TIMEOUT_MS, options.deadline === undefined ? Infinity : options.deadline - Date.now());
    evidence.check = timeoutMs > 0
      ? await (options.runCheck ?? runCheck)(subject.projectPath, subject.checkCmd, logPath, timeoutMs)
      : { command: subject.checkCmd, exitCode: null, timedOut: false, output: "", logPath, skipped: "wait budget exhausted before the check could run; re-wait to run it" };
  }
  // Take the final snapshot after --check, which can itself touch the tree.
  if (subject.role === "reviewer" && subject.targetFingerprint) {
    const current = subject.targetFingerprint.incomplete
      ? subject.targetFingerprint
      : await computeTargetFingerprint(subject.projectPath, subject.targetResultDirs ?? [sessionDeliveryDir], { deadline: options.deadline });
    if (!current || current.incomplete) {
      evidence.targetFingerprintIncomplete = current?.incomplete ?? "target repository unavailable";
    } else {
      evidence.targetFingerprint = subject.targetFingerprint;
      evidence.currentFingerprint = current;
      evidence.targetChanged = current.head !== subject.targetFingerprint.head || current.treeHash !== subject.targetFingerprint.treeHash;
    }
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
