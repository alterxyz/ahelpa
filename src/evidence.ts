import { $ } from "bun";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { createHash } from "crypto";
import { planSessionHandoff } from "./file-handoff";
import type { HelperRole } from "./drivers/types";

// Objective facts a host can hold against summary.md. Archived sessions
// showed self-reported "all green" refuted by review often enough that the
// claim should never be the only thing wait hands back.
export interface Evidence {
  peerMail?: { sent: number; received: number };
  summaryBytes: number;
  // Entries under artifacts/, when any: a tree copy or cache left there shows
  // up as tens of thousands before anyone commits or backs it up.
  artifactsEntries?: number;
  baseCommit?: string;
  // The launch baseline no longer resolves (rebased or gc'd), so committed
  // helper work could not be listed. An empty changedFiles is not "nothing".
  baseCommitMissing?: boolean;
  changedFiles?: string[];
  testFilesChanged?: string[];
  // Only when the session has a scope (see --scope) and git evidence exists: the
  // changedFiles (and the old path of a rename) that match none of its globs.
  // [] means everything stayed in scope.
  outOfScopeChanges?: OutOfScopeChange[];
  check?: CheckResult;
  targetChanged?: boolean;
  targetFingerprint?: TargetFingerprint;
  currentFingerprint?: TargetFingerprint;
  targetFingerprintIncomplete?: string;
}

// Net line counts per path against the launch baseline; null for a binary,
// unreadable or oversized file, a dirty submodule, or when the diff failed or
// ran out of wait budget. A moved file is two entries, not one rename.
export interface OutOfScopeChange {
  file: string;
  added: number | null;
  removed: number | null;
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
  deliveryRoot?: string | null;
  baseCommit?: string | null;
  checkCmd?: string | null;
  scope?: string | null;
  role?: HelperRole | null;
  targetFingerprint?: TargetFingerprint | null;
  targetResultDirs?: string[] | null;
}

export type CheckRunner = (cwd: string, command: string, logPath: string, timeoutMs: number) => Promise<CheckResult>;

export interface EvidenceOptions {
  peerMail?: { sent: number; received: number };
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

// Evidence only reads the tree, yet Git refreshes the index as a side effect:
// status behind an optional lock, diff through diff.autoRefreshIndex, which
// GIT_OPTIONAL_LOCKS does not cover. Git killed while holding the lock leaves
// .git/index.lock behind, and the user's next commit fails on it. A user's
// diff.relative would make diff print project-relative paths and omit files
// outside the project, unlike status, so it is pinned off for every call.
const READ_ONLY_GIT = ["-c", "diff.autoRefreshIndex=false", "-c", "diff.relative=false"];
const readOnlyGitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0" });

// Keep Git in the launcher's group so group signals also terminate it. At the
// deadline kill Git directly and cancel its output reader. A rare grandchild
// can outlive the deadline until Git's pipes close; do not wait for its EOF.
async function fingerprintGit(cwd: string, args: string[], deadline: number): Promise<{ stdout: Buffer; exitCode: number; timedOut: boolean }> {
  if (Date.now() >= deadline) return { stdout: Buffer.alloc(0), exitCode: -1, timedOut: true };
  const proc = Bun.spawn(["git", "-C", cwd, ...READ_ONLY_GIT, ...args], { env: readOnlyGitEnv(), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let timedOut = false;
  const killGit = () => {
    try { proc.kill("SIGKILL"); } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGit();
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
    killGit();
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
  const { summaryPath, sessionDeliveryDir, artifactsDir } = planSessionHandoff(subject);
  let summaryBytes = 0;
  try { summaryBytes = statSync(summaryPath).size; } catch {}
  const evidence: Evidence = { summaryBytes };
  try {
    const entries = readdirSync(artifactsDir, { recursive: true }).length;
    if (entries > 0) evidence.artifactsEntries = entries;
  } catch {}
  if (options.peerMail && (options.peerMail.sent > 0 || options.peerMail.received > 0)) {
    evidence.peerMail = options.peerMail;
  }

  const status = await $`git -C ${subject.projectPath} ${READ_ONLY_GIT} status --porcelain -z --untracked-files=all`.env(readOnlyGitEnv()).quiet().nothrow();
  if (status.exitCode === 0) {
    const statusText = status.text();
    const files = new Set(parsePorcelainZ(statusText));
    // Helpers rarely commit, but when one does, the launch baseline keeps the
    // committed part of its work visible instead of vanishing from status.
    // Diff commit to commit: status already covers the work tree, and a work
    // tree diff would list stat-only changes once it may not refresh the index.
    if (subject.baseCommit) {
      evidence.baseCommit = subject.baseCommit;
      const committed = await $`git -C ${subject.projectPath} ${READ_ONLY_GIT} diff --name-only -z ${subject.baseCommit} HEAD`.env(readOnlyGitEnv()).quiet().nothrow();
      if (committed.exitCode === 0) {
        for (const file of committed.text().split("\0")) if (file) files.add(file);
      } else {
        evidence.baseCommitMissing = true;
      }
    }
    evidence.changedFiles = [...files];
    evidence.testFilesChanged = evidence.changedFiles.filter((file) => TEST_FILE.test(file));
    // From the same snapshot as changedFiles, before --check can touch the tree.
    if (subject.scope) {
      const baseline = evidence.baseCommit && !evidence.baseCommitMissing ? evidence.baseCommit : "HEAD";
      evidence.outOfScopeChanges = await collectOutOfScope(subject, subject.scope, evidence.changedFiles, statusText, baseline, options.deadline ?? Date.now() + LAUNCH_FINGERPRINT_TIMEOUT_MS);
    }
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

const SCOPE_MAX_LENGTH = 500;
const SCOPE_REFUSALS: Array<[RegExp, string]> = [
  [/^\.?$/, "empty entry"],
  [/^([/~]|[A-Za-z]:)/, "must be relative to the project"],
  [/(^|\/)\.\.(\/|$)/, "'..' segment"],
  // git never prints these, so such an entry would match nothing and say nothing.
  [/\/\/|(^|\/)\.(\/|$)/, "empty or '.' path segment"],
  // C0 and C1 controls plus the Unicode line separators: a line break inside the
  // contract's Rules list could put a sentinel alone on a line.
  [/[\x00-\x1f\x7f-\x9f\u2028\u2029]/, "control character"],
  // The comma separates globs, so there is no alternation; Bun.Glob treats a leading ! as negation.
  [/[\\{}]|^!/, "backslash, brace or leading '!'"],
];

// Validate a --scope value and return its canonical form: trimmed entries
// without a leading ./ or trailing /, comma-joined. Throws with a --scope message.
export function parseScope(raw: string): string {
  if (raw.length > SCOPE_MAX_LENGTH) throw new Error(`--scope is longer than ${SCOPE_MAX_LENGTH} characters`);
  const entries = raw.split(",").map((entry) => entry.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, ""));
  for (const entry of entries) {
    for (const [refused, reason] of SCOPE_REFUSALS) {
      if (refused.test(entry)) throw new Error(`--scope entry ${JSON.stringify(entry)} is invalid: ${reason}`);
    }
  }
  return entries.join(",");
}

// ponytail: Bun.Glob semantics. Only an entry without a wildcard also covers what
// lies beneath it (src/parser == src/parser/**); `src/*` and `*.md` match exactly
// what Bun.Glob says, so they do not recurse. A literal [dir] cannot be written
// (backslash is refused); `?` stands in for the brackets.
function scopeMatcher(scope: string): (path: string) => boolean {
  const globs = scope.split(",").flatMap((entry) => {
    const glob = new Bun.Glob(entry);
    return /[*?[]/.test(entry) ? [glob] : [glob, new Bun.Glob(`${entry}/**`)];
  });
  return (path) => globs.some((glob) => glob.match(path));
}

type LineCounts = Omit<OutOfScopeChange, "file">;
const UNKNOWN_COUNTS: LineCounts = { added: null, removed: null };
// ponytail: untracked files are counted in-process; past this many files, bytes
// per file or bytes in all the counts are null, and .gitattributes binary
// overrides are ignored (NUL in the first 8000 bytes is git's own default test).
const UNTRACKED_READ_CAP = 200;
const UNTRACKED_MAX_BYTES = 1_000_000;
const UNTRACKED_TOTAL_BYTES = 8_000_000;

function countUntracked(path: string, budget: { bytes: number }): LineCounts {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > UNTRACKED_MAX_BYTES || stat.size > budget.bytes) return UNKNOWN_COUNTS;
    budget.bytes -= stat.size;
    const data = readFileSync(path);
    if (data.subarray(0, 8000).includes(0)) return UNKNOWN_COUNTS;
    let lines = data.length > 0 && data[data.length - 1] !== 10 ? 1 : 0;
    for (const byte of data) if (byte === 10) lines++;
    return { added: lines, removed: 0 };
  } catch {
    return UNKNOWN_COUNTS;
  }
}

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

// -z gives `added\tremoved\tpath\0`, with `-` counts for a binary file. The
// caller passes --no-renames, so every record is one path.
function parseNumstatZ(output: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  for (const field of output.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(field);
    if (match) counts.set(match[3], { added: match[1] === "-" ? null : Number(match[1]), removed: match[2] === "-" ? null : Number(match[2]) });
  }
  return counts;
}

// git prints repository-root-relative paths even when the project is a
// subdirectory, so strip the project's prefix before matching; a change outside
// the project is out of scope. Only this session's own .ahelpa/<id> results are
// not helper work: another hand's files there are listed like any other change.
async function collectOutOfScope(subject: EvidenceSubject, scope: string, changedFiles: string[], statusText: string, baseline: string, deadline: number): Promise<OutOfScopeChange[]> {
  // ponytail: rev-parse is constant-time and, like the status call in collectEvidence, not bounded by the deadline.
  const location = await $`git -C ${subject.projectPath} rev-parse --show-prefix --show-toplevel`.quiet().nothrow();
  const [prefix = "", toplevel = subject.projectPath] = location.exitCode === 0 ? location.text().split("\n") : [];

  // One net diff of the work tree (and index) against the baseline: staged,
  // unstaged and committed-since-launch changes counted once. Without rename
  // detection a move is an addition plus a deletion, never a paired 0/0. An unborn
  // HEAD, a lost baseline or the wait deadline fail it, and the counts are then
  // null instead of an empty list.
  const numstat = await fingerprintGit(subject.projectPath, ["diff", "--numstat", "-z", "--no-renames", baseline, "--"], deadline).catch(() => null);
  const counts = numstat && !numstat.timedOut && numstat.exitCode === 0 ? parseNumstatZ(numstat.stdout.toString()) : null;
  // changedFiles names a rename by its new path only; the net diff also names the
  // old one, so moving a file out of an out-of-scope place is not lost.
  const listed = new Set(changedFiles);
  const candidates = [...changedFiles, ...[...(counts?.keys() ?? [])].filter((file) => !listed.has(file))];

  const inScope = scopeMatcher(scope);
  const own = `.ahelpa/${subject.id}`;
  const outside = candidates.filter((file) => {
    if (!file.startsWith(prefix)) return true;
    const relative = file.slice(prefix.length);
    return !inScope(relative) && relative !== own && !relative.startsWith(`${own}/`);
  });

  const untracked = new Set(statusText.split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3)));
  const budget = { bytes: UNTRACKED_TOTAL_BYTES };
  let reads = 0;
  return outside.map((file) => {
    const known = counts?.get(file);
    if (known && (known.added !== 0 || known.removed !== 0)) return { file, ...known };
    if (untracked.has(file)) return { file, ...(reads++ < UNTRACKED_READ_CAP && Date.now() < deadline ? countUntracked(join(toplevel, file), budget) : UNKNOWN_COUNTS) };
    // A changed tracked file with no lines in a successful diff is net zero
    // (committed, then reverted), unless it is a directory: a submodule with
    // uncommitted changes is listed by status but has no line counts.
    return { file, ...(counts && !isDirectory(join(toplevel, file)) ? { added: 0, removed: 0 } : UNKNOWN_COUNTS) };
  });
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
